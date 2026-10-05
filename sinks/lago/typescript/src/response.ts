/**
 * Interpretation of Lago's responses: which class an HTTP status belongs to, and which events
 * a `422` names. Lago reports a validation failure by the event's position in the request, in
 * `error_details`, for example `{"1": {"transaction_id": ["value_already_exist"]}}`, or with a
 * message in place of the field codes when a billable metric's expression fails. Nothing from
 * a response body is ever surfaced: details are rebuilt from allowlisted names.
 */
import { isTransient } from './retry.js';

export type StatusClass =
  | 'accepted'
  | 'unconfirmed'
  | 'invalid'
  | 'credential'
  | 'forbidden'
  | 'too_large'
  | 'transient'
  | 'permanent';

/**
 * Classify an HTTP status. Only `200` is documented success; another `2xx` neither confirms
 * nor refuses the events.
 */
export function classifyStatus(status: number): StatusClass {
  if (status === 200) return 'accepted';
  if (status > 200 && status < 300) return 'unconfirmed';
  if (status === 422) return 'invalid';
  if (status === 401) return 'credential';
  if (status === 403) return 'forbidden';
  if (status === 413) return 'too_large';
  return isTransient(status) ? 'transient' : 'permanent';
}

export interface InvalidEvent {
  /** The event's position in the request. */
  readonly index: number;
  /** A value-free `field:code` pair built from allowlisted names. */
  readonly detail: string;
}

/** What a `422` says about the events of one request. */
export interface ValidationVerdict {
  /** Positions of events Lago already holds. */
  readonly duplicates: readonly number[];
  /** Events Lago refused, in request order. */
  readonly invalid: readonly InvalidEvent[];
}

const INDEX = /^(?:0|[1-9]\d*)$/;
const DUPLICATE_FIELD = 'transaction_id';
const DUPLICATE_CODE = 'value_already_exist';
const FIELDS = new Set([
  DUPLICATE_FIELD,
  'external_subscription_id',
  'code',
  'timestamp',
  'properties',
]);
const CODES = new Set([DUPLICATE_CODE, 'value_is_mandatory', 'invalid_format']);
const EXPRESSION_FAILURE = 'event:expression_evaluation_failed';
const TOO_MANY_EVENTS = 'too_many_events';

/**
 * Read a `422` body into per-event verdicts, or `undefined` when it cannot be trusted.
 *
 * A body is trusted only when every key of `error_details` is a canonical position inside the
 * request and every entry is a message or lists at least one error. Anything else is
 * ambiguous, and acting on a guess could drop an event Lago would have taken.
 *
 * An event whose only error is `value_already_exist` on `transaction_id` is a duplicate:
 * Lago holds it already, which is how an earlier delivery of the same record shows up on a
 * Postgres event store. Any other event named is invalid. Lago names an event with a message,
 * which is never read, when the billable metric's expression cannot be evaluated for it.
 */
export function parseValidationErrors(
  body: unknown,
  eventCount: number,
): ValidationVerdict | undefined {
  const details = isObject(body) ? body.error_details : undefined;
  if (!isObject(details)) return undefined;
  const entries = Object.entries(details);
  if (entries.length === 0) return undefined;

  const duplicates: number[] = [];
  const invalid: InvalidEvent[] = [];
  for (const [key, errors] of entries) {
    if (!INDEX.test(key) || Number(key) >= eventCount) return undefined;
    const index = Number(key);
    if (typeof errors === 'string') {
      invalid.push({ index, detail: EXPRESSION_FAILURE });
      continue;
    }
    const pairs = errorPairs(errors);
    if (pairs === undefined) return undefined;
    const refusal = pairs.find(
      ([field, code]) => field !== DUPLICATE_FIELD || code !== DUPLICATE_CODE,
    );
    if (refusal === undefined) duplicates.push(index);
    else
      invalid.push({
        index,
        detail: `${allowed(FIELDS, refusal[0], 'event')}:${allowed(CODES, refusal[1], 'validation_error')}`,
      });
  }
  return {
    duplicates: duplicates.sort((a, b) => a - b),
    invalid: invalid.sort((a, b) => a.index - b.index),
  };
}

/**
 * Whether a `422` refuses the whole request for holding more events than the Lago instance
 * accepts, which a self-hosted Lago sets with `LAGO_EVENTS_BATCH_MAX_LENGTH`.
 */
export function exceedsBatchLimit(body: unknown): boolean {
  const details = isObject(body) ? body.error_details : undefined;
  const errors = isObject(details) ? details.events : undefined;
  return Array.isArray(errors) && (errors as unknown[]).includes(TOO_MANY_EVENTS);
}

/** The `[field, code]` pairs of one event's errors, fields in name order. */
function errorPairs(errors: unknown): [string, string][] | undefined {
  if (!isObject(errors)) return undefined;
  const pairs: [string, string][] = [];
  for (const field of Object.keys(errors).sort()) {
    const codes = errors[field];
    if (!Array.isArray(codes) || codes.length === 0) return undefined;
    for (const code of codes as unknown[]) {
      if (typeof code !== 'string') return undefined;
      pairs.push([field, code]);
    }
  }
  return pairs.length === 0 ? undefined : pairs;
}

function allowed(names: ReadonlySet<string>, name: string, fallback: string): string {
  return names.has(name) ? name : fallback;
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
