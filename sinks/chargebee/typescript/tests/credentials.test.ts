import { inspect } from 'node:util';

import { ConfigurationError } from 'audr';
import { describe, expect, it, vi } from 'vitest';

import { parseIngestUrl, resolveCredentials } from '../src/credentials.js';
import { ChargebeeSink } from '../src/index.js';
import { fakeFetch, ORIGIN, record, respond } from './helpers.js';

const DEV_ORIGIN = 'https://acme-test.ingest.chargebee.com';

describe('parseIngestUrl', () => {
  it.each([ORIGIN, `${ORIGIN}/`, `${ORIGIN}/api/v2/batch/usage_events`])('accepts %s', (url) => {
    expect(parseIngestUrl(url)).toBe(ORIGIN);
  });

  it.each([
    ['http://acme.ingest.chargebee.com', 'scheme'],
    ['https://ACME.ingest.chargebee.com', 'lowercase'],
    ['https://acme', 'two labels'],
    ['https://acme.ingest.chargebee.com:443', 'port'],
    ['https://user:pass@acme.ingest.chargebee.com', 'userinfo'],
    ['https://acme.ingest.chargebee.com?x=1', 'query'],
    [`${ORIGIN}/api/v2/usage_events`, 'batch endpoint'],
    ['https://acme.ingest.chargebee.com#frag', 'fragment'],
    ['https://acme.ingest.chargebee.com/evil/path', 'path'],
    ['https://acme.ingest.chargebee.com.', 'trailing dot'],
    ['https://acme.ingest.chargebee.com\\@evil.test', 'two labels'],
    ['https:///api/v2/batch/usage_events', 'host name'],
    ['not a url', 'host name'],
  ])('rejects %s', (url, message) => {
    expect(() => parseIngestUrl(url)).toThrow(ConfigurationError);
    expect(() => parseIngestUrl(url)).toThrow(message);
  });
});

describe('resolveCredentials', () => {
  it('builds the origin from site and the default ingest domain', () => {
    const credentials = resolveCredentials({ site: 'acme', apiKey: 'test_key' }, {});

    expect(credentials.origin).toBe(ORIGIN);
    expect(credentials.authorization).toBe(`Basic ${btoa('test_key:')}`);
  });

  it('lets ingestDomain override the default', () => {
    const { origin } = resolveCredentials(
      { site: 'acme', apiKey: 'k', ingestDomain: 'ingest.example.test' },
      {},
    );

    expect(origin).toBe('https://acme.ingest.example.test');
  });

  it('reads site, key and domain from the environment', () => {
    const { origin, authorization } = resolveCredentials(
      {},
      {
        CHARGEBEE_SITE: 'acme',
        CHARGEBEE_API_KEY: 'from-env-key',
        CHARGEBEE_INGEST_DOMAIN: 'ingest.example.test',
      },
    );

    expect(origin).toBe('https://acme.ingest.example.test');
    expect(authorization).toBe(`Basic ${btoa('from-env-key:')}`);
  });

  it('reads ingestUrl from the environment', () => {
    const { origin } = resolveCredentials(
      {},
      { CHARGEBEE_INGEST_URL: DEV_ORIGIN, CHARGEBEE_API_KEY: 'k' },
    );

    expect(origin).toBe(DEV_ORIGIN);
  });

  it('prefers explicit options over the environment', () => {
    const { origin, authorization } = resolveCredentials(
      { site: 'acme', ingestDomain: 'ingest.chargebee.com', apiKey: 'explicit-key' },
      {
        CHARGEBEE_SITE: 'other-site',
        CHARGEBEE_INGEST_DOMAIN: 'ingest.example.test',
        CHARGEBEE_API_KEY: 'from-env-key',
      },
    );

    expect(origin).toBe(ORIGIN);
    expect(authorization).toBe(`Basic ${btoa('explicit-key:')}`);
  });

  it('prefers an explicit ingestUrl over the environment one', () => {
    const { origin } = resolveCredentials(
      { ingestUrl: ORIGIN, apiKey: 'k' },
      { CHARGEBEE_INGEST_URL: DEV_ORIGIN },
    );

    expect(origin).toBe(ORIGIN);
  });

  it('requires an API key, naming the variable but no secret', () => {
    expect(() => resolveCredentials({ ingestUrl: ORIGIN }, {})).toThrow(
      /apiKey is required.*CHARGEBEE_API_KEY/,
    );
  });

  it.each(['', '   '])('rejects the empty key %j without echoing it', (apiKey) => {
    expect(() => resolveCredentials({ ingestUrl: ORIGIN, apiKey }, {})).toThrow(
      'apiKey must not be empty; set CHARGEBEE_API_KEY',
    );
  });

  it('requires a site or an ingest URL, with an example', () => {
    expect(() => resolveCredentials({ apiKey: 'k' }, {})).toThrow(
      /site.*CHARGEBEE_SITE.*ingestUrl.*https:\/\/acme\.ingest\.chargebee\.com/,
    );
  });

  it('rejects an invalid site', () => {
    expect(() => resolveCredentials({ site: 'Acme_Site!', apiKey: 'k' }, {})).toThrow('site must');
  });

  it('rejects an invalid ingest domain', () => {
    expect(() =>
      resolveCredentials({ site: 'acme', apiKey: 'k', ingestDomain: 'not-a-domain' }, {}),
    ).toThrow('ingestDomain must');
  });

  it.each([{ site: 'acme' }, { ingestDomain: 'ingest.chargebee.eu' }])(
    'makes ingestUrl mutually exclusive with %o',
    (extra) => {
      expect(() => resolveCredentials({ ingestUrl: ORIGIN, apiKey: 'k', ...extra }, {})).toThrow(
        'mutually exclusive',
      );
    },
  );

  it('still validates an ingestUrl from the environment', () => {
    expect(() =>
      resolveCredentials({ apiKey: 'k' }, { CHARGEBEE_INGEST_URL: 'http://acme.test.io' }),
    ).toThrow('scheme');
  });
});

describe('ChargebeeSink credentials', () => {
  it('resolves the process environment once, at construction', async () => {
    vi.stubEnv('CHARGEBEE_INGEST_URL', ORIGIN);
    vi.stubEnv('CHARGEBEE_API_KEY', 'original-key');
    const { fetch, calls } = fakeFetch(() => respond(202));
    const sink = new ChargebeeSink({ fetch });
    vi.stubEnv('CHARGEBEE_API_KEY', 'changed-key');

    await sink.deliver([record()]);

    expect(calls[0]?.headers.Authorization).toBe(`Basic ${btoa('original-key:')}`);
  });

  it('never renders the API key', () => {
    const secret = 'sk_live_secret';
    const sink = new ChargebeeSink({ site: 'acme', apiKey: secret });
    const renderings = [String(sink), inspect(sink), JSON.stringify(sink)];

    expect(String(sink)).toBe(`ChargebeeSink(origin=${ORIGIN})`);
    for (const text of renderings) {
      expect(text).not.toContain(secret);
      expect(text).not.toContain(btoa(`${secret}:`));
    }
  });
});
