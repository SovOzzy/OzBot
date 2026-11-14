// Voice log: listens to Voice chat's 'voice:spoken' / 'voice:joined' / 'voice:left' events and posts them to a
// channel as `"text" - Voice` (+ MP3). The MP3 is made from Voice chat's wav while the line plays, uploaded, then
// deleted: nothing builds up on the VPS. Posted lines are kept in voicelog_lines for the dashboard's "Last posted".
import { PermissionFlagsBits } from 'discord.js';
import { unlink } from 'node:fs/promises';
import { wavToMp3, clipFileName } from '../../core/audio.mjs';

const SOURCE_LABEL = { random: 'random line', speak: '/speak', say: '/say', greeting: 'greeting', dashboard: 'dashboard', replay: 'replay' };
const POST_KEY = { random: 'postRandom', speak: 'postSpeak', say: 'postSay', greeting: 'postGreeting', dashboard: 'postSay' };
const httpError = (code, msg) => Object.assign(new Error(msg), { code });
let stats = { posted: 0, lastError: null, lastAt: null };

function setupDb(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS voicelog_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, voice_id TEXT, voice_name TEXT, source TEXT, user_name TEXT,
    at INTEGER NOT NULL, message_id TEXT)`);
}

export function formatLine(template, { text, voiceName, user, source }) {
  const t = template?.trim() || '"{text}" - {voice}';
  const vals = { text, voice: voiceName ?? 'OzBot', user: user?.name ?? '', source: SOURCE_LABEL[source] ?? source ?? '' };
  return t.replace(/\{(text|voice|user|source)\}/g, (_, k) => vals[k]).replace(/\s+-\s*$/, '').slice(0, 1900);
}

function channel(ctx) {
  const id = ctx.settings.channel;
  return id ? ctx.guild()?.channels.cache.get(id) ?? null : null;
}

function permissions(ctx) {
  const ch = channel(ctx);
  const me = ch?.guild.members.me;
  if (!ch || !me) return { ok: false, problem: ctx.settings.channel ? 'Channel not found' : 'No channel chosen yet' };
  const p = ch.permissionsFor(me);
  const missing = [];
  if (!p?.has(PermissionFlagsBits.ViewChannel)) missing.push('View Channel');
  if (!p?.has(PermissionFlagsBits.SendMessages)) missing.push('Send Messages');
  if (ctx.settings.attachAudio && !p?.has(PermissionFlagsBits.AttachFiles)) missing.push('Attach Files');
  return { ok: missing.length === 0, missing, channel: ch.name };
}

async function post(ctx, item, wav) {
  const ch = channel(ctx);
  if (!ch) return;
  const s = ctx.settings;
  const perms = permissions(ctx);
  if (!perms.ok) { stats.lastError = `Missing permission in #${ch.name}: ${perms.missing.join(', ')}`; return; }
  const row = ctx.db.prepare('INSERT INTO voicelog_lines (text, voice_id, voice_name, source, user_name, at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(item.text, item.voiceId, item.voiceName, item.source, item.user?.name ?? null, Date.now());
  const msg = { content: formatLine(s.format, item), allowedMentions: { parse: [] } };
  let mp3;
  try {
    if (s.attachAudio && wav) {
      mp3 = wav.replace(/\.wav$/, '') + '-log.mp3';
      await wavToMp3(wav, mp3);
      msg.files = [{ attachment: mp3, name: clipFileName(item.voiceName) }];
    }
    const sent = await ch.send(msg);
    ctx.db.prepare('UPDATE voicelog_lines SET message_id = ? WHERE id = ?').run(sent.id, row.lastInsertRowid);
    stats.posted++; stats.lastAt = Date.now(); stats.lastError = null;
  } catch (e) {
    stats.lastError = e.message;
    ctx.log('post failed:', e.message);
  } finally { if (mp3) unlink(mp3).catch(() => {}); }
  // keep the table small: only the dashboard's recent list reads it
  ctx.db.prepare('DELETE FROM voicelog_lines WHERE id <= ?').run(Number(row.lastInsertRowid) - 5000);
}

function duration(ms) {
  const m = Math.round(ms / 60000);
  if (m < 1) return 'less than a minute';
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
}

async function note(ctx, content) {
  const ch = channel(ctx);
  if (!ch || !ctx.settings.sessionNotes || !permissions(ctx).ok) return;
  await ch.send({ content, allowedMentions: { parse: [] } }).catch((e) => { stats.lastError = e.message; });
}

export default {
  async start(ctx) {
    setupDb(ctx.db);
    ctx.provide('voicelog', {
      format: (item) => formatLine(ctx.settings.format, item),
      posts: (source) => Boolean(channel(ctx)) && Boolean(ctx.settings[POST_KEY[source]]),
    });
    ctx.subscribe('voice:spoken', (p) => {
      if (!ctx.settings[POST_KEY[p.source]]) return;
      p.holds.push(post(ctx, p, p.wav)); // Voice chat keeps the wav until this is done
    });
    ctx.subscribe('voice:joined', ({ channel: c }) => note(ctx, `🔊 Joined **${c.name}**`));
    ctx.subscribe('voice:left', ({ channel: c, durationMs, lines }) =>
      note(ctx, `👋 Left **${c.name}** after ${duration(durationMs)}, said ${lines} line${lines === 1 ? '' : 's'}`));
  },

  async settingsChanged() {},

  routes: {
    // Dashboard "Send a test post": a short line in the current voice, posted exactly like a real one.
    'POST test': async (ctx) => {
      if (!channel(ctx)) throw httpError(400, 'Choose a channel (and save) first');
      const perms = permissions(ctx);
      if (!perms.ok) throw httpError(403, `OzBot is missing ${perms.missing.join(', ')} in #${perms.channel}`);
      const voices = ctx.use('voices');
      if (!voices) throw httpError(409, 'Turn Voice profiles on first');
      const text = 'This is a test of the voice log.';
      const current = ctx.store.get('module:voice:settings', {})?.voice ?? ''; // Voice chat's current voice
      const out = await voices.speak(text, current);
      try { await post(ctx, { text, voiceId: out.voice, voiceName: out.name, source: 'say', user: { name: 'dashboard test' } }, out.path); }
      finally { unlink(out.path).catch(() => {}); }
      if (stats.lastError) throw httpError(502, stats.lastError);
      return { ok: true };
    },
  },

  status(ctx) {
    const recent = ctx.db.prepare('SELECT text, voice_name, source, user_name, at FROM voicelog_lines ORDER BY id DESC LIMIT 10').all();
    return { ...stats, permissions: permissions(ctx), recent };
  },
};
