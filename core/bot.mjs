// Discord connection: one client for the whole bot. Modules attach listeners through their ctx (see modules.mjs),
// so the client is created once and survives token changes / reconnects.
import { Client, GatewayIntentBits, Partials, Events, ActivityType, ChannelType, PermissionFlagsBits } from 'discord.js';
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
    this.client = new Client({ intents: INTENTS, partials: [Partials.Channel] });
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
  get core() { return { guildId: '', statusText: 'Listening to your chat', ...this.store.get('core:settings', {}) }; }

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

  applyPresence() {
    if (this.state !== 'online') return;
    const text = [...this.presenceOverrides.values()].at(-1) ?? this.core.statusText?.trim();
    this.client.user.setPresence({ activities: text ? [{ name: text, type: ActivityType.Custom, state: text }] : [], status: 'online' });
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
