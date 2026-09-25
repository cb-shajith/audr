import { describe, expect, it } from 'vitest';

import { InvalidUsageEventError, type UsageEvent, validateEvent } from '../src/event.js';

const TIMESTAMP = 1_788_422_400_123;

function event(overrides: Record<string, unknown> = {}): UsageEvent {
  return {
    subscription_id: 'sub_123',
    usage_timestamp: TIMESTAMP,
    deduplication_id: 'event-1',
    properties: { api_calls: 1 },
    ...overrides,
  };
}

describe('validateEvent', () => {
  it('accepts a flattened AUDR property set', () => {
    const valid = event({
      properties: {
        spec_version: '1.0.0',
        record_id: '01991f5e-7aa1-7b37-a315-2f6a58a91234',
        usage__llm__input_tokens: 120,
        apiCalls: 1, // the destination's pattern permits uppercase
        ratio: 1.5,
        billable: false,
        absent: null,
      },
    });

    expect(validateEvent(valid)).toBe(valid);
  });

  it('counts identifier lengths in code points', () => {
    expect(() => validateEvent(event({ subscription_id: '😀'.repeat(50) }))).not.toThrow();
  });

  it.each([
    [{ subscription_id: '' }, 'subscription_id must not be empty'],
    [{ subscription_id: '   ' }, 'subscription_id must not be empty'],
    [{ subscription_id: 123 }, 'subscription_id must be a string'],
    [{ subscription_id: 's'.repeat(51) }, 'subscription_id must be at most 50'],
    [{ deduplication_id: 123 }, 'deduplication_id must be a string'],
    [{ deduplication_id: '\t\n' }, 'deduplication_id must not be empty'],
    [{ deduplication_id: 'd'.repeat(37) }, 'deduplication_id must be at most 36'],
    [{ usage_timestamp: 1_788_422_400 }, '13-digit'], // epoch seconds
    [{ usage_timestamp: 17_884_224_001_234 }, '13-digit'],
    [{ usage_timestamp: 1.5 }, 'usage_timestamp must be an integer'],
    [{ usage_timestamp: Number.NaN }, 'usage_timestamp must be an integer'],
    [{ properties: {} }, 'properties must not be empty'],
    [{ properties: ['a'] }, 'properties must be a JSON object'],
    [{ properties: null }, 'properties must be a JSON object'],
  ])('rejects %o', (overrides, message) => {
    expect(() => validateEvent(event(overrides))).toThrow(InvalidUsageEventError);
    expect(() => validateEvent(event(overrides))).toThrow(message);
  });

  it.each([
    [{ '1_calls': 1 }, 'must start with a letter'],
    [{ 'api-calls': 1 }, 'must start with a letter'],
    [{ subscription_id: 'sub_123' }, 'is reserved'],
    [{ event_meta: 'x' }, 'is reserved'],
    [{ nested: { inner: 1 } }, 'got object'],
    [{ tags: ['a', 'b'] }, 'got array'],
  ])('rejects the properties %o', (properties, message) => {
    expect(() => validateEvent(event({ properties }))).toThrow(message);
  });

  it.each([Number.NaN, Infinity, -Infinity])('rejects the non-finite number %s', (ratio) => {
    expect(() => validateEvent(event({ properties: { ratio } }))).toThrow('finite JSON number');
  });

  it('names a bad property but never its value', () => {
    expect(() => validateEvent(event({ properties: { 'bad-name': 'sk_live_secret' } }))).toThrow(
      /^properties name 'bad-name'(?!.*sk_live_secret)/,
    );
  });
});
