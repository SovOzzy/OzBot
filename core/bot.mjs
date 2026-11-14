// Discord connection: one client for the whole bot. Modules attach listeners through their ctx (see modules.mjs),
// so the client is created once and survives token changes / reconnects.
import { Client, GatewayIntentBits, Partials, Events, ActivityType, ChannelType, PermissionFlagsBits, Routes, RateLimitError } from 'discord.js';
import { EventEmitter } from 'node:events';

const INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent, // privileged: switch on in the developer portal (Bot > Message Content Intent)
  GatewayIntentBits.GuildVoiceStates,
];

const FRIENDLY_CLOSE = {
  4004: 'The bot token was rejected. Paste a fresh token from the Discord developer portal.',
  TokenInvalid: 'The bot token was rejected. Paste a fresh token from the Discord developer portal.',
  DisallowedIntents: 'Discord refused the Message Content intent. Turn on "Message Content Intent" under Bot in the developer portal.',
  4014: 'Discord refused the Message Content intent. Turn on "Message Content Intent" under Bot in the developer portal.',
};

const STATUSES = ['online', 'idle', 'dnd', 'invisible'];
const ACTIVITY = { custom: ActivityType.Custom, playing: ActivityType.Playing, listening: ActivityType.Listening,
  watching: ActivityType.Watching, competing: ActivityType.Competing };

// Discord's form errors look like "Invalid Form Body\nusername[USERNAME_RATE_LIMIT]: You are changing ...".
function friendlyApiError(e) {
  const msg = String(e?.message ?? e);
  const lines = msg.split('\n').slice(1).map((l) => l.replace(/^[\w.[\]]+\[[A-Z_]+\]:\s*/, '').trim()).filter(Boolean);
  return lines.length ? lines.join(' ') : msg;
}

export class Bot extends EventEmitter {
  constructor({ store, log }) {
    super();
    this.store = store;
    this.log = log;
    this.state = 'no-token'; // no-token | connecting | online | offline | error
    this.error = null;
    this.readyAt = null;
    this.client = null;
    this.presenceOverrides = new Map(); // module id -> status text (e.g. 'Speaking as Oz')
    this.#makeClient();
  }

