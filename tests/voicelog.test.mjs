import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import voicelog, { formatLine } from '../modules/voicelog/index.mjs';

test('formatLine fills placeholders and trims a dangling dash', () => {
  const item = { text: 'foo bar', voiceName: 'Oz', user: { name: 'Liam' }, source: 'speak' };
  assert.equal(formatLine('"{text}" - {voice}', item), '"foo bar" - Oz');
  assert.equal(formatLine('{text} ({source}, asked by {user})', item), 'foo bar (/speak, asked by Liam)');
  assert.equal(formatLine('', item), '"foo bar" - Oz');
  assert.equal(formatLine('"{text}" - {user}', { ...item, user: null }), '"foo bar"');
});

test('voice:spoken -> post with quote and mp3, no buttons; temp mp3 removed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ozbot-vl-'));
  const wav = join(dir, 'line.wav');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-ar', '22050', '-ac', '1', wav]);
  const sent = [];
  const channel = {
    name: 'markovs-vc-quotes', guild: { members: { me: {} } },
    permissionsFor: () => ({ has: () => true }),
    async send(msg) {
      const f = msg.files?.[0];
      sent.push({ ...msg, fileExisted: f ? existsSync(f.attachment) : null, fileSize: f ? statSync(f.attachment).size : 0 });
      return { id: '999' };
    },
  };
  const subs = {}; const services = {};
  const settings = { channel: '123456789', format: '"{text}" - {voice}', attachAudio: true,
    postRandom: true, postSpeak: true, postSay: true, postGreeting: false, sessionNotes: true };
  const ctx = {
    db: new DatabaseSync(':memory:'), settings, log: () => {},
    guild: () => ({ channels: { cache: { get: (id) => (id === '123456789' ? channel : undefined) } } }),
    subscribe: (ev, fn) => { subs[ev] = fn; }, provide: (n, api) => { services[n] = api; },
  };
  await voicelog.start(ctx);

  const payload = { text: 'foo bar', voiceId: 'en_GB-oz-medium', voiceName: 'Oz', source: 'speak', user: { name: 'Liam' }, wav, holds: [] };
  subs['voice:spoken'](payload);
  assert.equal(payload.holds.length, 1, 'Voice log asked Voice chat to keep the wav');
  await Promise.all(payload.holds);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].content, '"foo bar" - Oz');
  assert.equal(sent[0].files[0].name.endsWith('.mp3'), true);
  assert.equal(sent[0].fileExisted, true);
  assert.ok(sent[0].fileSize > 1000, 'mp3 has audio');
  assert.equal(sent[0].components, undefined, 'no buttons on the post');
  assert.equal(existsSync(sent[0].files[0].attachment), false, 'temp mp3 deleted after upload');

  // greeting is off by default; join/leave notes on
  subs['voice:spoken']({ ...payload, source: 'greeting', holds: [] });
  subs['voice:joined']({ channel: { name: 'TheRoundTable' } });
  subs['voice:left']({ channel: { name: 'TheRoundTable' }, durationMs: 80 * 60e3, lines: 14 });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(sent.slice(1).map((m) => m.content), ['🔊 Joined **TheRoundTable**', '👋 Left **TheRoundTable** after 1 h 20 min, said 14 lines']);
  assert.equal(services.voicelog.posts('speak'), true);
  assert.equal(services.voicelog.posts('greeting'), false);
});
