import { afterEach, describe, expect, it, vi } from 'vitest';

import { fakeFetch, makeSink, record, respond } from './helpers.js';

function networkError(code: string): TypeError {
  return new TypeError('fetch failed', { cause: Object.assign(new Error('connect'), { code }) });
}

describe('ChargebeeSink retries', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries a transient status and then succeeds', async () => {
    const { fetch, calls } = fakeFetch((_call, index) => respond(index === 0 ? 503 : 202));

    const result = await makeSink({ fetch }).deliver([record()]);

    expect(result.outcome).toBe('accepted');
    expect(calls).toHaveLength(2);
  });

  it('retries a network error and then succeeds', async () => {
    const { fetch, calls } = fakeFetch((_call, index) => {
      if (index === 0) throw networkError('ECONNRESET');
      return respond(202);
    });

    expect((await makeSink({ fetch }).deliver([record()])).outcome).toBe('accepted');
    expect(calls).toHaveLength(2);
  });

  it('stops after the attempt budget on a transient status', async () => {
    const { fetch, calls } = fakeFetch(() => respond(503));

    const result = await makeSink({ fetch }).deliver([record()]);

    expect(result).toEqual({ outcome: 'retryable_failure', detail: 'http_503' });
    expect(calls).toHaveLength(3);
  });

  it('reports the network error code once retries are spent', async () => {
    const { fetch, calls } = fakeFetch(() => {
      throw networkError('ECONNREFUSED');
    });

    const result = await makeSink({ fetch, retry: { maxAttempts: 2 } }).deliver([record()]);

    expect(result).toEqual({ outcome: 'retryable_failure', detail: 'ECONNREFUSED' });
    expect(calls).toHaveLength(2);
  });

  it('reports an error without a system code by its class name', async () => {
    const { fetch } = fakeFetch(() => {
      throw new RangeError('boom');
    });

    const result = await makeSink({ fetch, retry: { maxAttempts: 1 } }).deliver([record()]);

    expect(result).toEqual({ outcome: 'retryable_failure', detail: 'RangeError' });
  });

  it('waits out Retry-After before the next attempt', async () => {
    vi.useFakeTimers();
    const { fetch, calls } = fakeFetch((_call, index) =>
      index === 0 ? respond(429, undefined, { 'Retry-After': '2' }) : respond(202),
    );
    const sink = makeSink({ fetch, retry: { initialBackoffMs: 100, maxBackoffMs: 30_000 } });

    const pending = sink.deliver([record()]);
    await vi.advanceTimersByTimeAsync(1999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);

    expect((await pending).outcome).toBe('accepted');
    expect(calls).toHaveLength(2);
  });
});
