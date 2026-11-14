// Voice chat: one voice connection in the bot's server. Text -> (voices service) wav -> ffmpeg Opus/Ogg ->
// @discordjs/voice. One sentence at a time from a short queue; random Markov sentences on a jittered timer.
//
// Events for other modules (ctx.emit):
//   'voice:spoken' { text, voiceId, voiceName, source: random|speak|say|greeting|replay, user: {id,name}|null,
//                    wav, holds: [] }   push a promise to `holds` to keep `wav` until you are done with it
//   'voice:joined' { channel: {id,name} }
//   'voice:left'   { channel: {id,name}, durationMs, lines }
// Service 'voicechat': { connected(), say(text, { voice, source, user }), voiceName(id) }
import { Events, SlashCommandBuilder, MessageFlags, ChannelType } from 'discord.js';
import {
  joinVoiceChannel, getVoiceConnection, createAudioPlayer, createAudioResource, entersState,
  AudioPlayerStatus, VoiceConnectionStatus, StreamType, NoSubscriberBehavior,
} from '@discordjs/voice';
import { spawn } from 'node:child_process';
import { unlink } from 'node:fs/promises';
import { wavToMp3, clipFileName } from '../../core/audio.mjs';

const S = {
  player: null, queue: [], busy: false, talkTimer: null, leaveTimer: null, nextTalkAt: null, last: null,
  joinedAt: null, channel: null, sessionLines: 0, recent: [],
};
const RECENT = 20;
const SOURCE_LABEL = { random: 'random line', speak: '/speak', say: '/say', greeting: 'greeting', replay: 'replay', dashboard: 'dashboard' };
const httpError = (code, msg) => Object.assign(new Error(msg), { code });

const humansIn = (channel) => channel ? channel.members.filter((m) => !m.user.bot).size : 0;
const connection = (ctx) => { const g = ctx.guild(); return g ? getVoiceConnection(g.id) : undefined; };
function currentChannel(ctx) {
  const c = connection(ctx);
  return c ? ctx.guild()?.channels.cache.get(c.joinConfig.channelId) ?? null : null;
}

