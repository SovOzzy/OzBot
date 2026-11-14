// Who may use which slash command, and how often. Two layers, kept apart on purpose:
//   everywhere (kv access:global): default cooldown per command + users OzBot ignores in every server
//   per server (kv access:guild:<id>): who can use each command, cooldown overrides, which channels commands work in,
//                                    roles that skip cooldowns, roles OzBot ignores
// Commands are addressed by path: 'say', 'voice set', 'markov say'. A command can list subcommands that are always
// allowed (`open: ['forget-me']`), so privacy opt-outs can never be locked away.
import { PermissionFlagsBits } from 'discord.js';

const WHO = ['inherit', 'everyone', 'roles', 'admins', 'off'];
const MAX_COOLDOWN = 24 * 3600;
const snowflake = (v) => /^\d{5,25}$/.test(String(v));
const ids = (v, max = 200) => [...new Set((Array.isArray(v) ? v : []).map(String).filter(snowflake))].slice(0, max);

export class Access {
  constructor({ store, bot, log }) {
    Object.assign(this, { store, bot, log });
    this.used = new Map(); // `${userId}|${path}` -> last use (ms)
  }

  global() {
    const g = this.store.get('access:global', {});
    return { cooldowns: g.cooldowns ?? {}, ignoredUsers: g.ignoredUsers ?? [] };
  }

  guildConfig(guildId) {
    const stored = this.store.get(`access:guild:${guildId}`, null);
    const c = { rules: {}, channelMode: 'all', channels: [], bypassRoles: [], ignoredRoles: [], ...(stored ?? {}) };
    // One-time move of Voice chat's old "who can change the voice" role into the server rules.
    if (!stored) {
      const legacy = this.store.get('module:voice:settings', {})?.voiceChangeRole;
      if (legacy && snowflake(legacy)) { c.rules['voice set'] = { who: 'roles', roles: [legacy] }; this.store.set(`access:guild:${guildId}`, c); }
    }
    return c;
  }

  saveGlobal(input, paths) {
    const cooldowns = {};
    for (const [p, v] of Object.entries(input.cooldowns ?? {})) {
      const n = Number(v);
      if (paths.has(p) && Number.isFinite(n) && n > 0) cooldowns[p] = Math.min(Math.round(n), MAX_COOLDOWN);
    }
    const next = { cooldowns, ignoredUsers: ids(input.ignoredUsers) };
    this.store.set('access:global', next);
    return next;
  }

  saveGuild(guildId, input, paths) {
    const rules = {};
    for (const [p, r] of Object.entries(input.rules ?? {})) {
      if (!paths.has(p) || typeof r !== 'object' || !r) continue;
      const rule = {};
      if (WHO.includes(r.who) && !(r.who === 'inherit' && !p.includes(' '))) rule.who = r.who;
      if (rule.who === 'roles') rule.roles = ids(r.roles, 50);
      if (rule.who === 'roles' && !rule.roles.length) delete rule.who;
      const n = r.cooldown === '' || r.cooldown == null ? null : Number(r.cooldown);
      if (n != null && Number.isFinite(n) && n >= 0) rule.cooldown = Math.min(Math.round(n), MAX_COOLDOWN);
      if (Object.keys(rule).length) rules[p] = rule;
    }
    const next = {
      rules,
      channelMode: ['all', 'only', 'except'].includes(input.channelMode) ? input.channelMode : 'all',
      channels: ids(input.channels), bypassRoles: ids(input.bypassRoles, 50), ignoredRoles: ids(input.ignoredRoles, 50),
    };
    this.store.set(`access:guild:${guildId}`, next);
    return next;
  }

  // Ignored = OzBot doesn't answer their commands or learn from them.
  ignored(userId, member) {
    if (this.global().ignoredUsers.includes(String(userId))) return true;
    const gid = member?.guild?.id;
    if (!gid) return false;
    const roles = this.guildConfig(gid).ignoredRoles;
    return roles.length > 0 && roles.some((r) => member.roles?.cache?.has(r));
  }

  // Top-level commands switched off for the whole server are not registered with Discord at all.
  offInGuild(guildId, name) { return this.guildConfig(guildId).rules[name]?.who === 'off'; }

  // Returns null when allowed (and records the use), or the message to show the user.
  check(i, cmd) {
    const sub = i.options.getSubcommand(false);
    const path = sub ? `${i.commandName} ${sub}` : i.commandName;
    if (sub && cmd.open?.includes(sub)) return null;
    const isAdmin = Boolean(i.memberPermissions?.has(PermissionFlagsBits.ManageGuild));
    if (this.ignored(i.user.id, i.member) && !isAdmin) return 'OzBot has been told not to respond to you.';
    if (!i.guildId) return null;
    const c = this.guildConfig(i.guildId);
    const name = `/${path}`;

    let rule = c.rules[path];
    if (sub && (!rule?.who || rule.who === 'inherit')) rule = { ...rule, who: c.rules[i.commandName]?.who ?? 'everyone', roles: c.rules[i.commandName]?.roles };
    const who = rule?.who ?? 'everyone';
    if (who === 'off') return `${name} is switched off in this server.`;
    if (who === 'admins' && !isAdmin) return `${name} is only for server managers.`;
    if (who === 'roles' && !isAdmin && !(rule.roles ?? []).some((r) => i.member?.roles?.cache?.has(r))) {
      const names = (rule.roles ?? []).map((r) => i.guild?.roles.cache.get(r)?.name).filter(Boolean);
      return `${name} is only for ${names.length ? names.map((n) => `**@${n}**`).join(' or ') : 'certain roles'}.`;
    }

    if (!isAdmin && c.channelMode !== 'all') {
      const ch = i.channel?.isThread?.() ? i.channel.parentId : i.channelId;
      const listed = c.channels.includes(ch) || c.channels.includes(i.channelId);
      if (c.channelMode === 'only' ? !listed : listed) {
        const allowed = c.channelMode === 'only' && c.channels.length ? ` Try ${c.channels.slice(0, 5).map((id) => `<#${id}>`).join(', ')}.` : '';
        return `OzBot’s commands don’t work in this channel.${allowed}`;
      }
    }

    const cooldown = this.cooldownFor(c, path);
    if (cooldown > 0 && !isAdmin && !c.bypassRoles.some((r) => i.member?.roles?.cache?.has(r))) {
      const key = `${i.user.id}|${path}`;
      const wait = (this.used.get(key) ?? 0) + cooldown * 1000 - Date.now();
      if (wait > 0) return `Slow down: you can use ${name} again <t:${Math.ceil((Date.now() + wait) / 1000)}:R>.`;
      this.used.set(key, Date.now());
      if (this.used.size > 5000) for (const [k, t] of this.used) if (Date.now() - t > MAX_COOLDOWN * 1000) this.used.delete(k);
    }
    return null;
  }

  cooldownFor(c, path) { return c.rules[path]?.cooldown ?? this.global().cooldowns[path] ?? 0; }
}
