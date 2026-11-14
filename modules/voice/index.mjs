// Voice chat: one voice connection in the bot's server. Text -> (voices service) wav -> ffmpeg Opus/Ogg ->
// @discordjs/voice. One sentence at a time from a short queue; random Markov sentences on a jittered timer.
import { Events, SlashCommandBuilder, MessageFlags, ChannelType } from 'discord.js';
import {
  joinVoiceChannel, getVoiceConnection, createAudioPlayer, createAudioResource, entersState,
  AudioPlayerStatus, VoiceConnectionStatus, StreamType, NoSubscriberBehavior,
} from '@discordjs/voice';
import { spawn } from 'node:child_process';
import { unlink } from 'node:fs/promises';

const S = { player: null, queue: [], busy: false, talkTimer: null, leaveTimer: null, nextTalkAt: null, last: null, joinedAt: null };
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

async function join(ctx, channel) {
  if (!channel || ![ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(channel.type)) throw httpError(400, 'Not a voice channel');
  const me = channel.guild.members.me;
  if (!channel.permissionsFor(me)?.has(['Connect', 'Speak'])) throw httpError(403, `I am not allowed to connect/speak in #${channel.name}`);
  const existing = connection(ctx);
  if (existing?.joinConfig.channelId === channel.id && existing.state.status !== VoiceConnectionStatus.Destroyed) return existing;
  existing?.destroy();
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
  S.joinedAt = Date.now();
  ctx.log(`joined #${channel.name}`);
  if (ctx.settings.greet && ctx.settings.greeting) say(ctx, ctx.settings.greeting);
  scheduleTalk(ctx);
  return conn;
}

function onLeft(ctx) {
  clearTimeout(S.talkTimer); clearTimeout(S.leaveTimer);
  S.talkTimer = S.leaveTimer = S.nextTalkAt = S.joinedAt = null;
  S.queue.length = 0;
  S.player?.stop(true);
}

function leave(ctx) {
  const c = connection(ctx);
  if (!c) return false;
  c.destroy();
  onLeft(ctx);
  ctx.log('left voice');
  return true;
}

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
    try { if (humansIn(currentChannel(ctx)) > 0) speakRandom(ctx); } catch (e) { ctx.fail(e); }
    scheduleTalk(ctx);
  }, ms);
}

function speakRandom(ctx, about = '', voice) {
  const sentences = ctx.use('sentences');
  if (!sentences) throw httpError(409, 'Markov chat is off, so there is nothing to say');
  const text = sentences.random({ about }) ?? (about ? sentences.random() : null);
  if (!text) throw httpError(409, 'Markov chat has not learned enough yet');
  say(ctx, text, voice);
  return text;
}

function say(ctx, text, voice = ctx.settings.voice) {
  if (!connection(ctx)) throw httpError(409, 'I am not in a voice channel');
  const clean = speakable(text);
  if (!clean) throw httpError(400, 'Nothing speakable in that');
  if (S.queue.length >= ctx.settings.maxQueue) throw httpError(429, 'Queue is full, try again in a moment');
  S.queue.push({ text: clean, voice });
  pump(ctx);
  return clean;
}

async function pump(ctx) {
  if (S.busy) return;
  S.busy = true;
  try {
    while (S.queue.length && ctx.running && connection(ctx)) {
      const item = S.queue.shift();
      let wav;
      try {
        const out = await ctx.use('voices').speak(item.text, item.voice);
        wav = out.path;
        await play(wav);
        S.last = { text: item.text, voice: out.name, at: Date.now(), synthMs: out.ms };
      } catch (e) { ctx.log('speak failed:', e.message); ctx.fail(e); }
      finally { if (wav) unlink(wav).catch(() => {}); }
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

const ephemeral = (content) => ({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
const voiceOption = (o) => o.setName('voice').setDescription('Which voice (default if empty)').setAutocomplete(true);

async function voiceAutocomplete(ctx, i) {
  const q = i.options.getFocused().toLowerCase();
  const list = ctx.use('voices')?.list() ?? [];
  await i.respond(list.filter((v) => !q || v.profile.name.toLowerCase().includes(q) || v.id.toLowerCase().includes(q))
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
    ctx.onDispose(() => { leave(ctx); S.player?.stop(true); S.player = null; });
    ctx.on(Events.VoiceStateUpdate, (o, n) => onVoiceState(ctx, o, n));
    ctx.after(3000, () => checkHome(ctx));
  },

  async settingsChanged(ctx, now, old) {
    if (now.randomTalk !== old.randomTalk || now.intervalMin !== old.intervalMin || now.intervalMax !== old.intervalMax) scheduleTalk(ctx);
    if (now.homeChannel !== old.homeChannel || now.autoJoin !== old.autoJoin) checkHome(ctx);
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
      data: new SlashCommandBuilder().setName('say').setDescription('OzBot says this out loud in voice')
        .addStringOption((o) => o.setName('text').setDescription('What to say').setRequired(true).setMaxLength(600))
        .addStringOption(voiceOption),
      autocomplete: voiceAutocomplete,
      async run(ctx, i) {
        const s = ctx.settings;
        if (!s.allowSay) return i.reply(ephemeral('/say is switched off.'));
        const here = currentChannel(ctx);
        if (!here) return i.reply(ephemeral('I am not in a voice channel. Use /join first.'));
        if (i.member?.voice?.channelId !== here.id) return i.reply(ephemeral(`You need to be in ${here} to use /say.`));
        try {
          const text = say(ctx, i.options.getString('text').slice(0, s.maxSayChars), i.options.getString('voice') || undefined);
          return i.reply(ephemeral(`Saying: “${text}”`));
        } catch (e) { return i.reply(ephemeral(e.message)); }
      },
    },
    {
      data: new SlashCommandBuilder().setName('speak').setDescription('OzBot says a random sentence made from the chat')
        .addStringOption((o) => o.setName('about').setDescription('Try to include this word').setMaxLength(40))
        .addStringOption(voiceOption),
      autocomplete: voiceAutocomplete,
      async run(ctx, i) {
        if (!connection(ctx)) return i.reply(ephemeral('I am not in a voice channel. Use /join first.'));
        try { const text = speakRandom(ctx, i.options.getString('about') ?? '', i.options.getString('voice') || undefined); return i.reply({ content: `🗣️ ${text}`, allowedMentions: { parse: [] } }); }
        catch (e) { return i.reply(ephemeral(e.message)); }
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
    'POST say': (ctx, { body }) => ({ said: say(ctx, String(body.text ?? '').slice(0, 600), body.voice || undefined) }),
    'POST speak': (ctx, { body }) => ({ said: speakRandom(ctx, String(body.about ?? '').slice(0, 40), body.voice || undefined) }),
  },

  status(ctx) {
    const here = currentChannel(ctx);
    return {
      channel: here ? { id: here.id, name: here.name } : null, humans: humansIn(here), queue: S.queue.length, speaking: S.busy,
      nextTalkAt: S.nextTalkAt, last: S.last, joinedAt: S.joinedAt, markov: Boolean(ctx.use('sentences')),
    };
  },
};
