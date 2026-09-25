import { describe, expect, it } from 'vitest';

import { InvalidUsageEventError } from '../src/event.js';
import { flatten } from '../src/flatten.js';
import { flattenRecord } from '../src/index.js';
import { record } from './helpers.js';

describe('flatten', () => {
  it('joins nested object keys with underscores', () => {
    expect(flatten({ a: { b: { c: 1 } }, d: 'x' })).toEqual({ a_b_c: 1, d: 'x' });
  });

  it.each([1, 1.5, 'text', true, false, null])('passes the scalar %j through', (value) => {
    expect(flatten({ field: value })).toEqual({ field: value });
  });

  it('stores an array as canonical JSON under a json suffix', () => {
    expect(flatten({ items: [3, 1, { b: 2, a: 1 }] })).toEqual({
      items_json: '[3,1,{"a":1,"b":2}]',
    });
  });

  it('keeps labels whole as sorted JSON rather than minting property names', () => {
    const flattened = flatten({ labels: { z: 'last', a: 'first' } });

    expect(flattened).toEqual({ labels_json: '{"a":"first","z":"last"}' });
    expect(flatten({ labels: { a: 1, b: 2 } })).toEqual(flatten({ labels: { b: 2, a: 1 } }));
  });

  it('does not escape non-ASCII label values', () => {
    expect(flatten({ labels: { team: 'Ümlaut' } })).toEqual({ labels_json: '{"team":"Ümlaut"}' });
  });

  it('drops undefined values and empty objects', () => {
    expect(flatten({ a: {}, b: 1, c: undefined, labels: { d: undefined, e: 'x' } })).toEqual({
      b: 1,
      labels_json: '{"e":"x"}',
    });
  });

  it('refuses a value that is not a JSON object', () => {
    expect(() => flatten(['not', 'an', 'object'])).toThrow('must encode to a JSON object');
  });

  it.each([
    [{ outer: { inner: new Date() } }, '/outer/inner'],
    [{ outer: { items: [() => 1] } }, '/outer/items'],
    [{ items: [Number.NaN] }, '/items'],
    [{ labels: { x: Infinity } }, '/labels'],
    [{ 'a/b': { 'c~d': Symbol('s') } }, '/a~1b/c~0d'],
  ])('refuses %o, naming its pointer', (value, pointer) => {
    expect(() => flatten(value)).toThrow(InvalidUsageEventError);
    expect(() => flatten(value)).toThrow(`field at ${pointer} is not JSON-encodable`);
  });
});

describe('flattenRecord', () => {
  it('flattens a real record into addressable scalar properties', () => {
    const flattened = flattenRecord(
      record({ account_id: 'acct_1', subscription_id: 'sub_1', labels: { team: 'billing' } }),
    );

    expect(flattened.usage_llm_input_tokens).toBe(10);
    expect(flattened.resource_type).toBe('model');
    expect(flattened.attribution_subscription_id).toBe('sub_1');
    expect(JSON.parse(String(flattened.attribution_labels_json))).toEqual({ team: 'billing' });
    for (const [key, value] of Object.entries(flattened)) {
      expect(key).toMatch(/^[a-zA-Z][a-zA-Z0-9_]*$/);
      expect(['string', 'number', 'boolean']).toContain(typeof value);
    }
  });

  it('uses the separator for the json suffix too', () => {
    const flattened = flattenRecord(record({ labels: { team: 'billing' } }), { separator: '__' });

    expect(flattened).toHaveProperty('usage__llm__input_tokens');
    expect(flattened).toHaveProperty('attribution__labels__json');
    expect(flattened).not.toHaveProperty('usage_llm_input_tokens');
  });
});
