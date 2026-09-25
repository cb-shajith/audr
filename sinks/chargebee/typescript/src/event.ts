/**
 * The Chargebee usage event and the destination's envelope rules: the identifier length
 * limits, the 13-digit millisecond timestamp, the property-name pattern and its reserved
 * names, and the scalar-only property values the batch endpoint accepts. These are
 * Chargebee's rules, not AUDR's.
 */

/** A scalar Chargebee property value. */
export type PropertyValue = string | number | boolean | null;

/** One event in the body of a batch ingest request. */
export interface UsageEvent {
  readonly subscription_id: string;
  readonly usage_timestamp: number;
  readonly deduplication_id: string;
  readonly properties: Readonly<Record<string, PropertyValue>>;
}

/** A usage event breaks a destination rule. The message names fields, never values. */
export class InvalidUsageEventError extends Error {
  override readonly name: string = 'InvalidUsageEventError';
}

const MAX_SUBSCRIPTION_ID_LENGTH = 50;
const MAX_DEDUPLICATION_ID_LENGTH = 36;
const MILLISECOND_TIMESTAMP_DIGITS = 13;
const PROPERTY_NAME = /^[a-zA-Z][a-zA-Z0-9_]*$/;
const SURROGATE_PAIR = /[\uD800-\uDBFF][\uDC00-\uDFFF]/g;
const RESERVED_PROPERTY_NAMES = new Set([
  'deduplication_id',
  'error_codes',
  'event_meta',
  'ingestion_timestamp',
  'properties',
  'subscription_id',
  'usage_timestamp',
]);

/** Validate `event` against the destination's rules, throwing `InvalidUsageEventError`. */
export function validateEvent(event: UsageEvent): UsageEvent {
  identifier(event.subscription_id, 'subscription_id', MAX_SUBSCRIPTION_ID_LENGTH);
  identifier(event.deduplication_id, 'deduplication_id', MAX_DEDUPLICATION_ID_LENGTH);
  const timestamp: unknown = event.usage_timestamp;
  if (typeof timestamp !== 'number' || !Number.isInteger(timestamp)) {
    throw new InvalidUsageEventError('usage_timestamp must be an integer');
  }
  if (String(timestamp).length !== MILLISECOND_TIMESTAMP_DIGITS) {
    throw new InvalidUsageEventError(
      'usage_timestamp must be a 13-digit epoch-millisecond value; a 10-digit value is ' +
        'epoch seconds and the destination rejects it',
    );
  }
  properties(event.properties);
  return event;
}

function identifier(value: unknown, name: string, maxLength: number): void {
  if (typeof value !== 'string') throw new InvalidUsageEventError(`${name} must be a string`);
  if (value.trim() === '') throw new InvalidUsageEventError(`${name} must not be empty`);
  if (codePoints(value) > maxLength) {
    throw new InvalidUsageEventError(`${name} must be at most ${maxLength} characters`);
  }
}

/** A string's length in code points, as the destination and the Python sink count it. */
function codePoints(value: string): number {
  return value.length - (value.match(SURROGATE_PAIR)?.length ?? 0);
}

function properties(value: unknown): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidUsageEventError('properties must be a JSON object');
  }
  const entries = Object.entries(value);
  if (entries.length === 0) throw new InvalidUsageEventError('properties must not be empty');
  for (const [key, item] of entries) {
    if (!PROPERTY_NAME.test(key)) {
      throw new InvalidUsageEventError(
        `properties name '${key}' must start with a letter and contain only letters, ` +
          'digits, and underscores',
      );
    }
    if (RESERVED_PROPERTY_NAMES.has(key)) {
      throw new InvalidUsageEventError(`properties name '${key}' is reserved`);
    }
    if (item !== null && !['string', 'number', 'boolean'].includes(typeof item)) {
      throw new InvalidUsageEventError(
        `properties value for '${key}' must be a scalar; the destination fails on nested ` +
          `objects and arrays, got ${Array.isArray(item) ? 'array' : typeof item}`,
      );
    }
    if (typeof item === 'number' && !Number.isFinite(item)) {
      throw new InvalidUsageEventError(
        `properties value for '${key}' must be a finite JSON number`,
      );
    }
  }
}