// Strip what reads badly aloud. Emoji and URLs are dropped; Markov already removed mentions.
export function speakable(text, max = 600) {
  return String(text).replace(/https?:\/\/\S+/g, ' ').replace(/<a?:(\w+):\d+>/g, ' ').replace(/<[@#][!&]?\d+>/g, ' ')
    .replace(/\p{Extended_Pictographic}/gu, ' ').replace(/[*_~`|>#]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

// ---- voices ---------------------------------------------------------------------------------------------
const voicesApi = (ctx) => ctx.use('voices');
const usableVoices = (ctx) => (voicesApi(ctx)?.list() ?? []).filter((v) => v.hasConfig && !v.invalid);
function voiceName(ctx, id) { return voicesApi(ctx)?.resolve(id || ctx.settings.voice)?.name ?? 'OzBot'; }
function randomVoiceId(ctx) {
  const list = usableVoices(ctx);
  return list.length ? list[Math.floor(Math.random() * list.length)].id : undefined;
}
function updateStatus(ctx) { ctx.setStatus(connection(ctx) ? `Speaking as ${voiceName(ctx)}` : null); }

// ---- connection -----------------------------------------------------------------------------------------
async function join(ctx, channel) {
  if (!channel || ![ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(channel.type)) throw httpError(400, 'Not a voice channel');
  const me = channel.guild.members.me;
  if (!channel.permissionsFor(me)?.has(['Connect', 'Speak'])) throw httpError(403, `I am not allowed to connect/speak in #${channel.name}`);
  const existing = connection(ctx);
  if (existing?.joinConfig.channelId === channel.id && existing.state.status !== VoiceConnectionStatus.Destroyed) return existing;
  if (existing) { existing.destroy(); onLeft(ctx); }
  const conn = joinVoiceChannel({ channelId: channel.id, guildId: channel.guild.id, adapterCreator: channel.guild.voiceAdapterCreator, selfDeaf: true });
  conn.on(VoiceConnectionStatus.Disconnected, async () => {
    try { // moved / brief network blip: give it a moment to reconnect by itself
      await Promise.race([entersState(conn, VoiceConnectionStatus.Signalling, 5000), entersState(conn, VoiceConnectionStatus.Connecting, 5000)]);
    } catch { conn.destroy(); onLeft(ctx); }
  });
  conn.on('error', (e) => ctx.log('voice connection error:', e.message));
  try { await entersState(conn, VoiceConnectionStatus.Ready, 20000); }
  catch (e) { conn.destroy(); throw httpError(504, `Could not connect to #${channel.name}: ${e.message}`); }
  conn.subscribe(S.player);
  S.joinedAt = Date.now(); S.channel = { id: channel.id, name: channel.name }; S.sessionLines = 0;
  ctx.log(`joined #${channel.name}`);
  ctx.emit('voice:joined', { channel: S.channel });
  updateStatus(ctx);
  if (ctx.settings.greet && ctx.settings.greeting) say(ctx, ctx.settings.greeting, { source: 'greeting' });
  scheduleTalk(ctx);
  return conn;
}

function onLeft(ctx) {
  if (S.joinedAt && S.channel) ctx.emit('voice:left', { channel: S.channel, durationMs: Date.now() - S.joinedAt, lines: S.sessionLines });
  clearTimeout(S.talkTimer); clearTimeout(S.leaveTimer);
  S.talkTimer = S.leaveTimer = S.nextTalkAt = S.joinedAt = S.channel = null;
  S.queue.length = 0;
  S.player?.stop(true);
  if (ctx.running) updateStatus(ctx);
}

function leave(ctx) {
  const c = connection(ctx);
  if (!c) return false;
  c.destroy();
  onLeft(ctx);
  ctx.log('left voice');
  return true;
}

// ---- talking --------------------------------------------------------------------------------------------
function scheduleTalk(ctx) {
  clearTimeout(S.talkTimer);
  S.nextTalkAt = null;
  const s = ctx.settings;
  if (!s.randomTalk || !connection(ctx)) return;
  const lo = Math.min(s.intervalMin, s.intervalMax), hi = Math.max(s.intervalMin, s.intervalMax);
  const ms = (lo + Math.random() * (hi - lo)) * 60e3;
  S.nextTalkAt = Date.now() + ms;
  S.talkTimer = setTimeout(() => {
    if (!ctx.running) return;
    try {
      if (humansIn(currentChannel(ctx)) > 0) {
        speakRandom(ctx, '', { voice: ctx.settings.voiceMode === 'random' ? randomVoiceId(ctx) : undefined, source: 'random' });
      }
    } catch (e) { if (e.code !== 409) ctx.fail(e); }
    scheduleTalk(ctx);
  }, ms);
}

function markovLine(ctx, about = '') {
  const sentences = ctx.use('sentences');
  if (!sentences) throw httpError(409, 'Markov chat is off, so there is nothing to say');
  const text = sentences.random({ about }) ?? (about ? sentences.random() : null);
  if (!text) throw httpError(409, 'Markov chat has not learned enough yet');
  return text;
}

function speakRandom(ctx, about, opts) { return say(ctx, markovLine(ctx, about), opts); }

// opts: { voice (profile id, '' = current), source, user: {id,name} }
function say(ctx, text, { voice, source = 'say', user = null } = {}) {
  if (!connection(ctx)) throw httpError(409, 'I am not in a voice channel');
  const clean = speakable(text);
  if (!clean) throw httpError(400, 'Nothing speakable in that');
  if (S.queue.length >= ctx.settings.maxQueue) throw httpError(429, 'Queue is full, try again in a moment');
  S.queue.push({ text: clean, voice: voice || ctx.settings.voice, source, user });
  pump(ctx);
  return clean;
}

function remember(item) {
  S.recent.unshift(item);
  S.recent.length = Math.min(S.recent.length, RECENT);
}

async function pump(ctx) {
  if (S.busy) return;
  S.busy = true;
  try {
    while (S.queue.length && ctx.running && connection(ctx)) {
      const item = S.queue.shift();
      let wav, payload;
      try {
        const out = await voicesApi(ctx).speak(item.text, item.voice);
        wav = out.path;
        payload = { text: item.text, voiceId: out.voice, voiceName: out.name, source: item.source, user: item.user, wav, holds: [] };
        ctx.emit('voice:spoken', payload); // Voice log etc. start their work while it plays
        await play(wav);
        S.sessionLines++;
        S.last = { text: item.text, voice: out.name, at: Date.now(), synthMs: out.ms };
        remember({ text: item.text, voiceId: out.voice, voiceName: out.name, source: item.source, user: item.user?.name ?? null, at: Date.now() });
      } catch (e) { ctx.log('speak failed:', e.message); ctx.fail(e); }
      finally {
        if (payload) await Promise.allSettled(payload.holds);
        if (wav) unlink(wav).catch(() => {});
      }
    }
  } finally { S.busy = false; }
}

function play(wav) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', wav, '-ac', '2', '-ar', '48000',
      '-c:a', 'libopus', '-b:a', '64k', '-f', 'ogg', 'pipe:1'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    ff.stderr.on('data', (d) => { err += d; });
    ff.on('error', reject);
    const resource = createAudioResource(ff.stdout, { inputType: StreamType.OggOpus });
    const done = () => { cleanup(); resolve(); };
    const fail = (e) => { cleanup(); reject(new Error(e.message + (err ? ` (${err.trim()})` : ''))); };
    const cleanup = () => { S.player.off(AudioPlayerStatus.Idle, done); S.player.off('error', fail); ff.kill(); };
    S.player.once(AudioPlayerStatus.Idle, done);
    S.player.once('error', fail);
    S.player.play(resource);
  });
}

// Not in voice: make the clip and post it as a reply instead (like a voice message).
async function replyWithClip(ctx, i, text, voice, source) {
  const clean = speakable(text, ctx.settings.maxSayChars);
  if (!clean) return i.reply(ephemeral('Nothing speakable in that.'));
  await i.deferReply();
  let out, mp3;
  try {
    out = await voicesApi(ctx).speak(clean, voice || ctx.settings.voice);
    mp3 = out.path.replace(/\.wav$/, '.mp3');
    await wavToMp3(out.path, mp3);
    const user = { id: i.user.id, name: i.member?.displayName ?? i.user.username };
    const item = { text: clean, voiceId: out.voice, voiceName: out.name, source, user };
    const content = ctx.use('voicelog')?.format(item) ?? `"${clean}" - ${out.name}`;
    await i.editReply({ content, files: [{ attachment: mp3, name: clipFileName(out.name) }], allowedMentions: { parse: [] } });
    remember({ ...item, user: user.name, at: Date.now(), source: `${source} (text)` });
  } catch (e) {
    ctx.log('clip reply failed:', e.message);
    await i.editReply({ content: `Could not make that clip: ${e.message}` }).catch(() => {});
  } finally {
    if (out) unlink(out.path).catch(() => {});
    if (mp3) unlink(mp3).catch(() => {});
  }
}

// ---- voice state ----------------------------------------------------------------------------------------
function onVoiceState(ctx, oldState, newState) {
  const s = ctx.settings;
  const guild = ctx.guild();
  if (!guild || newState.guild.id !== guild.id) return;
  if (newState.id === ctx.client.user.id) { if (!newState.channelId && connection(ctx)) { connection(ctx).destroy(); onLeft(ctx); } return; }
  const here = currentChannel(ctx);
  if (here) {
    const n = humansIn(here);
    if (n === 0 && s.leaveWhenAlone && !S.leaveTimer) {
      S.leaveTimer = setTimeout(() => { S.leaveTimer = null; if (ctx.running && humansIn(currentChannel(ctx)) === 0) leave(ctx); }, s.leaveDelay * 1000);
    } else if (n > 0 && S.leaveTimer) { clearTimeout(S.leaveTimer); S.leaveTimer = null; }
    return;
  }
  if (s.autoJoin && s.homeChannel && newState.channelId === s.homeChannel && !newState.member?.user.bot) {
    join(ctx, guild.channels.cache.get(s.homeChannel)).catch((e) => ctx.log('auto-join failed:', e.message));
  }
}

// Bot (re)started while people are already in the home channel.
function checkHome(ctx) {
  const s = ctx.settings;
  const home = s.homeChannel && ctx.guild()?.channels.cache.get(s.homeChannel);
  if (s.autoJoin && home && !connection(ctx) && humansIn(home) > 0) join(ctx, home).catch((e) => ctx.log('auto-join failed:', e.message));
}

// ---- commands -------------------------------------------------------------------------------------------
const ephemeral = (content) => ({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
const voiceOption = (o) => o.setName('voice').setDescription('Which voice (current voice if empty)').setAutocomplete(true);
const userOf = (i) => ({ id: i.user.id, name: i.member?.displayName ?? i.user.username });

async function voiceAutocomplete(ctx, i) {
  const q = i.options.getFocused().toLowerCase();
  await i.respond(usableVoices(ctx).filter((v) => !q || v.profile.name.toLowerCase().includes(q) || v.id.toLowerCase().includes(q))
    .slice(0, 25).map((v) => ({ name: v.profile.name.slice(0, 100), value: v.id })));
}

async function commandJoin(ctx, i, channel) {
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  try { await join(ctx, channel); await i.editReply(`Joined ${channel}.`); }
  catch (e) { await i.editReply(e.message); }
}

export default {
  async start(ctx) {
    S.player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
    S.player.on('error', (e) => ctx.log('player error:', e.message));
    ctx.onDispose(() => { leave(ctx); S.player?.stop(true); S.player = null; ctx.setStatus(null); });
    ctx.on(Events.VoiceStateUpdate, (o, n) => onVoiceState(ctx, o, n));
    ctx.after(3000, () => checkHome(ctx));
    ctx.provide('voicechat', {
      connected: () => Boolean(connection(ctx)),
      say: (text, opts) => say(ctx, text, opts),
      voiceName: (id) => voiceName(ctx, id),
    });
  },

  async settingsChanged(ctx, now, old) {
    if (now.randomTalk !== old.randomTalk || now.intervalMin !== old.intervalMin || now.intervalMax !== old.intervalMax) scheduleTalk(ctx);
    if (now.homeChannel !== old.homeChannel || now.autoJoin !== old.autoJoin) checkHome(ctx);
    if (now.voice !== old.voice) updateStatus(ctx);
  },

  commands: [
    {
      data: new SlashCommandBuilder().setName('join').setDescription('OzBot joins your voice channel (or the home channel)'),
      async run(ctx, i) {
        const ch = i.member?.voice?.channel ?? (ctx.settings.homeChannel && i.guild.channels.cache.get(ctx.settings.homeChannel));
        if (!ch) return i.reply(ephemeral('Join a voice channel first.'));
        return commandJoin(ctx, i, ch);
      },
    },
    {
      data: new SlashCommandBuilder().setName('leave').setDescription('OzBot leaves voice'),
      run: (ctx, i) => i.reply(ephemeral(leave(ctx) ? 'Bye!' : 'I am not in a voice channel.')),
    },
    {
      data: new SlashCommandBuilder().setName('say').setDescription('OzBot says this out loud (in voice, or as a clip here)')
        .addStringOption((o) => o.setName('text').setDescription('What to say').setRequired(true).setMaxLength(600))
        .addStringOption(voiceOption),
      autocomplete: voiceAutocomplete,
      async run(ctx, i) {
        const s = ctx.settings;
        if (!s.allowSay) return i.reply(ephemeral('/say is switched off.'));
        const text = i.options.getString('text').slice(0, s.maxSayChars);
        const voice = i.options.getString('voice') || undefined;
        const here = currentChannel(ctx);
        if (!here) {
          if (!s.speakWithoutVc) return i.reply(ephemeral('I am not in a voice channel. Use /join first.'));
          return replyWithClip(ctx, i, text, voice, 'say');
        }
        if (i.member?.voice?.channelId !== here.id) return i.reply(ephemeral(`You need to be in ${here} to use /say.`));
        try {
          const said = say(ctx, text, { voice, source: 'say', user: userOf(i) });
          return i.reply(ephemeral(`Saying: “${said}”`));
        } catch (e) { return i.reply(ephemeral(e.message)); }
      },
    },
    {
      data: new SlashCommandBuilder().setName('speak').setDescription('OzBot says a random sentence made from the chat')
        .addStringOption((o) => o.setName('about').setDescription('Try to include this word').setMaxLength(40))
        .addStringOption(voiceOption),
      autocomplete: voiceAutocomplete,
      async run(ctx, i) {
        const about = i.options.getString('about') ?? '';
        const voice = i.options.getString('voice') || undefined;
        try {
          if (!connection(ctx)) {
            if (!ctx.settings.speakWithoutVc) return i.reply(ephemeral('I am not in a voice channel. Use /join first.'));
            return replyWithClip(ctx, i, markovLine(ctx, about), voice, 'speak');
          }
          const text = speakRandom(ctx, about, { voice, source: 'speak', user: userOf(i) });
          // If Voice log posts /speak lines, keep this reply private so the line is not posted twice.
          const logged = ctx.use('voicelog')?.posts('speak');
          return i.reply(logged ? ephemeral(`🗣️ ${text}`) : { content: `🗣️ ${text}`, allowedMentions: { parse: [] } });
        } catch (e) { return i.deferred ? i.editReply(e.message) : i.reply(ephemeral(e.message)); }
      },
    },
    {
      data: new SlashCommandBuilder().setName('voice').setDescription('Change or show the voice OzBot uses')
        .addSubcommand((c) => c.setName('set').setDescription('Change the voice for everything OzBot says')
          .addStringOption((o) => o.setName('name').setDescription('Voice').setRequired(true).setAutocomplete(true)))
        .addSubcommand((c) => c.setName('list').setDescription('List the voices'))
        .addSubcommand((c) => c.setName('current').setDescription('Which voice is in use')),
      autocomplete: voiceAutocomplete,
      async run(ctx, i) {
        const sub = i.options.getSubcommand();
        const current = ctx.use('voices')?.resolve(ctx.settings.voice);
        if (sub === 'current') {
          const mode = ctx.settings.voiceMode === 'random' ? ' (random lines use a random voice)' : '';
          return i.reply(ephemeral(`🎙️ Current voice: **${current?.name ?? 'none'}**${mode}`));
        }
        if (sub === 'list') {
          const lines = usableVoices(ctx).map((v) => `${v.id === current?.voice ? '▶️' : '•'} **${v.profile.name}**`);
          return i.reply(ephemeral(lines.length ? lines.join('\n') : 'No voices installed.'));
        }
        const want = i.options.getString('name');
        const pick = usableVoices(ctx).find((v) => v.id === want)
          ?? usableVoices(ctx).find((v) => v.profile.name.toLowerCase() === want.toLowerCase());
        if (!pick) return i.reply(ephemeral(`No voice called “${want}”. Try /voice list.`));
        const r = await ctx.saveSettings({ voice: pick.id });
        if (r.errors) return i.reply(ephemeral('Could not change the voice.'));
        ctx.log(`voice changed to ${pick.id} by ${userOf(i).name}`);
        return i.reply({ content: `🎙️ Voice changed to **${pick.profile.name}** by ${userOf(i).name}`, allowedMentions: { parse: [] } });
      },
    },
  ],

  routes: {
    'POST join': async (ctx, { body }) => {
      const g = ctx.guild();
      if (!g) throw httpError(409, 'Bot is not online in a server');
      const id = String(body.channelId || ctx.settings.homeChannel || '');
      if (!id) throw httpError(400, 'Pick a channel or set a home channel');
      await join(ctx, g.channels.cache.get(id));
      return { ok: true };
    },
    'POST leave': (ctx) => ({ ok: leave(ctx) }),
    'POST say': (ctx, { body }) => ({ said: say(ctx, String(body.text ?? '').slice(0, 600), { voice: body.voice || undefined, source: 'dashboard' }) }),
    'POST speak': (ctx, { body }) => ({ said: speakRandom(ctx, String(body.about ?? '').slice(0, 40), { voice: body.voice || undefined, source: 'dashboard' }) }),
    // Dashboard "play" on a recent line: synthesise it again and send the wav to the browser.
    'POST play-line': async (ctx, { body }) => {
      const item = S.recent[Number(body.index)];
      if (!item) throw httpError(404, 'That line is gone');
      const out = await voicesApi(ctx).speak(item.text, item.voiceId);
      return { file: out.path, remove: true, type: 'audio/wav' };
    },
  },

  status(ctx) {
    const here = currentChannel(ctx);
    return {
      channel: here ? { id: here.id, name: here.name } : null, humans: humansIn(here), queue: S.queue.length, speaking: S.busy,
      nextTalkAt: S.nextTalkAt, last: S.last, joinedAt: S.joinedAt, markov: Boolean(ctx.use('sentences')),
      voiceName: voiceName(ctx), voiceMode: ctx.settings.voiceMode,
      recent: S.recent.map((r) => ({ text: r.text, voice: r.voiceName, source: SOURCE_LABEL[r.source] ?? r.source, user: r.user, at: r.at })),
    };
  },
};
