/** Failure classification and the bounded, full-jitter retry policy applied in `deliver()`. */
import { ConfigurationError } from 'audr';

/** The largest delay `setTimeout` honours; anything longer fires immediately. */
export const MAX_DELAY_MS = 2_147_483_647;

export interface RetryOptions {
  /** Attempts per batch, the first included. Default 3. */
  readonly maxAttempts?: number | undefined;
  /** Ceiling of the first backoff, in milliseconds. Default 500. */
  readonly initialBackoffMs?: number | undefined;
  /** Cap on any single backoff, `Retry-After` included, in milliseconds. Default 30000. */
  readonly maxBackoffMs?: number | undefined;
  /** Growth of the backoff ceiling per attempt. Default 2. */
  readonly multiplier?: number | undefined;
}

export type FailureClass = 'transient' | 'credential' | 'permanent';

const TRANSIENT_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

export class RetryPolicy {
  readonly maxAttempts: number;
  readonly initialBackoffMs: number;
  readonly maxBackoffMs: number;
  readonly multiplier: number;

  constructor(options: RetryOptions = {}) {
    this.maxAttempts = options.maxAttempts ?? 3;
    this.initialBackoffMs = options.initialBackoffMs ?? 500;
    this.maxBackoffMs = options.maxBackoffMs ?? 30_000;
    this.multiplier = options.multiplier ?? 2;
    if (!Number.isInteger(this.maxAttempts)) {
      throw new ConfigurationError('maxAttempts must be an integer');
    }
    if (this.maxAttempts < 1) throw new ConfigurationError('maxAttempts must be at least 1');
    finite(this.initialBackoffMs, 'initialBackoffMs', 0);
    finite(this.maxBackoffMs, 'maxBackoffMs', 0);
    finite(this.multiplier, 'multiplier', 1);
    if (this.maxBackoffMs > MAX_DELAY_MS) {
      throw new ConfigurationError(`maxBackoffMs must be at most ${MAX_DELAY_MS}`);
    }
  }

  /** Classify a failed HTTP status. A transport error is transient by definition. */
  classify(status: number): FailureClass {
    if (TRANSIENT_STATUSES.has(status)) return 'transient';
    if (status === 401) return 'credential';
    return 'permanent';
  }

  /** A capped full-jitter delay before retrying, never shorter than a valid `Retry-After`. */
  delayMs(attempt: number, retryAfter?: string | null, now: number = Date.now()): number {
    const ceiling = Math.min(
      this.maxBackoffMs,
      this.initialBackoffMs * this.multiplier ** (attempt - 1),
    );
    const jittered = Math.random() * ceiling;
    const hinted = parseRetryAfterMs(retryAfter, now);
    return hinted === undefined
      ? jittered
      : Math.min(this.maxBackoffMs, Math.max(jittered, hinted));
  }
}

/** A `Retry-After` header (delay-seconds or an HTTP date) in milliseconds from `now`. */
export function parseRetryAfterMs(
  value: string | null | undefined,
  now: number = Date.now(),
): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (/^\s*[+-]?\d+\s*$/.test(value)) return Math.max(0, Number.parseInt(value, 10) * 1000);
  const at = Date.parse(value);
  // A date already past parses to zero, which the jittered floor then outweighs.
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

function finite(value: unknown, name: string, minimum: number): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ConfigurationError(`${name} must be a finite number`);
  }
  if (value < minimum) throw new ConfigurationError(`${name} must be at least ${minimum}`);
}
