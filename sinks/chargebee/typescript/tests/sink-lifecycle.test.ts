import { assertSinkContract } from 'audr/testing';
import { describe, expect, it } from 'vitest';

import { ChargebeeSink } from '../src/index.js';
import {
  fakeFetch,
  hangingFetch,
  makeSink,
  ORIGIN,
  record,
  recordingLogger,
  respond,
  settle,
} from './helpers.js';

describe('ChargebeeSink lifecycle', () => {
  it('satisfies the sink contract', async () => {
    // 202 is full acceptance. Records carry a subscription_id so they are really sent.
    const sink = makeSink({ fetch: fakeFetch(() => respond(202)).fetch });

    await assertSinkContract(sink, { records: [record(), record(), record()] });
  });

  it('is terminal and idempotent once closed', async () => {
    const { fetch, calls } = fakeFetch(() => respond(202));
    const sink = makeSink({ fetch });
    await sink.deliver([record()]);

    await sink.close();
    await sink.close();

    expect(await sink.deliver([record()])).toEqual({ outcome: 'closed' });
    expect(calls).toHaveLength(1);
  });

  it('reports closed, not a transport failure, when closed mid-request', async () => {
    const logger = recordingLogger();
    const sink = makeSink({ fetch: hangingFetch(), logger });
    const pending = sink.deliver([record()]);
    await settle();

    await sink.close();

    expect(await pending).toEqual({ outcome: 'closed' });
    expect(logger.lines).toEqual([
      'warn: audr-sink-chargebee: the sink is closed; batch not delivered',
    ]);
  });

  it('stops waiting for a retry when closed during the backoff', async () => {
    const { fetch, calls } = fakeFetch(() => respond(503, undefined, { 'Retry-After': '60' }));
    const sink = makeSink({ fetch, retry: { maxBackoffMs: 60_000 } });
    const pending = sink.deliver([record()]);
    await settle();

    await sink.close();

    expect(await pending).toEqual({ outcome: 'closed' });
    expect(calls).toHaveLength(1);
  });

  it('sends through the global fetch by default, which tests block', async () => {
    const sink = new ChargebeeSink({
      ingestUrl: ORIGIN,
      apiKey: 'test_key',
      retry: { maxAttempts: 1 },
    });

    expect(await sink.deliver([record()])).toEqual({
      outcome: 'retryable_failure',
      detail: 'LiveNetworkBlocked',
    });
    expect(globalThis.fetch).toHaveBeenCalledOnce();
  });
});
