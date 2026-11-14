import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Chain, cleanMessage } from '../modules/markov/chain.mjs';

const seeded = (seed = 1) => () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

test('cleanMessage strips links, mentions, emoji, markdown', () => {
  assert.equal(cleanMessage('hey <@123456789> look https://x.com/a **now** <:pog:998877665544>'), 'hey look now');
  assert.equal(cleanMessage('keep <@123> please', { stripMentions: false }), 'keep <@123> please');
});

test('chain generates sentences made of learned words, not verbatim copies', () => {
  const c = new Chain(1);
  for (const m of ['the cat sat on the mat', 'the dog sat on the log', 'a cat ate the fish', 'the fish swam far away']) c.add(m);
  const vocab = new Set('the cat sat on mat dog log a ate fish swam far away'.split(' '));
  for (let i = 0; i < 30; i++) {
    const s = c.generate({ minWords: 3, maxWords: 12, rand: seeded(i + 1) });
    if (!s) continue;
    for (const w of s.split(' ')) assert.ok(vocab.has(w), w);
    assert.ok(!c.seen.has(Chain.norm(s)) || s.split(' ').length < 3);
  }
});

test('about picks a sentence containing the word', () => {
  const c = new Chain(2);
  for (const m of ['pizza is the best food', 'i like cold pizza a lot', 'burgers are fine too honestly']) c.add(m);
  const s = c.generate({ about: 'pizza', minWords: 2, allowCopy: true, rand: seeded(3) });
  assert.match(s, /pizza/);
  assert.equal(c.generate({ about: 'zebra' }), null);
});

test('empty chain returns null; one-word messages are ignored', () => {
  const c = new Chain(2);
  assert.equal(c.generate(), null);
  assert.equal(c.add('lol'), false);
  assert.equal(c.size, 0);
});
