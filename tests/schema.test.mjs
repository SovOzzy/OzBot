import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coerce, defaults } from '../core/schema.mjs';

const fields = [
  { key: 'n', type: 'number', default: 5, min: 1, max: 10, step: 1 },
  { key: 'b', type: 'boolean', default: true },
  { key: 'sel', type: 'select', default: 2, options: [{ value: 1 }, { value: 2 }] },
  { key: 'chans', type: 'textChannels', default: [] },
  { key: 'vc', type: 'voiceChannel', default: '' },
  { key: 't', type: 'text', default: 'x', maxLength: 5 },
];

test('defaults', () => assert.deepEqual(defaults(fields), { n: 5, b: true, sel: 2, chans: [], vc: '', t: 'x' }));

test('coerce clamps, converts and validates', () => {
  const { values, errors } = coerce(fields, { n: '99', b: 'false', sel: '1', chans: ['123456789', '123456789'], vc: '', t: 'abc' });
  assert.deepEqual(errors, {});
  assert.deepEqual(values, { n: 10, b: false, sel: 1, chans: ['123456789'], vc: '', t: 'abc' });
});

test('coerce reports bad values and keeps the old ones', () => {
  const { values, errors } = coerce(fields, { sel: 7, chans: ['nope'], vc: 'x', t: 'too long!' }, { sel: 2 });
  assert.deepEqual(Object.keys(errors).sort(), ['chans', 'sel', 't', 'vc']);
  assert.equal(values.sel, 2);
});

test('unknown keys are ignored', () => assert.equal('evil' in coerce(fields, { evil: 1 }).values, false));
