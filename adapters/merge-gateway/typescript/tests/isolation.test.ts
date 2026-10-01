import { type Client } from '@openaudr/audr';
import { MergeGateway } from 'merge-gateway-sdk';
import { describe, expect, it, vi } from 'vitest';

import { instrumentMergeGateway, type MergeGatewayLike } from '../src/index.js';
import { CapturingLogger, drain, FakeGateway, harness, response, streamFrames } from './helpers.js';

const PARAMS = { model: 'openai/gpt-5.4', input: 'hi' };

function gatewayWith(client: Client, logger: CapturingLogger | { warn(): void; error(): void }) {
  const fake = new FakeGateway();
  vi.stubGlobal('fetch', fake.fetch);
  const gateway = instrumentMergeGateway(new MergeGateway({ apiKey: 'mg_test' }), {
    client,
    logger,
    attributionDefaults: { environment: 'test' },
  });
  return { fake, gateway };
}

describe('metering never breaks a native call', () => {
  it('a client that throws is logged by class name only', async () => {
    const logger = new CapturingLogger();
    const client = {
      record: () => {
        throw new TypeError('client exploded with a value');
      },
    } as unknown as Client;
    const { fake, gateway } = gatewayWith(client, logger);
    const body = response();
    fake.json(body).sse(streamFrames());
    expect(await gateway.responses.create(PARAMS)).toEqual(body);
    expect(await drain(await gateway.responses.create({ ...PARAMS, stream: true }))).toHaveLength(
      3,
    );
    expect(logger.errors).toEqual([
      '@openaudr/adapter-merge-gateway: HOOK_FAILED (operation=responses.create, error=TypeError)',
      '@openaudr/adapter-merge-gateway: HOOK_FAILED (operation=responses.create, error=TypeError)',
    ]);
  });

  it('never trusts a writable error name', async () => {
    const logger = new CapturingLogger();
    const failure = new Error('private value');
    failure.name = 'SENTINEL_PRIVATE_VALUE';
    const client = {
      record: () => {
        throw failure;
      },
    } as unknown as Client;
    const { fake, gateway } = gatewayWith(client, logger);
    fake.json(response());
    await expect(gateway.responses.create(PARAMS)).resolves.toBeDefined();
    expect(logger.errors).toEqual([
      '@openaudr/adapter-merge-gateway: HOOK_FAILED (operation=responses.create, error=Error)',
    ]);
    expect(logger.errors.join()).not.toContain('SENTINEL_PRIVATE_VALUE');
  });

  it('a logger that throws is ignored', async () => {
    const client = {
      record: () => {
        throw new TypeError('boom');
      },
    } as unknown as Client;
    const throwing = {
      warn: () => {
        throw new Error('logger');
      },
      error: () => {
        throw new Error('logger');
      },
    };
    const { fake, gateway } = gatewayWith(client, throwing);
    fake.json(response()).sse(streamFrames().slice(0, 1));
    await expect(gateway.responses.create(PARAMS)).resolves.toBeDefined();
    await expect(
      drain(await gateway.responses.create({ ...PARAMS, stream: true })),
    ).resolves.toHaveLength(1);
  });

  it('logs nothing unless given a logger', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const native: MergeGatewayLike = {
      responses: { create: () => Promise.resolve(response()) },
      embeddings: { create: () => Promise.resolve({}) },
    };
    try {
      const unattributed = instrumentMergeGateway(native, {
        client: {
          record: () => ({ outcome: 'queued', queued: true, issues: [] }),
        } as never,
      });
      await unattributed.responses.create(PARAMS);

      const failing = instrumentMergeGateway(native, {
        client: {
          record: () => {
            throw new TypeError('private value');
          },
        } as never,
        attributionDefaults: { environment: 'test' },
      });
      await failing.responses.create(PARAMS);

      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it('returns a result it cannot read unchanged', async () => {
    const native: MergeGatewayLike = {
      responses: { create: () => Promise.resolve(null) },
      embeddings: { create: () => Promise.resolve('not a response') },
    };
    const logger = new CapturingLogger();
    const record = vi.fn();
    const gateway = instrumentMergeGateway(native, {
      client: { record } as never,
      logger,
      attributionDefaults: { environment: 'test' },
    });
    expect(await gateway.responses.create(PARAMS)).toBeNull();
    expect(
      await gateway.embeddings.create({ model: 'openai/text-embedding-3-small', input: 'a' }),
    ).toBe('not a response');
    expect(record).not.toHaveBeenCalled();
    expect(logger.lines).toEqual([
      '@openaudr/adapter-merge-gateway: MODEL_UNREPORTED (operation=embeddings.create)',
      '@openaudr/adapter-merge-gateway: HOOK_FAILED (operation=responses.create, error=TypeError)',
    ]);
  });

  it('returns a result whose stream shape cannot be inspected unchanged', async () => {
    const result = new Proxy(
      {},
      {
        has(_target, key): boolean {
          if (key === Symbol.asyncIterator) throw new TypeError('private value');
          return false;
        },
      },
    );
    const native: MergeGatewayLike = {
      responses: { create: () => Promise.resolve(result) },
      embeddings: { create: () => Promise.resolve({}) },
    };
    const logger = new CapturingLogger();
    const record = vi.fn();
    const gateway = instrumentMergeGateway(native, {
      client: { record } as never,
      logger,
      attributionDefaults: { environment: 'test' },
    });
    await expect(gateway.responses.create(PARAMS)).resolves.toBe(result);
    expect(record).not.toHaveBeenCalled();
    expect(logger.errors).toEqual([
      '@openaudr/adapter-merge-gateway: HOOK_FAILED (operation=responses.create, error=TypeError)',
    ]);
  });

  it('returns a stream whose close member cannot be inspected unchanged', async () => {
    const stream = {
      [Symbol.asyncIterator]: async function* () {
        await Promise.resolve();
        yield { ...response(), object: 'response.done' };
      },
      get close(): never {
        throw new RangeError('private value');
      },
    };
    const native: MergeGatewayLike = {
      responses: { create: () => Promise.resolve(stream) },
      embeddings: { create: () => Promise.resolve({}) },
    };
    const logger = new CapturingLogger();
    const record = vi.fn();
    const gateway = instrumentMergeGateway(native, {
      client: { record } as never,
      logger,
      attributionDefaults: { environment: 'test' },
    });
    const returned = await gateway.responses.create(PARAMS);
    expect(returned).toBe(stream);
    expect(await drain(returned as AsyncIterable<unknown>)).toHaveLength(1);
    expect(record).not.toHaveBeenCalled();
    expect(logger.errors).toEqual([
      '@openaudr/adapter-merge-gateway: HOOK_FAILED (operation=responses.create, error=RangeError)',
    ]);
  });

  it('reads only output modalities in addition to the native request fields', async () => {
    const h = harness();
    h.fake.sse(streamFrames());
    const reads: PropertyKey[] = [];
    const watched = new Proxy(
      { model: 'openai/gpt-5.4', input: 'hi', stream: true as const },
      {
        get(target, key, receiver) {
          reads.push(key);
          return Reflect.get(target, key, receiver) as unknown;
        },
      },
    );
    await drain(await h.gateway.responses.create(watched));
    const instrumented = [...reads];
    reads.length = 0;
    h.fake.sse(streamFrames());
    await drain(await h.native.responses.create(watched));
    expect(instrumented).toEqual(['modalities', ...reads]);
  });

  it('does not add close() to a stream without one', async () => {
    const frames = [{ ...response(), object: 'response.done' }];
    const stream = {
      [Symbol.asyncIterator]: async function* () {
        yield* frames;
        await Promise.resolve();
      },
    };
    const native: MergeGatewayLike = {
      responses: { create: () => Promise.resolve(stream) },
      embeddings: { create: () => Promise.resolve({}) },
    };
    const logger = new CapturingLogger();
    const record = vi.fn(() => ({ outcome: 'queued', queued: true, issues: [] }) as const);
    const gateway = instrumentMergeGateway(native, {
      client: { record } as never,
      logger,
      attributionDefaults: { environment: 'test' },
    });
    const metered = (await gateway.responses.create({
      ...PARAMS,
      stream: true,
    })) as AsyncIterable<unknown>;
    expect('close' in metered).toBe(false);
    expect(await drain(metered)).toEqual(frames);
    expect(record).toHaveBeenCalledOnce();
    expect(logger.lines).toEqual([]);
  });
});

describe('rejected records are reported without values', () => {
  it('logs the outcome and each issue path', async () => {
    const h = harness({ attributionDefaults: { environment: 'production' } });
    h.fake.json(response());
    await h.gateway.responses.create(PARAMS);
    expect(await h.records()).toEqual([]);
    expect(h.logger.warnings).toHaveLength(1);
    expect(h.logger.warnings[0]).toMatch(
      /^@openaudr\/adapter-merge-gateway: RECORD_NOT_QUEUED \(outcome=rejected_invalid, operation=responses\.create, issues=[^\s()]+@\/attribution[^\s()]*\)$/,
    );
  });
});
