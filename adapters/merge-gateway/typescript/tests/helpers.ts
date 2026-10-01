import { type AudrRecord, Client, type Logger } from '@openaudr/audr';
import { MemorySink } from '@openaudr/audr/testing';
import { MergeGateway } from 'merge-gateway-sdk';
import { vi } from 'vitest';

import { instrumentMergeGateway, type InstrumentMergeGatewayOptions } from '../src/index.js';

/** A logger that keeps every line it is given. */
export class CapturingLogger implements Logger {
  readonly warnings: string[] = [];
  readonly errors: string[] = [];

  warn(message: string): void {
    this.warnings.push(message);
  }

  error(message: string): void {
    this.errors.push(message);
  }

  get lines(): string[] {
    return [...this.warnings, ...this.errors];
  }
}

export interface SentRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

/**
 * Stands in for the Gateway API behind the real SDK: `fetch` is stubbed and answers the
 * queued responses in order, recording each request.
 */
export class FakeGateway {
  readonly requests: SentRequest[] = [];
  readonly #queue: (() => Response)[] = [];

  json(body: unknown, status = 200): this {
    this.#queue.push(
      () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
    );
    return this;
  }

  /** A native SSE stream of `frames`; `failAfter` errors the body after that many frames. */
  sse(frames: readonly unknown[], options: { failAfter?: number } = {}): this {
    this.#queue.push(() => {
      const encoder = new TextEncoder();
      let sent = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (options.failAfter !== undefined && sent === options.failAfter) {
            controller.error(new TypeError('network'));
            return;
          }
          const frame = frames[sent];
          if (frame === undefined) {
            controller.close();
            return;
          }
          sent += 1;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });
    return this;
  }

  readonly fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const raw = init?.body;
    this.requests.push({
      method: init?.method ?? 'GET',
      path: url.pathname.replace(/^\/v1/, ''),
      headers: Object.fromEntries(new Headers(init?.headers)),
      body: typeof raw === 'string' ? (JSON.parse(raw) as unknown) : undefined,
    });
    const next = this.#queue.shift();
    return next === undefined
      ? Promise.reject(new Error('no response queued'))
      : Promise.resolve(next());
  };
}

export interface Harness {
  readonly fake: FakeGateway;
  readonly native: MergeGateway;
  readonly gateway: MergeGateway;
  readonly sink: MemorySink;
  readonly client: Client;
  readonly logger: CapturingLogger;
  /** The client's own diagnostics, kept apart from the adapter's. */
  readonly clientLogger: CapturingLogger;
  /** Flush the client and return every record the sink has accepted. */
  records(): Promise<AudrRecord[]>;
}

export function harness(options: Partial<InstrumentMergeGatewayOptions> = {}): Harness {
  const fake = new FakeGateway();
  vi.stubGlobal('fetch', fake.fetch);
  const sink = new MemorySink();
  const clientLogger = new CapturingLogger();
  const client = new Client(sink, { logger: clientLogger });
  const logger = new CapturingLogger();
  const native = new MergeGateway({ apiKey: 'mg_test' });
  const gateway = instrumentMergeGateway(native, {
    client,
    logger,
    attributionDefaults: { environment: 'test' },
    ...options,
  });
  return {
    fake,
    native,
    gateway,
    sink,
    client,
    logger,
    clientLogger,
    async records() {
      await client.flush();
      return sink.records;
    },
  };
}

/** A `Client` stand-in that accepts every record and keeps it. */
export function recordingClient(): Client & { readonly submitted: AudrRecord[] } {
  const submitted: AudrRecord[] = [];
  return {
    submitted,
    record: (record: AudrRecord) => {
      submitted.push(record);
      return { outcome: 'queued', queued: true, issues: [] };
    },
  } as unknown as Client & { readonly submitted: AudrRecord[] };
}

/** A native `/v1/responses` body as documented, with cache and reasoning counters. */
export function response(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'resp_01J9Z8QK4M',
    object: 'response',
    created_at: '2026-09-30T12:00:00Z',
    model: 'openai/gpt-5.4',
    vendor: 'openai',
    service_tier: 'standard',
    provider_request_id: 'req_provider_1',
    output: [
      {
        type: 'message',
        id: 'msg_1',
        role: 'assistant',
        finish_reason: 'stop',
        content: [{ type: 'text', text: 'ok', annotations: [] }],
      },
    ],
    usage: {
      input_tokens: 5620,
      output_tokens: 180,
      total_tokens: 5800,
      cache_creation_input_tokens: 40,
      cache_read_input_tokens: 5533,
      reasoning_output_tokens: 30,
      cost: 0.002365,
    },
    ...overrides,
  };
}

/** The AUDR counters `response()` maps to. */
export const RESPONSE_LLM = {
  input_tokens: 47,
  output_tokens: 150,
  cache_read_tokens: 5533,
  cache_write_tokens: 40,
  reasoning_tokens: 30,
  requests: 1,
};

/** A native `/v1/embeddings` body as documented. */
export function embedding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    object: 'list',
    data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2] }],
    model: 'openai/text-embedding-3-small',
    vendor: 'openai',
    usage: { prompt_tokens: 8, total_tokens: 8, cost: 0.00000016 },
    ...overrides,
  };
}

/** The frames of a native stream: two snapshots, then the terminal frame. */
export function streamFrames(done: Record<string, unknown> = response()): unknown[] {
  const snapshot = { ...done, usage: undefined, service_tier: null };
  return [
    { ...snapshot, object: 'response.stream' },
    { ...snapshot, object: 'response.stream' },
    { ...done, object: 'response.done' },
  ];
}

export async function drain(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const frames: unknown[] = [];
  for await (const frame of stream) frames.push(frame);
  return frames;
}
