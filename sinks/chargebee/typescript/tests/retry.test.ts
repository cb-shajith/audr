import { ConfigurationError } from 'audr';
import { describe, expect, it } from 'vitest';

import { parseRetryAfterMs, RetryPolicy } from '../src/retry.js';

const NOW = Date.parse('2026-09-23T12:00:00.000Z');

describe('RetryPolicy', () => {
  it.each([
    [400, 'permanent'],
    [401, 'credential'],
    [403, 'permanent'],
    [408, 'transient'],
    [429, 'transient'],
    [500, 'transient'],
    [502, 'transient'],
    [503, 'transient'],
    [504, 'transient'],
  ])('classifies %i as %s', (status, expected) => {
    expect(new RetryPolicy().classify(status)).toBe(expected);
  });

  it.each([1, 10])('jitters and caps the delay for attempt %i', (attempt) => {
    const policy = new RetryPolicy({ initialBackoffMs: 1000, maxBackoffMs: 3000, multiplier: 2 });

    for (let i = 0; i < 50; i += 1) {
      const delay = policy.delayMs(attempt);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(Math.min(3000, 1000 * 2 ** (attempt - 1)));
    }
  });

  it('never waits less than a valid Retry-After, up to maxBackoffMs', () => {
    const policy = new RetryPolicy({ initialBackoffMs: 100, maxBackoffMs: 30_000 });

    expect(policy.delayMs(1, '2', NOW)).toBe(2000);
    expect(policy.delayMs(1, '120', NOW)).toBe(30_000);
    expect(policy.delayMs(1, 'Wed, 23 Sep 2026 12:00:10 GMT', NOW)).toBe(10_000);
  });

  it('falls back to jitter for an unparseable or stale Retry-After', () => {
    const policy = new RetryPolicy({ initialBackoffMs: 1000 });

    expect(policy.delayMs(1, 'not a date', NOW)).toBeLessThanOrEqual(1000);
    expect(policy.delayMs(1, 'Wed, 23 Sep 2026 11:59:00 GMT', NOW)).toBeLessThanOrEqual(1000);
  });

  it.each([
    [{ maxAttempts: 0 }, 'maxAttempts must be at least 1'],
    [{ maxAttempts: 1.5 }, 'maxAttempts must be an integer'],
    [{ maxAttempts: true }, 'maxAttempts must be an integer'],
    [{ initialBackoffMs: -1 }, 'initialBackoffMs must be at least 0'],
    [{ initialBackoffMs: Number.NaN }, 'initialBackoffMs must be a finite number'],
    [{ maxBackoffMs: Infinity }, 'maxBackoffMs must be a finite number'],
    [{ maxBackoffMs: 2 ** 31 }, 'maxBackoffMs must be at most'],
    [{ multiplier: 0.5 }, 'multiplier must be at least 1'],
    [{ multiplier: '2' }, 'multiplier must be a finite number'],
  ])('rejects %o', (options, message) => {
    expect(() => new RetryPolicy(options as never)).toThrow(ConfigurationError);
    expect(() => new RetryPolicy(options as never)).toThrow(message);
  });
});

describe('parseRetryAfterMs', () => {
  it.each([
    [undefined, undefined],
    [null, undefined],
    ['0', 0],
    [' 3 ', 3000],
    ['-1', 0],
    ['soon', undefined],
    ['Wed, 23 Sep 2026 12:02:00 GMT', 120_000],
    // RFC 9110 allows -0000, which must read as UTC, not local time.
    ['Wed, 23 Sep 2026 12:02:00 -0000', 120_000],
    ['Wed, 23 Sep 2026 11:00:00 GMT', 0],
  ])('reads %j as %j', (value, expected) => {
    expect(parseRetryAfterMs(value, NOW)).toBe(expected);
  });
});
