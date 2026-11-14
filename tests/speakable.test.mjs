import { test } from 'node:test';
import assert from 'node:assert/strict';
import { speakable } from '../modules/voice/index.mjs';

test('speakable drops urls, emoji and markdown', () => {
  assert.equal(speakable('**hi** 😂 there https://a.b/c <:pog:12345678> <@1234567>'), 'hi there');
  assert.equal(speakable('a'.repeat(700)).length, 600);
});
