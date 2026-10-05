import { ConfigurationError } from '@openaudr/audr';
import {
  type EmbeddingCreateParams,
  MergeGateway,
  type ResponseCreateParams,
} from 'merge-gateway-sdk';
import { describe, expect, it, vi } from 'vitest';

import { instrumentMergeGateway } from '../src/index.js';
import { embedding, FakeGateway, harness, recordingClient, response } from './helpers.js';

describe('facade', () => {
  it('keeps the native type and forwards every other resource', async () => {
    const h = harness();
    expect(h.gateway).toBeInstanceOf(MergeGateway);
    h.fake.json({ object: 'list', data: [], has_more: false });
    await h.gateway.models.list();
    expect(h.fake.requests.map((r) => r.path)).toEqual(['/models']);
    expect(typeof h.gateway.close).toBe('function');
    h.gateway.close();
    expect('customers' in h.gateway).toBe(true);
    expect(await h.records()).toEqual([]);
  });

  it('never modifies the native client', async () => {
    const h = harness();
    const before = { responses: h.native.responses, embeddings: h.native.embeddings };
    h.fake.json(response()).json(response());
    await h.native.responses.create({ model: 'openai/gpt-5.4', input: 'hi' });
    expect(h.native.responses).toBe(before.responses);
    expect(h.native.embeddings).toBe(before.embeddings);
    expect(await h.records()).toEqual([]);
    await h.gateway.responses.create({ model: 'openai/gpt-5.4', input: 'hi' });
    expect(await h.records()).toHaveLength(1);
  });

  it('sends exactly the request the native client sends', async () => {
    const h = harness();
    const params = {
      model: 'openai/gpt-5.4',
      input: 'hi',
      tags: [{ key: 'team', value: 'support' }],
      customer: '8f14e45f-0000-4000-8000-000000000000',
      include_routing_metadata: true,
    };
    h.fake.json(response()).json(response()).json(embedding()).json(embedding());
    await h.native.responses.create(params);
    await h.gateway.responses.create(params);
    await h.native.embeddings.create({ model: 'openai/text-embedding-3-small', input: ['a'] });
    await h.gateway.embeddings.create({ model: 'openai/text-embedding-3-small', input: ['a'] });
    const [a, b, c, d] = h.fake.requests;
    expect(b).toEqual(a);
    expect(d).toEqual(c);
  });

  it('passes every argument to the native create()', async () => {
    const options = { headers: { 'X-Merge-Span-Name': 'draft' } };
    const native = {
      responses: {
        create: vi.fn<(params: ResponseCreateParams, opts?: typeof options) => Promise<unknown>>(
          () => Promise.resolve(response()),
        ),
      },
      embeddings: {
        create: vi.fn<(params: EmbeddingCreateParams, opts?: typeof options) => Promise<unknown>>(
          () => Promise.resolve(embedding()),
        ),
      },
    };
    const client = recordingClient();
    const gateway = instrumentMergeGateway(native, {
      client,
      attributionDefaults: { environment: 'test' },
    });
    const params = { model: 'openai/gpt-5.4', input: 'hi' };
    await gateway.responses.create(params, options);
    await gateway.embeddings.create(
      { model: 'openai/text-embedding-3-small', input: 'a' },
      options,
    );
    expect(native.responses.create.mock.calls).toEqual([[params, options]]);
    expect(native.responses.create.mock.contexts).toEqual([native.responses]);
    expect(native.embeddings.create.mock.calls[0]![1]).toBe(options);
    expect(client.submitted).toHaveLength(2);
  });

  it('returns the native response object itself', async () => {
    const h = harness();
    const body = response();
    h.fake.json(body);
    const result = await h.gateway.responses.create({ model: 'openai/gpt-5.4', input: 'hi' });
    expect(result).toEqual(body);
  });
});

describe('configuration', () => {
  it('requires a client with record()', () => {
    expect(() =>
      instrumentMergeGateway(new MergeGateway({ apiKey: 'mg_test' }), { client: {} as never }),
    ).toThrow(new ConfigurationError('client must implement record()'));
  });
});

describe('double instrumentation', () => {
  it('refuses to instrument a facade twice', () => {
    const facade = instrumentMergeGateway(new MergeGateway({ apiKey: 'mg_test' }), {
      client: recordingClient(),
    });
    expect(() => instrumentMergeGateway(facade, { client: recordingClient() })).toThrow(
      new ConfigurationError('gateway is already instrumented'),
    );
  });

  it('lets one native client back several facades', async () => {
    const fake = new FakeGateway();
    vi.stubGlobal('fetch', fake.fetch);
    const native = new MergeGateway({ apiKey: 'mg_test' });
    const first = recordingClient();
    const second = recordingClient();
    const options = { attributionDefaults: { environment: 'test' } } as const;
    const a = instrumentMergeGateway(native, { client: first, ...options });
    const b = instrumentMergeGateway(native, { client: second, ...options });
    fake.json(response()).json(response());
    await a.responses.create({ model: 'openai/gpt-5.4', input: 'hi' });
    await b.responses.create({ model: 'openai/gpt-5.4', input: 'hi' });
    expect([first.submitted.length, second.submitted.length]).toEqual([1, 1]);
  });
});

describe('host owns the client', () => {
  it('only ever calls record()', async () => {
    const fake = new FakeGateway();
    vi.stubGlobal('fetch', fake.fetch);
    const client = {
      record: vi.fn(() => ({ outcome: 'queued', queued: true, issues: [] })),
      flush: vi.fn(),
      shutdown: vi.fn(),
    };
    const gateway = instrumentMergeGateway(new MergeGateway({ apiKey: 'mg_test' }), {
      client: client as never,
      attributionDefaults: { environment: 'test' },
    });
    fake.json(response()).json(embedding());
    await gateway.responses.create({ model: 'openai/gpt-5.4', input: 'hi' });
    await gateway.embeddings.create({ model: 'openai/text-embedding-3-small', input: 'a' });
    expect(client.record).toHaveBeenCalledTimes(2);
    expect(client.flush).not.toHaveBeenCalled();
    expect(client.shutdown).not.toHaveBeenCalled();
  });
});
