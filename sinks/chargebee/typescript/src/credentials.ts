/** Credential resolution and validation of the single origin a request may be sent to. */
import { Buffer } from 'node:buffer';
import process from 'node:process';

import { ConfigurationError } from 'audr';

/** The Chargebee batch ingest domain; it is not site- or geography-specific. */
export const DEFAULT_INGEST_DOMAIN = 'ingest.chargebee.com';
export const BATCH_PATH = '/api/v2/batch/usage_events';

const HOST_LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOST = new RegExp(`^${HOST_LABEL}(?:\\.${HOST_LABEL})+$`);
const SITE = new RegExp(`^${HOST_LABEL}$`);
const ACCEPTED_PATHS = new Set(['', '/', BATCH_PATH]);
const INGEST_URL_EXAMPLE = 'https://acme.ingest.chargebee.com';

export interface CredentialOptions {
  /** The Chargebee site name, as in `acme` for `acme.chargebee.com`. Env: `CHARGEBEE_SITE`. */
  readonly site?: string | undefined;
  /** Always required. Env: `CHARGEBEE_API_KEY`. */
  readonly apiKey?: string | undefined;
  /** Default `ingest.chargebee.com`. Env: `CHARGEBEE_INGEST_DOMAIN`. */
  readonly ingestDomain?: string | undefined;
  /** A full origin, instead of `site` and `ingestDomain`. Env: `CHARGEBEE_INGEST_URL`. */
  readonly ingestUrl?: string | undefined;
}

export interface Credentials {
  /** The validated `https://host` origin; the only destination the key is ever sent to. */
  readonly origin: string;
  /** The HTTP `Authorization` header value. Never log it. */
  readonly authorization: string;
}

/**
 * Resolve credentials once, preferring explicit options over the environment.
 *
 * `site` (with `ingestDomain`) and `apiKey` mirror the official Chargebee SDKs. `ingestUrl`
 * sets the origin directly for a host that is not a `{site}` subdomain of the ingest
 * domain, and is mutually exclusive with `site` and `ingestDomain`.
 */
export function resolveCredentials(
  options: CredentialOptions,
  env: NodeJS.ProcessEnv = process.env,
): Credentials {
  const apiKey = options.apiKey ?? env.CHARGEBEE_API_KEY;
  if (apiKey === undefined) {
    throw new ConfigurationError('apiKey is required; provide apiKey or set CHARGEBEE_API_KEY');
  }
  const authorization = basicAuthorization(apiKey);

  const ingestUrl = options.ingestUrl ?? env.CHARGEBEE_INGEST_URL;
  if (ingestUrl !== undefined) {
    if (options.site !== undefined || options.ingestDomain !== undefined) {
      throw new ConfigurationError('ingestUrl is mutually exclusive with site/ingestDomain');
    }
    return { origin: parseIngestUrl(ingestUrl), authorization };
  }

  const site = options.site ?? env.CHARGEBEE_SITE;
  if (site === undefined) {
    throw new ConfigurationError(
      'site is required; provide site (or set CHARGEBEE_SITE) or provide ingestUrl ' +
        `(or set CHARGEBEE_INGEST_URL, for example ${INGEST_URL_EXAMPLE})`,
    );
  }
  if (!SITE.test(site)) {
    throw new ConfigurationError(
      'site must be a lowercase DNS label: letters, digits, and hyphens, and it must not ' +
        'start or end with a hyphen',
    );
  }
  const domain = options.ingestDomain ?? env.CHARGEBEE_INGEST_DOMAIN ?? DEFAULT_INGEST_DOMAIN;
  if (!HOST.test(domain)) {
    throw new ConfigurationError(
      'ingestDomain must be a dotted lowercase host name with at least two labels',
    );
  }
  return { origin: parseIngestUrl(`https://${site}.${domain}${BATCH_PATH}`), authorization };
}

/**
 * Parse a full ingest URL and return its origin.
 *
 * The host is checked as written, against a dotted host-label pattern that admits no
 * scheme, port, path or userinfo; `URL` would silently normalise several of those away.
 * Relaxing it would let a configured value redirect an authenticated request, and the
 * API key with it.
 */
export function parseIngestUrl(ingestUrl: string): string {
  let url: URL;
  try {
    url = new URL(ingestUrl);
  } catch {
    throw new ConfigurationError('ingestUrl must include a host name');
  }
  if (url.protocol !== 'https:') throw new ConfigurationError('ingestUrl scheme must be https');
  if (url.username !== '' || url.password !== '') {
    throw new ConfigurationError('ingestUrl must not include userinfo');
  }
  if (url.search !== '') throw new ConfigurationError('ingestUrl must not include a query string');
  if (url.hash !== '') throw new ConfigurationError('ingestUrl must not include a fragment');

  const [, host = '', path = ''] = /^https:\/\/([^/?#]*)([^?#]*)/.exec(ingestUrl) ?? [];
  if (host === '') throw new ConfigurationError('ingestUrl must include a host name');
  if (/:\d*$/.test(host)) throw new ConfigurationError('ingestUrl must not include a port');
  if (host.endsWith('.')) {
    throw new ConfigurationError('ingestUrl host must not have a trailing dot');
  }
  if (host !== host.toLowerCase()) throw new ConfigurationError('ingestUrl host must be lowercase');
  if (!HOST.test(host) || host !== url.hostname) {
    throw new ConfigurationError(
      'ingestUrl host must be a dotted lowercase host name with at least two labels',
    );
  }
  if (!ACCEPTED_PATHS.has(path)) {
    throw new ConfigurationError(
      `ingestUrl path must be empty, /, or ${BATCH_PATH}; the sink only calls the batch endpoint`,
    );
  }
  return `https://${host}`;
}

/** HTTP Basic credentials with the key as the username and no password. */
function basicAuthorization(apiKey: unknown): string {
  if (typeof apiKey !== 'string' || apiKey.trim() === '') {
    throw new ConfigurationError('apiKey must not be empty; set CHARGEBEE_API_KEY');
  }
  return `Basic ${Buffer.from(`${apiKey}:`, 'utf8').toString('base64')}`;
}
