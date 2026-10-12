/**
 * Lago validates a request atomically: one invalid event fails the whole request with a
 * `422` that names the offenders by position, and nothing is stored. The sink settles the
 * events the response names and resends the rest.
 */
import { describe, expect, it } from 'vitest';

import {
  alreadyHeld,
  fakeFetch,
  makeSink,
  record,
  recordingLogger,
  records,
  respond,
  validation,
} from './helpers.js';

const BAD_TIME = { timestamp: ['invalid_format'] };
const NO_CODE = { code: ['value_is_mandatory'] };

const idsOf = (calls: { events: { transaction_id: string }[] }[], call: number): string[] =>
  calls[call]?.events.map((event) => event.transaction_id) ?? [];

describe('LagoSink 422 handling', () => {
  it('rejects the events the response names and resends the others', async () => {
    const batch = records(5);
    const { fetch, calls } = fakeFetch((_call, index) =>
      index === 0 ? validation({ 1: BAD_TIME, 3: NO_CODE }) : respond(200),
    );

    const result = await makeSink({ fetch }).deliver(batch);

    expect(result).toEqual({
      outcome: 'accepted',
      rejected: [
        { recordId: batch[1]?.record_id, detail: 'timestamp:invalid_format' },
        { recordId: batch[3]?.record_id, detail: 'code:value_is_mandatory' },
      ],
    });
    expect(calls).toHaveLength(2);
    expect(idsOf(calls, 1)).toEqual([0, 2, 4].map((i) => batch[i]?.record_id));
  });

  it('resends each surviving event exactly as it first went out', async () => {
    const batch = records(4);
    const { fetch, calls } = fakeFetch((_call, index) =>
      index === 0 ? validation({ 0: BAD_TIME }) : respond(200),
    );

    await makeSink({ fetch }).deliver(batch);

    const first = calls[0]?.events.slice(1).map((event) => JSON.stringify(event));
    const second = calls[1]?.events.map((event) => JSON.stringify(event));
    expect(second).toEqual(first);
  });

  it('answers a batch in which every event is invalid without a second request', async () => {
    const batch = records(3);
    const { fetch, calls } = fakeFetch(() => validation({ 0: BAD_TIME, 1: NO_CODE, 2: BAD_TIME }));

    expect(await makeSink({ fetch }).deliver(batch)).toEqual({
      outcome: 'accepted',
      rejected: [
        { recordId: batch[0]?.record_id, detail: 'timestamp:invalid_format' },
        { recordId: batch[1]?.record_id, detail: 'code:value_is_mandatory' },
        { recordId: batch[2]?.record_id, detail: 'timestamp:invalid_format' },
      ],
    });
    expect(calls).toHaveLength(1);
  });

  it('takes a replay Lago already holds as accepted, without resending anything', async () => {
    const batch = records(3);
    const { fetch, calls } = fakeFetch(() => alreadyHeld(0, 1, 2));

    expect(await makeSink({ fetch }).deliver(batch)).toEqual({ outcome: 'accepted', rejected: [] });
    expect(calls).toHaveLength(1);
  });

  it('resends the events of a batch that was partly held already', async () => {
    const batch = records(4);
    const { fetch, calls } = fakeFetch((_call, index) =>
      index === 0 ? alreadyHeld(1, 2) : respond(200),
    );

    expect(await makeSink({ fetch }).deliver(batch)).toEqual({ outcome: 'accepted', rejected: [] });
    expect(idsOf(calls, 1)).toEqual([0, 3].map((i) => batch[i]?.record_id));
  });

  it('separates duplicates from invalid events in one response', async () => {
    const batch = records(4);
    const { fetch, calls } = fakeFetch((_call, index) =>
      index === 0
        ? validation({ 0: { transaction_id: ['value_already_exist'] }, 2: BAD_TIME })
        : respond(200),
    );

    expect(await makeSink({ fetch }).deliver(batch)).toEqual({
      outcome: 'accepted',
      rejected: [{ recordId: batch[2]?.record_id, detail: 'timestamp:invalid_format' }],
    });
    expect(idsOf(calls, 1)).toEqual([1, 3].map((i) => batch[i]?.record_id));
  });

  it('rejects an event that is a duplicate and also invalid', async () => {
    const batch = records(2);
    const { fetch } = fakeFetch((_call, index) =>
      index === 0
        ? validation({
            0: { transaction_id: ['value_already_exist'], timestamp: ['invalid_format'] },
          })
        : respond(200),
    );

    expect(await makeSink({ fetch }).deliver(batch)).toEqual({
      outcome: 'accepted',
      rejected: [{ recordId: batch[0]?.record_id, detail: 'timestamp:invalid_format' }],
    });
  });

  it('rejects an event whose metric expression failed and resends the others', async () => {
    const batch = records(5);
    const { fetch, calls } = fakeFetch((_call, index) =>
      index === 0
        ? validation({ 3: 'expression_evaluation_failed: Variable: sk-live-secret not found' })
        : respond(200),
    );

    const result = await makeSink({ fetch }).deliver(batch);

    expect(result).toEqual({
      outcome: 'accepted',
      rejected: [{ recordId: batch[3]?.record_id, detail: 'event:expression_evaluation_failed' }],
    });
    expect(idsOf(calls, 1)).toEqual([0, 1, 2, 4].map((i) => batch[i]?.record_id));
  });

  it('names an unlisted error code or field only by a fixed fallback', async () => {
    const batch = records(2);
    const { fetch } = fakeFetch((_call, index) =>
      index === 0
        ? validation({
            0: { timestamp: ['sk-live-secret'] },
            1: { 'account-secret': ['invalid_format'] },
          })
        : respond(200),
    );

    const result = await makeSink({ fetch }).deliver(batch);

    expect(result).toEqual({
      outcome: 'accepted',
      rejected: [
        { recordId: batch[0]?.record_id, detail: 'timestamp:validation_error' },
        { recordId: batch[1]?.record_id, detail: 'event:invalid_format' },
      ],
    });
  });

  describe('a body that cannot be matched to the request', () => {
    it.each([
      ['a position beyond the request', { 7: BAD_TIME }],
      ['a position that is not a number', { first: BAD_TIME }],
      ['a position written with a leading zero', { '01': BAD_TIME }],
      ['an entry that is neither an object nor a message', { 0: 42 }],
      ['no entries', {}],
    ])('fails the request permanently for %s', async (_name, details) => {
      const batch = records(3);
      const { fetch, calls } = fakeFetch(() => validation(details as never));

      expect(await makeSink({ fetch }).deliver(batch)).toEqual({
        outcome: 'permanent_failure',
        detail: 'http_422',
      });
      expect(calls).toHaveLength(1);
    });

    it.each([
      ['no error_details', respond(422, { status: 422, error: 'Unprocessable Entity' })],
      ['an error_details array', respond(422, { error_details: [{ code: ['invalid_format'] }] })],
      ['a body that is not JSON', respond(422, '<html>nope</html>')],
      ['an empty body', respond(422)],
      ['a null body', respond(422, 'null')],
    ])('fails the request permanently for %s', async (_name, response) => {
      const { fetch } = fakeFetch(() => response.clone());

      expect(await makeSink({ fetch }).deliver([record()])).toEqual({
        outcome: 'permanent_failure',
        detail: 'http_422',
      });
    });

    it('fails permanently for a body that errors while it is read', async () => {
      const body = new ReadableStream({
        pull(controller) {
          controller.error(new Error('connection reset'));
        },
      });
      const { fetch } = fakeFetch(() => new Response(body, { status: 422 }));

      expect(await makeSink({ fetch }).deliver([record()])).toEqual({
        outcome: 'permanent_failure',
        detail: 'http_422',
      });
    });

    it('logs the failure without the body', async () => {
      const logger = recordingLogger();
      const sink = makeSink({
        fetch: fakeFetch(() => respond(422, { error_details: 'sk-live-secret' })).fetch,
        logger,
      });

      await sink.deliver(records(2));

      expect(logger.lines).toEqual([
        'warn: audr-sink-lago: the validation response could not be matched to the request (events=2, passes=0)',
      ]);
    });

    it('fails permanently when one entry names a position outside the request', async () => {
      const { fetch, calls } = fakeFetch(() => validation({ 0: BAD_TIME, 9: BAD_TIME }));

      expect(await makeSink({ fetch }).deliver(records(3))).toEqual({
        outcome: 'permanent_failure',
        detail: 'http_422',
      });
      expect(calls).toHaveLength(1);
    });

    it('keeps an earlier rejection and rejects the rest when a later 422 does not match', async () => {
      const batch = records(3);
      const { fetch } = fakeFetch((_call, index) =>
        index === 0 ? validation({ 0: BAD_TIME }) : validation({ 9: BAD_TIME }),
      );

      expect(await makeSink({ fetch }).deliver(batch)).toEqual({
        outcome: 'accepted',
        rejected: [
          { recordId: batch[0]?.record_id, detail: 'timestamp:invalid_format' },
          { recordId: batch[1]?.record_id, detail: 'http_422' },
          { recordId: batch[2]?.record_id, detail: 'http_422' },
        ],
      });
    });
  });

  describe('a request above the instance limit', () => {
    const tooMany = (): Response =>
      respond(422, {
        status: 422,
        error: 'Unprocessable Entity',
        code: 'validation_errors',
        error_details: { events: ['too_many_events'] },
      });

    it('fails permanently with too_many_events and names the lever', async () => {
      const logger = recordingLogger();
      const { fetch, calls } = fakeFetch(tooMany);

      expect(await makeSink({ fetch, logger }).deliver(records(30))).toEqual({
        outcome: 'permanent_failure',
        detail: 'too_many_events',
      });
      expect(calls).toHaveLength(1);
      expect(logger.lines).toEqual([
        'warn: audr-sink-lago: Lago refused the request as too many events (events=30); ' +
          'lower Client batchMaxSize to the LAGO_EVENTS_BATCH_MAX_LENGTH of the Lago instance',
      ]);
    });

    it('rejects the records of the refused request when an earlier one was accepted', async () => {
      const batch = records(150);
      const { fetch } = fakeFetch((_call, index) => (index === 0 ? respond(200) : tooMany()));

      expect(await makeSink({ fetch }).deliver(batch)).toEqual({
        outcome: 'accepted',
        rejected: batch.slice(100).map((entry) => ({
          recordId: entry.record_id,
          detail: 'too_many_events',
        })),
      });
    });
  });

  describe('bounded salvage', () => {
    it('gives up on the fourth 422 for one request, having removed an event each pass', async () => {
      const batch = records(6);
      const logger = recordingLogger();
      const { fetch, calls } = fakeFetch(() => validation({ 0: BAD_TIME }));

      const result = await makeSink({ fetch, logger }).deliver(batch);

      expect(calls.map((call) => call.events.length)).toEqual([6, 5, 4, 3]);
      expect(result).toEqual({
        outcome: 'accepted',
        rejected: [0, 1, 2].map((i) => ({
          recordId: batch[i]?.record_id,
          detail: 'timestamp:invalid_format',
        })),
        unknown: [3, 4, 5].map((i) => batch[i]?.record_id),
      });
      expect(logger.lines.at(-1)).toBe(
        'warn: audr-sink-lago: Lago refused the request again after 3 resend(s); ' +
          'its remaining events are unknown (events=3)',
      );
    });

    it('settles a request that needs exactly three passes', async () => {
      const batch = records(5);
      const { fetch, calls } = fakeFetch((_call, index) =>
        index < 3 ? validation({ 0: BAD_TIME }) : respond(200),
      );

      const result = await makeSink({ fetch }).deliver(batch);

      expect(calls.map((call) => call.events.length)).toEqual([5, 4, 3, 2]);
      expect(result).toMatchObject({ outcome: 'accepted' });
      expect(result).not.toHaveProperty('unknown');
      expect(result).toHaveProperty('rejected.length', 3);
    });

    it('counts passes for each request on its own', async () => {
      const batch = records(200);
      const seen = { first: 0, second: 0 };
      const { fetch, calls } = fakeFetch((call) => {
        const inSecond = call.events.some(
          (event) => event.transaction_id === batch[150]?.record_id,
        );
        const key = inSecond ? 'second' : 'first';
        seen[key] += 1;
        return seen[key] <= 3 ? validation({ 0: BAD_TIME }) : respond(200);
      });

      const result = await makeSink({ fetch }).deliver(batch);

      expect(calls.map((call) => call.events.length)).toEqual([100, 99, 98, 97, 100, 99, 98, 97]);
      expect(result).toMatchObject({ outcome: 'accepted' });
      expect(result).not.toHaveProperty('unknown');
      expect(result).toHaveProperty('rejected.length', 6);
    });

    it("does not carry a request's retry budget into its resend", async () => {
      const batch = records(3);
      const { fetch, calls } = fakeFetch((_call, index) => {
        if (index === 0) return validation({ 0: BAD_TIME });
        return index < 3 ? respond(503) : respond(200);
      });

      const result = await makeSink({ fetch }).deliver(batch);

      expect(calls).toHaveLength(4);
      expect(calls[1]?.text).toBe(calls[2]?.text);
      expect(calls[2]?.text).toBe(calls[3]?.text);
      expect(result).toEqual({
        outcome: 'accepted',
        rejected: [{ recordId: batch[0]?.record_id, detail: 'timestamp:invalid_format' }],
      });
    });

    it('stops with the survivors unknown when a resend then fails', async () => {
      const batch = records(4);
      const { fetch } = fakeFetch((_call, index) =>
        index === 0 ? validation({ 1: BAD_TIME }) : respond(503),
      );

      expect(await makeSink({ fetch }).deliver(batch)).toEqual({
        outcome: 'accepted',
        rejected: [{ recordId: batch[1]?.record_id, detail: 'timestamp:invalid_format' }],
        unknown: [0, 2, 3].map((i) => batch[i]?.record_id),
      });
    });
  });

  describe('across requests', () => {
    it('salvages the first request and sends the second', async () => {
      const batch = records(150);
      const { fetch, calls } = fakeFetch((_call, index) =>
        index === 0 ? validation({ 5: BAD_TIME }) : respond(200),
      );

      const result = await makeSink({ fetch }).deliver(batch);

      expect(calls.map((call) => call.events.length)).toEqual([100, 99, 50]);
      expect(result).toEqual({
        outcome: 'accepted',
        rejected: [{ recordId: batch[5]?.record_id, detail: 'timestamp:invalid_format' }],
      });
    });

    it('keeps the first request accepted and rejects the second when it cannot be matched', async () => {
      const batch = records(150);
      const { fetch } = fakeFetch((_call, index) =>
        index === 0 ? respond(200) : respond(422, 'junk'),
      );

      expect(await makeSink({ fetch }).deliver(batch)).toEqual({
        outcome: 'accepted',
        rejected: batch.slice(100).map((entry) => ({
          recordId: entry.record_id,
          detail: 'http_422',
        })),
      });
    });

    it('counts a record held already as settled, so a later failure does not relabel it', async () => {
      const batch = records(150);
      const { fetch } = fakeFetch((_call, index) =>
        index === 0 ? alreadyHeld(...Array.from({ length: 100 }, (_, i) => i)) : respond(503),
      );

      expect(await makeSink({ fetch }).deliver(batch)).toEqual({
        outcome: 'accepted',
        rejected: [],
        unknown: batch.slice(100).map((entry) => entry.record_id),
      });
    });
  });
});
