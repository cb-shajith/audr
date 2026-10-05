/**
 * The Lago event and the destination's envelope rules: the required identifiers, the Unix
 * timestamp with fractional seconds, and the string-or-number property values the batch
 * endpoint's OpenAPI schema permits. These are Lago's rules, not AUDR's.
 */

/** A Lago property value. The batch schema permits strings, integers and numbers only. */
export type PropertyValue = string | number;

/** One event in the body of a batch request. */
export interface LagoEvent {
  readonly transaction_id: string;
  readonly external_subscription_id: string;
  readonly code: string;
  /** Unix seconds as a decimal string with millisecond precision, such as `1651240791.123`. */
  readonly timestamp: string;
  readonly properties: Readonly<Record<string, PropertyValue>>;
}

export interface EventFields {
  readonly transactionId: string;
  readonly subscriptionId: string | undefined;
  readonly code: string | undefined;
  /** An RFC 3339 instant. */
  readonly eventTime: string;
  readonly properties: Readonly<Record<string, PropertyValue>>;
}

/**
 * A record cannot become a valid event. The message is the rejection detail: a stable code,
 * followed by a JSON pointer where a field is at fault, and never a field value.
 */
export class InvalidEventError extends Error {
  override readonly name: string = 'InvalidEventError';
}

/** Build an immutable event from `fields`, throwing `InvalidEventError` on a rule it breaks. */
export function createEvent(fields: EventFields): LagoEvent {
  const { subscriptionId, transactionId, code } = fields;
  if (!isPresent(subscriptionId)) throw new InvalidEventError('missing_subscription_id');
  if (!isPresent(transactionId)) throw new InvalidEventError('invalid_field:/record_id');
  if (code === undefined) throw new InvalidEventError('missing_metric_code');
  if (!isMetricCode(code)) throw new InvalidEventError('invalid_metric_code');
  const timestamp = formatTimestamp(fields.eventTime);
  validateProperties(fields.properties);
  return Object.freeze({
    transaction_id: transactionId,
    external_subscription_id: subscriptionId,
    code,
    timestamp,
    properties: Object.freeze({ ...fields.properties }),
  });
}

/**
 * Whether `code` can name a billable metric. Lago ignores an event whose code matches no
 * metric, so a stray space silently stops billing.
 */
export function isMetricCode(code: unknown): code is string {
  return typeof code === 'string' && code !== '' && code === code.trim();
}

/**
 * Convert an RFC 3339 instant to Unix seconds with three decimals. The conversion is exact
 * integer arithmetic, so the same instant always yields the same string; a retry that
 * changed the timestamp would be a different event on a ClickHouse event store.
 */
export function formatTimestamp(eventTime: string): string {
  const milliseconds = typeof eventTime === 'string' ? Date.parse(eventTime) : Number.NaN;
  if (!Number.isInteger(milliseconds) || milliseconds < 0) {
    throw new InvalidEventError('invalid_timestamp');
  }
  const seconds = Math.floor(milliseconds / 1000);
  return `${seconds}.${String(milliseconds % 1000).padStart(3, '0')}`;
}

function isPresent(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function validateProperties(properties: unknown): void {
  if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) {
    throw new InvalidEventError('unencodable_field:/properties');
  }
  for (const [name, value] of Object.entries(properties)) {
    const encodable =
      name !== '' &&
      (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)));
    if (!encodable)
      throw new InvalidEventError(`unencodable_field:${pointer(['properties', name])}`);
  }
}

/** A JSON pointer (RFC 6901) for `segments`. */
export function pointer(segments: readonly string[]): string {
  return segments
    .map((segment) => `/${segment.replaceAll('~', '~0').replaceAll('/', '~1')}`)
    .join('');
}
