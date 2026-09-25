import { ConfigurationError } from 'audr';
import { describe, expect, it } from 'vitest';

import { ClosedError, Transport } from '../src/transport.js';
import { fakeFetch, hangingFetch, respond } from './helpers.js';

const URL = 'https://acme.ingest.chargebee.test/api/v2/batch/usage_events';

describe('Transport', () => {
  it('posts the body with the headers, never following a redirect', async () => {
    const { fetch, calls } = fakeFetch(() =>
      respond(302, undefined, { Location: 'https://x.test' }),
    );
    const transport = new Transport({ fetch });

    const response = await transport.post(URL, '{"events":[]}', { Authorization: 'Basic x' });

    expect(response.status).toBe(302);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init).toMatchObject({ method: 'POST', redirect: 'manual' });
    expect(calls[0]?.headers).toEqual({ Authorization: 'Basic x' });
  });

  it('aborts a request that outlives timeoutMs', async () => {
    const transport = new Transport({ fetch: hangingFetch(), timeoutMs: 10 });

    await expect(transport.post(URL, '{}', {})).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(transport.closed).toBe(false);
  });

  it('is terminal and idempotent once closed', async () => {
    const { fetch, calls } = fakeFetch(() => respond(202));
    const transport = new Transport({ fetch });

    await transport.close();
    await transport.close();

    expect(transport.closed).toBe(true);
    await expect(transport.post(URL, '{}', {})).rejects.toBeInstanceOf(ClosedError);
    expect(calls).toHaveLength(0);
  });

  it('ends a pause early when closed, and skips it once closed', async () => {
    const transport = new Transport({ fetch: hangingFetch() });
    const started = Date.now();
    const pause = transport.pause(60_000);

    await transport.close();
    await pause;
    await transport.pause(60_000);

    expect(Date.now() - started).toBeLessThan(1000);
  });

  it.each([0, -1, Number.NaN, Infinity, 2 ** 31, '10'])('rejects timeoutMs %j', (timeoutMs) => {
    expect(() => new Transport({ timeoutMs: timeoutMs as number })).toThrow(ConfigurationError);
  });
});
