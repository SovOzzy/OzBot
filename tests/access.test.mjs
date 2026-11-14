import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Access } from '../core/access.mjs';

function memStore(init = {}) {
  const m = new Map(Object.entries(init));
  return { get: (k, d) => (m.has(k) ? structuredClone(m.get(k)) : d), set: (k, v) => m.set(k, structuredClone(v)), raw: m };
}
const G = '100000000000000001';
function inter({ cmd, sub = null, user = '200000000000000001', roles = [], admin = false, channel = '300000000000000001' }) {
  return {
    commandName: cmd, guildId: G, channelId: channel, channel: { isThread: () => false },
    options: { getSubcommand: () => sub },
    user: { id: user },
    memberPermissions: { has: () => admin },
    member: { guild: { id: G }, roles: { cache: new Set(roles) } },
    guild: { roles: { cache: new Map([['900000000000000001', { name: 'Mods' }]]) } },
  };
}
const paths = new Set(['say', 'voice', 'voice set', 'voice list', 'markov', 'markov forget-me']);

test('roles, inherit, off, admins and privacy subcommands', () => {
  const a = new Access({ store: memStore(), log() {} });
  a.saveGuild(G, { rules: { voice: { who: 'roles', roles: ['900000000000000001'] }, say: { who: 'off' }, 'voice list': { who: 'everyone' }, markov: { who: 'off' } } }, paths);
  assert.match(a.check(inter({ cmd: 'voice', sub: 'set' }), {}), /only for \*\*@Mods\*\*/);
  assert.equal(a.check(inter({ cmd: 'voice', sub: 'set', roles: ['900000000000000001'] }), {}), null);
  assert.equal(a.check(inter({ cmd: 'voice', sub: 'list' }), {}), null);
  assert.match(a.check(inter({ cmd: 'say' }), {}), /switched off/);
  assert.match(a.check(inter({ cmd: 'say', admin: true }), {}), /switched off/);
  assert.equal(a.check(inter({ cmd: 'markov', sub: 'forget-me' }), { open: ['forget-me'] }), null);
  assert.equal(a.offInGuild(G, 'say'), true);
});

test('cooldowns: everywhere default, server override, bypass role, admins', () => {
  const a = new Access({ store: memStore(), log() {} });
  a.saveGlobal({ cooldowns: { say: 30, bogus: 5 } }, paths);
  assert.deepEqual(a.global().cooldowns, { say: 30 });
  assert.equal(a.check(inter({ cmd: 'say' }), {}), null);
  assert.match(a.check(inter({ cmd: 'say' }), {}), /Slow down.*<t:\d+:R>/);
  assert.equal(a.check(inter({ cmd: 'say', admin: true }), {}), null);
  a.saveGuild(G, { rules: { say: { cooldown: 0 } }, bypassRoles: [] }, paths);
  assert.equal(a.check(inter({ cmd: 'say' }), {}), null);
  a.saveGuild(G, { rules: { say: { cooldown: 60 } }, bypassRoles: ['900000000000000002'] }, paths);
  assert.equal(a.check(inter({ cmd: 'say', user: '200000000000000009', roles: ['900000000000000002'] }), {}), null);
  assert.equal(a.check(inter({ cmd: 'say', user: '200000000000000009', roles: ['900000000000000002'] }), {}), null);
});

test('channels and ignored users/roles', () => {
  const a = new Access({ store: memStore(), log() {} });
  a.saveGuild(G, { channelMode: 'only', channels: ['300000000000000002'], ignoredRoles: ['900000000000000003'] }, paths);
  assert.match(a.check(inter({ cmd: 'say' }), {}), /don’t work in this channel/);
  assert.equal(a.check(inter({ cmd: 'say', channel: '300000000000000002' }), {}), null);
  assert.match(a.check(inter({ cmd: 'say', channel: '300000000000000002', roles: ['900000000000000003'] }), {}), /not to respond/);
  a.saveGlobal({ ignoredUsers: ['200000000000000005', 'junk'] }, paths);
  assert.deepEqual(a.global().ignoredUsers, ['200000000000000005']);
  assert.equal(a.ignored('200000000000000005', null), true);
});

test('old Voice chat role moves into the server rules once', () => {
  const store = memStore({ 'module:voice:settings': { voiceChangeRole: '900000000000000001' } });
  const a = new Access({ store, log() {} });
  assert.deepEqual(a.guildConfig(G).rules['voice set'], { who: 'roles', roles: ['900000000000000001'] });
  assert.ok(store.raw.has(`access:guild:${G}`));
});
