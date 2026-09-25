/**
 * A record may be reported sent only when Chargebee said so. Anything else is rejected
 * (definitively refused) or unknown (replay is safe because `record_id` is the
 * de-duplication key). Guessing in either direction is a billing discrepancy.
 */
import { describe, expect, it } from 'vitest';

import { fakeFetch, makeSink, record, recordingLogger, respond } from './helpers.js';

function answering(response: () => Response): {
  sink: ReturnType<typeof makeSink>;
  logger: ReturnType<typeof recordingLogger>;
} {
  const logger = recordingLogger();
  return { sink: makeSink({ fetch: fakeFetch(response).fetch, logger }), logger };
}

describe('ChargebeeSink responses', () => {
  it.each([
    () => respond(202, 'not json'),
    () => respond(202, { failed_events: [{ deduplication_id: 'unknown' }] }),
  ])('takes a 202 as full acceptance without reading the body', async (response) => {
    const { sink } = answering(response);

    expect(await sink.deliver([record()])).toEqual({
      outcome: 'accepted',
      rejected: [],
      unknown: undefined,
    });
  });

  it('correlates 207 rejections by record_id, with the first error code field', async () => {
    const first = record();
    const second = record();
    const third = record();
    const { sink } = answering(() =>
      respond(207, {
        failed_events: [
          { deduplication_id: second.record_id, api_error_code: 'bad', error_code: 'x' },
          { deduplication_id: third.record_id, code: 42 },
        ],
      }),
    );

    expect(await sink.deliver([first, second, third])).toEqual({
      outcome: 'accepted',
      rejected: [
        { recordId: second.record_id, detail: 'bad' },
        { recordId: third.record_id, detail: '42' },
      ],
      unknown: undefined,
    });
  });

  it('rejects a record with no recognised error code field, without a detail', async () => {
    const sent = record();
    const { sink } = answering(() =>
      respond(207, { failed_events: [{ deduplication_id: sent.record_id, note: 'nope' }] }),
    );

    expect(await sink.deliver([sent])).toMatchObject({
      rejected: [{ recordId: sent.record_id, detail: undefined }],
    });
  });

  it('rejects every record sharing a failed id', async () => {
    const first = record({}, { record_id: 'shared-id' });
    const second = record({}, { record_id: 'shared-id' });
    const { sink } = answering(() =>
      respond(207, { failed_events: [{ deduplication_id: 'shared-id', api_error_code: 'bad' }] }),
    );

    const result = await sink.deliver([first, second]);

    expect(result).toMatchObject({
      rejected: [{ recordId: 'shared-id' }, { recordId: 'shared-id' }],
    });
  });

  it.each([
    ['an unknown id', { deduplication_id: 'unknown' }],
    ['a non-object entry', 'not-an-object'],
    ['a non-string id', { deduplication_id: 42 }],
  ])('marks the unresolved records unknown on %s', async (_label, entry) => {
    const first = record();
    const second = record();
    const { sink, logger } = answering(() =>
      respond(207, {
        failed_events: [{ deduplication_id: second.record_id, api_error_code: 'bad' }, entry],
      }),
    );

    const result = await sink.deliver([first, second]);

    expect(result).toEqual({
      outcome: 'accepted',
      rejected: [{ recordId: second.record_id, detail: 'bad' }],
      unknown: [first.record_id],
    });
    expect(logger.lines).toEqual([
      'warn: audr-sink-chargebee: Chargebee batch had 1 unattributable failed_events rejection(s) (batch_size=2)',
    ]);
  });

  it('counts the same id rejected twice once, and marks the rest unknown', async () => {
    const first = record();
    const second = record();
    const rejection = { deduplication_id: first.record_id, api_error_code: 'bad' };
    const { sink } = answering(() => respond(207, { failed_events: [rejection, rejection] }));

    expect(await sink.deliver([first, second])).toEqual({
      outcome: 'accepted',
      rejected: [{ recordId: first.record_id, detail: 'bad' }],
      unknown: [second.record_id],
    });
  });

  it.each([
    () => respond(207, 'not json'),
    () => respond(207, { ok: true }),
    () => respond(207, [1, 2]),
  ])('marks the batch unknown when a 207 body is unusable', async (response) => {
    const sent = record();
    const { sink, logger } = answering(response);

    expect(await sink.deliver([sent])).toEqual({
      outcome: 'accepted',
      rejected: [],
      unknown: [sent.record_id],
    });
    expect(logger.lines.join()).toContain('partial response was unparseable');
  });

  it('fails the batch permanently on 401, without key material', async () => {
    const { sink, logger } = answering(() => respond(401, { code: 'unauthorized' }));

    const result = await sink.deliver([record()]);

    expect(result).toEqual({ outcome: 'permanent_failure', detail: 'auth' });
    expect(logger.lines).toEqual([
      'error: audr-sink-chargebee: the API key was rejected for https://acme.ingest.chargebee.com (status 401)',
    ]);
    expect(JSON.stringify([result, logger.lines])).not.toContain('test_key');
  });

  it('fails the batch permanently on 413, naming the caller lever, without retrying', async () => {
    const logger = recordingLogger();
    const { fetch, calls } = fakeFetch(() => respond(413));

    const result = await makeSink({ fetch, logger }).deliver([record(), record()]);

    expect(result).toEqual({ outcome: 'permanent_failure', detail: 'payload_too_large' });
    expect(calls).toHaveLength(1);
    expect(logger.lines.join()).toContain('(batch_size=2); lower Client batchMaxSize');
  });

  it.each([200, 204, 302, 400, 403])('fails the batch permanently on %i', async (status) => {
    const { sink, logger } = answering(() => respond(status));

    expect(await sink.deliver([record()])).toEqual({
      outcome: 'permanent_failure',
      detail: `http_${status}`,
    });
    expect(logger.lines).toEqual([
      `warn: audr-sink-chargebee: batch rejected permanently (status=${status})`,
    ]);
  });

  it('keeps reporting when the logger throws', async () => {
    const throwing = {
      warn: () => {
        throw new Error('logger down');
      },
      error: () => {
        throw new Error('logger down');
      },
    };
    const sink = makeSink({ fetch: fakeFetch(() => respond(413)).fetch, logger: throwing });

    expect(await sink.deliver([record()])).toMatchObject({ detail: 'payload_too_large' });
    const auth = makeSink({ fetch: fakeFetch(() => respond(401)).fetch, logger: throwing });
    expect(await auth.deliver([record()])).toMatchObject({ detail: 'auth' });
  });
});
