// Markov chat: stores cleaned messages from the chosen channels in SQLite, keeps a chain in memory and offers
// a "sentences" service that other modules (Voice chat) use.
import { Events, SlashCommandBuilder, MessageFlags, ChannelType } from 'discord.js';
import { Chain, cleanMessage } from './chain.mjs';

let chain = null;
let lastReply = 0;
let backfill = null; // { channel, done, wanted, running, error }

function setupDb(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS markov_messages (
      id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, author_id TEXT NOT NULL, content TEXT NOT NULL, ts INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS markov_messages_ts ON markov_messages (ts);
    CREATE INDEX IF NOT EXISTS markov_messages_author ON markov_messages (author_id);
    CREATE TABLE IF NOT EXISTS markov_optout (user_id TEXT PRIMARY KEY, at INTEGER NOT NULL);`);
}

function rebuild(ctx) {
  const s = ctx.settings;
  chain = new Chain(s.order);
  const rows = ctx.db.prepare('SELECT content FROM markov_messages ORDER BY ts DESC LIMIT ?').all(s.maxMessages);
  for (const r of rows) chain.add(r.content);
  ctx.log(`chain built: ${chain.size} messages, ${chain.next.size} states (order ${s.order})`);
}

const optedOut = (ctx, userId) => Boolean(ctx.db.prepare('SELECT 1 FROM markov_optout WHERE user_id = ?').get(userId));

// Returns true if stored.
function learn(ctx, msg) {
  const s = ctx.settings;
  if (!msg.guildId || msg.guildId !== ctx.guild()?.id) return false;
  if (!s.channels.includes(msg.channelId)) return false;
  if (msg.author.id === ctx.client.user?.id || msg.system || msg.webhookId) return false;
  if (s.ignoreBots && msg.author.bot) return false;
  const raw = msg.content ?? '';
  const prefixes = s.ignorePrefixes.split(/\s+/).filter(Boolean);
  if (prefixes.some((p) => raw.startsWith(p))) return false;
  if (optedOut(ctx, msg.author.id)) return false;
  const text = cleanMessage(raw, s).slice(0, 1000);
  if (text.split(' ').length < 2) return false;
  const r = ctx.db.prepare('INSERT OR IGNORE INTO markov_messages (id, channel_id, author_id, content, ts) VALUES (?, ?, ?, ?, ?)')
    .run(msg.id, msg.channelId, msg.author.id, text, msg.createdTimestamp);
  if (r.changes) chain?.add(text);
  return Boolean(r.changes);
}

let sinceprune = 0;
function prune(ctx, force = false) {
  if (!force && ++sinceprune < 200) return;
  sinceprune = 0;
  const max = ctx.settings.maxMessages;
  const r = ctx.db.prepare(`DELETE FROM markov_messages WHERE id IN (
    SELECT id FROM markov_messages ORDER BY ts DESC LIMIT -1 OFFSET ?)`).run(max);
  if (r.changes) { ctx.log(`forgot ${r.changes} oldest messages`); rebuild(ctx); }
}

function sentence(ctx, opts = {}) {
  const s = ctx.settings;
  return chain?.generate({ minWords: s.minWords, maxWords: s.maxWords, allowCopy: s.allowCopy, ...opts }) ?? null;
}

function historyChannel(ctx, channelId) {
  const ch = ctx.guild()?.channels.cache.get(channelId);
  const bad = (m) => Object.assign(new Error(m), { code: 400 });
  if (!ch || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(ch.type)) throw bad('Unknown text channel');
  if (!ctx.settings.channels.includes(channelId)) throw bad('Add this channel to "Channels to learn from" (and save) first');
  return ch;
}

async function runBackfill(ctx, ch, wanted) {
  backfill = { channel: ch.name, done: 0, stored: 0, wanted, running: true, error: null };
  let before;
  try {
    while (backfill.done < wanted && ctx.running) {
      const batch = await ch.messages.fetch({ limit: Math.min(100, wanted - backfill.done), before, cache: false });
      if (!batch.size) break;
      for (const m of batch.values()) { backfill.done++; if (learn(ctx, m)) backfill.stored++; }
      before = batch.last().id;
      await new Promise((r) => setTimeout(r, 1200)); // stay well inside rate limits
    }
  } catch (e) { backfill.error = e.message; }
  backfill.running = false;
  prune(ctx, true);
  ctx.log(`history import #${backfill.channel}: read ${backfill.done}, stored ${backfill.stored}`);
}

const tellUser = (i, content) => i.reply({ content, flags: MessageFlags.Ephemeral });

export default {
  async start(ctx) {
    setupDb(ctx.db);
    rebuild(ctx);
    ctx.provide('sentences', {
      random: (opts) => sentence(ctx, opts),
      count: () => chain?.size ?? 0,
    });

    ctx.on(Events.MessageCreate, async (msg) => {
      if (ctx.ignored(msg.author.id, msg.member)) return;
      if (!learn(ctx, msg)) {
        // still allow replies to mentions in the channel even if the message itself wasn't stored
        if (!msg.guildId || !ctx.settings.channels.includes(msg.channelId) || msg.author.bot) return;
      } else prune(ctx);
      const s = ctx.settings;
      const mentioned = s.replyOnMention && msg.mentions.users.has(ctx.client.user.id);
      const random = s.replyChance > 0 && Math.random() * 100 < s.replyChance;
      if (!mentioned && !random) return;
      if (Date.now() - lastReply < s.cooldownSeconds * 1000) return;
      let text = null;
      if (mentioned) {
        const words = cleanMessage(msg.content, { stripLinks: true, stripMentions: true }).split(' ').filter((w) => w.length > 3);
        for (const w of words.sort(() => Math.random() - 0.5).slice(0, 4)) if ((text = sentence(ctx, { about: w }))) break;
      }
      text ??= sentence(ctx);
      if (!text) return;
      lastReply = Date.now();
      await msg.channel.send({ content: text, allowedMentions: { parse: [] } });
    });
  },

  async stop() { chain = null; },

  async settingsChanged(ctx, now, old) {
    if (now.order !== old.order || now.maxMessages < old.maxMessages) { prune(ctx, true); rebuild(ctx); }
  },

  commands: [
    {
      data: new SlashCommandBuilder().setName('markov').setDescription('OzBot Markov chat')
        .addSubcommand((c) => c.setName('say').setDescription('Make a sentence from the chat')
          .addStringOption((o) => o.setName('about').setDescription('Try to include this word').setMaxLength(40)))
        .addSubcommand((c) => c.setName('forget-me').setDescription('Delete everything OzBot learned from you and stop learning'))
        .addSubcommand((c) => c.setName('learn-me').setDescription('Let OzBot learn from your messages again'))
        .addSubcommand((c) => c.setName('stats').setDescription('How much OzBot has learned')),
      open: ['forget-me', 'learn-me'], // privacy: always allowed, whatever Bot settings say
      async run(ctx, i) {
        const sub = i.options.getSubcommand();
        if (sub === 'say') {
          const about = i.options.getString('about') ?? '';
          const text = sentence(ctx, { about }) ?? (about ? sentence(ctx) : null);
          return i.reply({ content: text ?? 'I have not learned enough yet.', allowedMentions: { parse: [] } });
        }
        if (sub === 'forget-me') {
          ctx.db.prepare('INSERT OR REPLACE INTO markov_optout (user_id, at) VALUES (?, ?)').run(i.user.id, Date.now());
          const r = ctx.db.prepare('DELETE FROM markov_messages WHERE author_id = ?').run(i.user.id);
          rebuild(ctx);
          return tellUser(i, `Done: deleted ${r.changes} of your messages and I will not learn from you any more. \`/markov learn-me\` undoes this.`);
        }
        if (sub === 'learn-me') {
          ctx.db.prepare('DELETE FROM markov_optout WHERE user_id = ?').run(i.user.id);
          return tellUser(i, 'OK, I will learn from your new messages again.');
        }
        const st = chain?.stats() ?? { messages: 0, states: 0 };
        return tellUser(i, `I know ${st.messages.toLocaleString()} messages (${st.states.toLocaleString()} word patterns).`);
      },
    },
  ],

  routes: {
    'POST sample': (ctx, { body }) => ({
      sentences: Array.from({ length: Math.min(Number(body.count) || 5, 10) }, () => sentence(ctx, { about: String(body.about ?? '').slice(0, 40) }))
        .filter(Boolean),
    }),
    'POST backfill': async (ctx, { body }) => {
      if (!ctx.running) throw Object.assign(new Error('Turn Markov chat on first'), { code: 409 });
      if (backfill?.running) throw Object.assign(new Error('An import is already running'), { code: 409 });
      const wanted = Math.max(100, Math.min(Number(body.limit) || 2000, 20000));
      const ch = historyChannel(ctx, String(body.channelId));
      runBackfill(ctx, ch, wanted); // in the background; progress shows in status
      return { started: true };
    },
    'POST clear': { always: true, fn: (ctx, { body }) => {
      if (body.confirm !== 'DELETE') throw Object.assign(new Error('Confirmation missing'), { code: 400 });
      setupDb(ctx.db);
      const r = ctx.db.prepare('DELETE FROM markov_messages').run();
      if (ctx.running) rebuild(ctx);
      ctx.log(`cleared ${r.changes} learned messages (dashboard)`);
      return { deleted: r.changes };
    } },
  },

  status(ctx) {
    const perChannel = ctx.db.prepare('SELECT channel_id, COUNT(*) AS n FROM markov_messages GROUP BY channel_id').all();
    const g = ctx.guild();
    return {
      ...(chain?.stats() ?? {}),
      stored: ctx.db.prepare('SELECT COUNT(*) AS n FROM markov_messages').get().n,
      optedOut: ctx.db.prepare('SELECT COUNT(*) AS n FROM markov_optout').get().n,
      channels: perChannel.map((r) => ({ id: r.channel_id, name: g?.channels.cache.get(r.channel_id)?.name ?? r.channel_id, messages: r.n })),
      backfill,
    };
  },
};