  #makeClient() {
    // Long rate limits on profile edits (username: 2 an hour) would otherwise leave the request queued for ages;
    // fail fast instead so the dashboard can say "try again in N minutes".
    this.client = new Client({ intents: INTENTS, partials: [Partials.Channel],
      rest: { rejectOnRateLimit: (d) => d.method !== 'GET' && d.timeToReset > 15000 } });
    this.client.setMaxListeners(50);
    this.client.on(Events.ClientReady, () => {
      this.state = 'online'; this.error = null; this.readyAt = Date.now();
      this.store.set('core:appId', this.client.user.id);
      this.log(`online as ${this.client.user.tag} in ${this.client.guilds.cache.size} server(s)`);
      this.applyPresence();
      this.emit('ready');
    });
    this.client.on(Events.ShardDisconnect, (ev) => {
      if (FRIENDLY_CLOSE[ev?.code]) { this.state = 'error'; this.error = FRIENDLY_CLOSE[ev.code]; }
      else if (this.state === 'online') this.state = 'connecting';
    });
    this.client.on(Events.ShardResume, () => { this.state = 'online'; });
    this.client.on(Events.GuildCreate, () => this.emit('guilds'));
    this.client.on(Events.GuildDelete, () => this.emit('guilds'));
    this.client.on(Events.Error, (e) => this.log('client error:', e.message));
  }

  get token() { return process.env.OZBOT_TOKEN || this.store.get('secret:token', ''); }
  get core() {
    return { guildId: '', statusText: 'Listening to your chat', presence: 'online', activityType: 'custom', showFunctionStatus: true,
      ...this.store.get('core:settings', {}) };
  }

  async start() {
    if (!this.token) { this.state = 'no-token'; return; }
    this.state = 'connecting'; this.error = null;
    try {
      await this.client.login(this.token);
    } catch (e) {
      this.state = 'error';
      this.error = FRIENDLY_CLOSE[e.code] ?? (/disallowed intents/i.test(e.message) ? FRIENDLY_CLOSE[4014]
        : /token/i.test(e.message) ? FRIENDLY_CLOSE[4004] : e.message);
      this.log('login failed:', this.error);
    }
  }

  // New token: tear the old session down and log in again. Listeners live on the client, so modules are
  // restarted by the caller (ModuleManager.restartAll) after this resolves.
  async setToken(token) {
    this.store.set('secret:token', token.trim());
    await this.client.destroy().catch(() => {});
    this.#makeClient();
    this.emit('client');
    await this.start();
  }

  async stop() { await this.client.destroy().catch(() => {}); this.state = 'offline'; }

  setPresenceOverride(moduleId, text) {
    if (text) this.presenceOverrides.set(moduleId, String(text).slice(0, 120)); else this.presenceOverrides.delete(moduleId);
    this.applyPresence();
  }

  // What the member list shows: online/idle/dnd/invisible plus one activity line. A function's live status
  // ("Speaking as Oz") replaces the line while it lasts, unless showFunctionStatus is off.
  presenceView() {
    const c = this.core;
    const override = c.showFunctionStatus ? [...this.presenceOverrides.values()].at(-1) : null;
    const text = override ?? c.statusText?.trim() ?? '';
    const type = override ? 'custom' : (ACTIVITY[c.activityType] ? c.activityType : 'custom');
    return { status: STATUSES.includes(c.presence) ? c.presence : 'online', type, text, fromFunction: Boolean(override) };
  }

  applyPresence() {
    if (this.state !== 'online') return;
    const p = this.presenceView();
    const act = p.type === 'custom' ? { name: p.text, type: ActivityType.Custom, state: p.text } : { name: p.text, type: ACTIVITY[p.type] };
    this.client.user.setPresence({ activities: p.text ? [act] : [], status: p.status });
  }

  // ---- profile: name, avatar, banner, about me (everywhere) + nickname, avatar, banner, bio (this server) ----
  async profile() {
    if (this.state !== 'online') return null;
    const rest = this.client.rest;
    const [user, app] = await Promise.all([rest.get(Routes.user()), rest.get(Routes.currentApplication()).catch(() => ({}))]);
    const cdn = this.client.rest.cdn;
    const ext = (hash) => (hash?.startsWith('a_') ? 'gif' : 'png');
    const global = {
      username: user.username,
      avatar: user.avatar ? cdn.avatar(user.id, user.avatar, { size: 256, extension: ext(user.avatar) }) : cdn.defaultAvatar(Number((BigInt(user.id) >> 22n) % 6n)),
      banner: user.banner ? cdn.banner(user.id, user.banner, { size: 1024, extension: ext(user.banner) }) : null,
      accentColor: user.accent_color ?? null,
      about: app.description ?? '',
    };
    const g = this.guild();
    let server = null;
    if (g) {
      const m = await rest.get(Routes.guildMember(g.id, user.id));
      const local = this.store.get(`core:profile:${g.id}`, {});
      server = {
        guildId: g.id, guildName: g.name,
        nick: m.nick ?? '',
        avatar: m.avatar ? cdn.guildMemberAvatar(g.id, user.id, m.avatar, { size: 256, extension: ext(m.avatar) }) : null,
        banner: m.banner ? cdn.guildMemberBanner(g.id, user.id, m.banner, { size: 1024, extension: ext(m.banner) }) : null,
        bio: m.bio ?? local.bio ?? '',
        canNick: g.members.me?.permissions.has(PermissionFlagsBits.ChangeNickname) ?? false,
      };
    }
    return { global, server, presence: this.presenceView() };
  }

  // scope 'global': { username?, avatar?, banner?, about? }; scope 'server': { nick?, avatar?, banner?, bio? }.
  // Images are data: URIs, or null to remove. Only keys present are sent.
  async editProfile(scope, ch) {
    if (this.state !== 'online') throw new Error('OzBot is not connected to Discord');
    const has = (k) => Object.hasOwn(ch, k);
    try {
      if (scope === 'global') {
        const body = {};
        for (const k of ['username', 'avatar', 'banner']) if (has(k)) body[k] = ch[k];
        if (Object.keys(body).length) {
          const data = await this.client.rest.patch(Routes.user(), { body });
          this.client.actions.UserUpdate.handle(data);
        }
        if (has('about')) await this.client.rest.patch(Routes.currentApplication(), { body: { description: ch.about } });
      } else {
        const g = this.guild();
        if (!g) throw new Error('No server chosen');
        const body = {};
        for (const k of ['nick', 'avatar', 'banner', 'bio']) if (has(k)) body[k] = ch[k];
        await this.client.rest.patch(Routes.guildMember(g.id, '@me'), { body });
        if (has('bio')) this.store.set(`core:profile:${g.id}`, { ...this.store.get(`core:profile:${g.id}`, {}), bio: ch.bio });
      }
    } catch (e) {
      if (e instanceof RateLimitError) {
        const min = Math.ceil(e.timeToReset / 60000);
        throw new Error(`Discord only allows a few profile changes at a time. Try again in ${min} minute${min === 1 ? '' : 's'}.`);
      }
      throw new Error(friendlyApiError(e));
    }
  }

  // The one server OzBot works in. If not chosen yet and the bot is in exactly one server, use that.
  guild() {
    if (this.state !== 'online') return null;
    const id = this.core.guildId;
    if (id) return this.client.guilds.cache.get(id) ?? null;
    return this.client.guilds.cache.size === 1 ? this.client.guilds.cache.first() : null;
  }

  guilds() {
    if (this.state !== 'online') return [];
    return this.client.guilds.cache.map((g) => ({ id: g.id, name: g.name, icon: g.iconURL({ size: 64 }) }));
  }

  inviteUrl() {
    const id = this.client.user?.id ?? this.store.get('core:appId', '');
    if (!id) return null;
    const perms = PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages | PermissionFlagsBits.ReadMessageHistory
      | PermissionFlagsBits.AttachFiles | PermissionFlagsBits.EmbedLinks
      | PermissionFlagsBits.Connect | PermissionFlagsBits.Speak | PermissionFlagsBits.UseVAD;
    return `https://discord.com/oauth2/authorize?client_id=${id}&scope=bot%20applications.commands&permissions=${perms}`;
  }

  guildInfo() {
    const g = this.guild();
    if (!g) return null;
    const me = g.members.me;
    const chan = (types) => g.channels.cache
      .filter((c) => types.includes(c.type))
      .sort((a, b) => (a.parent?.rawPosition ?? -1) - (b.parent?.rawPosition ?? -1) || a.rawPosition - b.rawPosition)
      .map((c) => ({
        id: c.id, name: c.name, category: c.parent?.name ?? '',
        canRead: me ? c.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]) : false,
        canSpeak: me ? c.permissionsFor(me)?.has([PermissionFlagsBits.Connect, PermissionFlagsBits.Speak]) : false,
        canPost: me ? c.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]) : false,
        canAttach: me ? c.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles]) : false,
      }));
    return {
      id: g.id, name: g.name, icon: g.iconURL({ size: 128 }), members: g.memberCount,
      textChannels: chan([ChannelType.GuildText, ChannelType.GuildAnnouncement]),
      roles: g.roles.cache.filter((r) => r.id !== g.id && !r.managed).sort((a, b) => b.position - a.position)
        .map((r) => ({ id: r.id, name: r.name })),
      voiceChannels: chan([ChannelType.GuildVoice, ChannelType.GuildStageVoice]),
    };
  }

  summary() {
    const g = this.guild();
    return {
      state: this.state, error: this.error,
      user: this.client.user ? { tag: this.client.user.tag, avatar: this.client.user.displayAvatarURL({ size: 64 }) } : null,
      guild: g ? { id: g.id, name: g.name, icon: g.iconURL({ size: 64 }) } : null,
      guildCount: this.state === 'online' ? this.client.guilds.cache.size : 0,
      ping: this.state === 'online' ? this.client.ws.ping : null,
      readyAt: this.readyAt, hasToken: Boolean(this.token), tokenFromEnv: Boolean(process.env.OZBOT_TOKEN),
      invite: this.inviteUrl(),
    };
  }
}
