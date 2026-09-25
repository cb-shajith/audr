import { type Attribution, type AudrRecord, type RecordInput } from 'audr';
import { makeRecord } from 'audr/testing';

import { ChargebeeSink, type ChargebeeSinkOptions } from '../src/index.js';

export const ORIGIN = 'https://acme.ingest.chargebee.com';
export const BATCH_URL = `${ORIGIN}/api/v2/batch/usage_events`;

/** A valid record Chargebee can route, with `attribution` fields merged in. */
export function record(
  attribution: Partial<Attribution> = {},
  overrides: Partial<RecordInput> = {},
): AudrRecord {
  return makeRecord({
    attribution: { environment: 'test', subscription_id: 'sub_test', ...attribution },
    ...overrides,
  });
}

export interface Call {
  readonly url: string;
  readonly init: RequestInit;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: { events: Record<string, unknown>[] };
}

/** A `fetch` that records every call and answers through `handler`. */
export function fakeFetch(handler: (call: Call, index: number) => Response | Promise<Response>): {
  fetch: typeof globalThis.fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  // The transport always passes a string URL and a string body.
  const fetch = (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const call: Call = {
      url: input as string,
      init,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(init.body as string) as Call['body'],
    };
    calls.push(call);
    return Promise.resolve(handler(call, calls.length - 1));
  };
  return { fetch, calls };
}

/** A `fetch` that never answers and rejects with the abort reason once its signal fires. */
export function hangingFetch(): typeof globalThis.fetch {
  return (_input: string | URL | Request, init: RequestInit = {}) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => {
        reject(init.signal?.reason as Error);
      });
    });
}

export function respond(
  status: number,
  body?: unknown,
  headers: Record<string, string> = {},
): Response {
  const text = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(text, { status, headers });
}

export function recordingLogger(): {
  warn(m: string): void;
  error(m: string): void;
  lines: string[];
} {
  const lines: string[] = [];
  return {
    lines,
    warn: (message) => lines.push(`warn: ${message}`),
    error: (message) => lines.push(`error: ${message}`),
  };
}

/** Let pending promise chains run until they block on I/O or a timer. */
export function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** A sink against `ORIGIN` that retries without waiting, unless `options` says otherwise. */
export function makeSink(options: ChargebeeSinkOptions = {}): ChargebeeSink {
  return new ChargebeeSink({
    ingestUrl: ORIGIN,
    apiKey: 'test_key',
    retry: { initialBackoffMs: 0, maxBackoffMs: 0 },
    logger: recordingLogger(),
    ...options,
  });
}
