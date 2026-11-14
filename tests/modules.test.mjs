// ModuleManager against a fake bot + temp module folder: dependency order, blocking, auto-fault, cleanup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { ModuleManager } from '../core/modules.mjs';
import { openStore } from '../core/store.mjs';

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'ozbot-test-'));
  const mod = (id, manifest, code) => {
    mkdirSync(join(root, 'modules', id), { recursive: true });
    writeFileSync(join(root, 'modules', id, 'manifest.json'), JSON.stringify({ id, name: id, settings: [], ...manifest }));
    writeFileSync(join(root, 'modules', id, 'index.mjs'), code);
  };
  mod('lib', { provides: ['thing'] }, `export default { start(ctx) { ctx.provide('thing', { hi: () => 'hi' }); } };`);
  mod('user', { requires: ['thing'] }, `export default { start(ctx) { ctx.on('boom', () => { throw new Error('kaboom'); }); globalThis.used = ctx.use('thing').hi(); } };`);
  mod('bad', {}, `export default { start() { throw new Error('nope'); } };`);
  const store = openStore(join(root, 'data'));
  const client = new EventEmitter();
  const bot = { client, guild: () => null };
  const mgr = new ModuleManager({ root, dataDir: join(root, 'data'), store, bot, tts: null, log: () => {} });
  return { mgr, client, store };
}

const statuses = (mgr) => Object.fromEntries(mgr.list().map((m) => [m.id, m.status]));

test('dependencies, blocking, start failure, auto-fault and cleanup', async () => {
  const { mgr, client } = setup();
  await mgr.load();
  await mgr.startAll();
  assert.deepEqual(statuses(mgr), { bad: 'faulted', lib: 'on', user: 'on' });
  assert.equal(globalThis.used, 'hi');
  assert.equal(client.listenerCount('boom'), 1);

  await mgr.setEnabled('lib', false);
  assert.deepEqual(statuses(mgr), { bad: 'faulted', lib: 'off', user: 'blocked' });
  assert.equal(client.listenerCount('boom'), 0, 'listeners removed when stopped');

  await mgr.setEnabled('lib', true);
  assert.equal(statuses(mgr).user, 'on');
  for (let i = 0; i < 5; i++) client.emit('boom');
  await new Promise((r) => setTimeout(r, 20));
  await mgr.busy;
  assert.equal(statuses(mgr).user, 'faulted');
  assert.equal(mgr.enabled('user'), false);
  assert.match(mgr.list().find((m) => m.id === 'user').error, /kaboom/);
  assert.equal(client.listenerCount('boom'), 0);

  await mgr.setEnabled('user', true);
  assert.equal(statuses(mgr).user, 'on', 'switching back on clears the fault');
  clearTimeout(mgr.commandTimer);
});
