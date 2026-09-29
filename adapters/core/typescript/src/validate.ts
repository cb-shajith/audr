import { type ErrorCode, issue, type ValidationIssue } from './errors.js';
import { schemaErrors } from './generated-validator.js';
import { type AudrRecord } from './record.js';

export interface ValidateOptions {
  /** The moment `timing.event_time` is compared against. Defaults to now. */
  readonly now?: Date | undefined;
}

/** One failure the generated validator reports, as Ajv shapes it. */
export interface SchemaError {
  readonly keyword: string;
  readonly instancePath: string;
  readonly schemaPath: string;
  readonly params: {
    readonly type?: string | readonly string[];
    readonly missingProperty?: string;
    readonly additionalProperty?: string;
    readonly propertyName?: string;
  };
  /** Set on the failures inside `propertyNames`: the name that broke them. */
  readonly propertyName?: string;
  /** The failing keyword's value. */
  readonly schema: unknown;
  /** The schema object holding the failing keyword. */
  readonly parentSchema: Readonly<Record<string, unknown>>;
}

// Emitter clocks drift, so a record minted slightly ahead of the validator remains valid.
const FUTURE_SKEW_MS = 5 * 60 * 1000;

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const UUID7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TRACE_ID = /^[0-9a-f]{32}$/;
// Set by the sink at ingest; an emitter never sends it.
const SINK_OWNED = '/timing/received_time';
const TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:Z|([+-])(\d{2}):(\d{2}))$/;
const CALLER_KEYED = 'labels';
const REDACTED = '*';

const KEYWORD_CODES: Readonly<Record<string, ErrorCode>> = {
  enum: 'INVALID_ENUM',
  const: 'INVALID_STRUCTURE',
  minLength: 'INVALID_STRING',
  maxLength: 'STRING_TOO_LONG',
  required: 'REQUIRED',
  additionalProperties: 'UNKNOWN_PROPERTY',
  maxProperties: 'TOO_MANY_PROPERTIES',
  propertyNames: 'INVALID_PROPERTY_NAME',
  not: 'FORBIDDEN',
};

/**
 * Codes the failing keyword alone does not decide, by the failing value's path and keyword.
 * Each reports the value itself.
 */
const FIELD_CODES: Readonly<Record<string, ErrorCode>> = {
  '/spec_version pattern': 'UNSUPPORTED_VERSION',
  // The prose narrows both to a ULID or a UUIDv7, which lies within these bounds.
  '/record_id minLength': 'INVALID_IDENTIFIER',
  '/record_id maxLength': 'INVALID_IDENTIFIER',
  '/corrects minLength': 'INVALID_IDENTIFIER',
  '/corrects maxLength': 'INVALID_IDENTIFIER',
  '/cost/currency pattern': 'INVALID_CURRENCY',
  // A record has exactly one usage block, so a missing or a second one breaks its shape.
  '/usage required': 'INVALID_STRUCTURE',
  '/usage not': 'INVALID_STRUCTURE',
};

/**
 * Every rule `value` breaks as an AUDR record; empty when it is conformant. Never throws.
 *
 * Structural rules (the schema, compiled into `generated-validator.ts`, and the formats the
 * prose adds) are checked first. The schema's `allOf` branches and the rules the
 * specification states only in prose run once the record is structurally sound.
 */
export function validate(value: unknown, options: ValidateOptions = {}): ValidationIssue[] {
  return inspect(value, options).issues;
}

/** `validate`, also reporting whether `value` is well-formed enough to be a record. */
export function inspect(
  value: unknown,
  options: ValidateOptions = {},
): { issues: ValidationIssue[]; wellFormed: boolean } {
  const data = asJson(value);
  const schema = schemaIssues(data);
  const structural = [...formatIssues(data), ...schema.structural];
  if (structural.length > 0) {
    return { issues: dedupe(structural), wellFormed: false };
  }
  const now = options.now?.getTime() ?? Date.now();
  return {
    issues: dedupe([...schema.conditional, ...proseIssues(data as AudrRecord, now)]),
    wellFormed: true,
  };
}

/** Schema failures as issues, split by whether an `allOf` branch reported them. */
function schemaIssues(data: unknown): {
  structural: ValidationIssue[];
  conditional: ValidationIssue[];
} {
  const errors = schemaErrors(data);
  const mistyped = new Set(errors.filter((e) => e.keyword === 'type').map((e) => e.instancePath));
  const structural: ValidationIssue[] = [];
  const conditional: ValidationIssue[] = [];
  for (const error of errors) {
    // An `if` failure only restates the `then` failures reported beside it, and a value of the
    // wrong type is reported once rather than again for each constraint it cannot meet.
    if (error.keyword === 'if') continue;
    if (error.keyword !== 'type' && mistyped.has(error.instancePath)) continue;
    const found = toIssue(error, data);
    // A property only a sink may set is forbidden outright, whatever its value.
    if (found.path === SINK_OWNED) continue;
    (error.schemaPath.includes('/allOf/') ? conditional : structural).push(found);
  }
  return { structural, conditional };
}

function toIssue(error: SchemaError, data: unknown): ValidationIssue {
  const segments = error.instancePath.split('/').slice(1).map(unescape);
  const field = FIELD_CODES[`${error.instancePath} ${error.keyword}`];
  if (field !== undefined) return issue(field, pointer(segments));
  const property = propertyOf(error);
  const path = property === undefined ? segments : [...segments, property];
  return issue(codeFor(error, valueAt(data, segments)), pointer(path));
}

function codeFor(error: SchemaError, value: unknown): ErrorCode {
  if (error.propertyName !== undefined) return 'INVALID_PROPERTY_NAME';
  const bound = error.instancePath.startsWith('/cost/') ? 'INVALID_COST' : 'INVALID_COUNTER';
  switch (error.keyword) {
    case 'type':
      // A non-finite number is a number the schema cannot represent, not a wrong type.
      return typeof value === 'number' && [error.params.type].flat().includes('number')
        ? bound
        : 'INVALID_TYPE';
    case 'pattern':
      return error.parentSchema.format === 'date-time' ? 'INVALID_DATETIME' : 'INVALID_STRING';
    case 'minimum':
    case 'maximum':
      return bound;
    case 'minProperties':
      return error.instancePath.startsWith('/usage/') ? 'EMPTY_USAGE' : 'INVALID_STRUCTURE';
    default:
      return KEYWORD_CODES[error.keyword] ?? 'INVALID_STRUCTURE';
  }
}

/** The property a failure names beneath the failing value, if it names one. */
function propertyOf(error: SchemaError): string | undefined {
  // The schema forbids a property `p` as `not: { required: [p] }`.
  if (error.keyword === 'not') {
    const required = isObject(error.schema) ? error.schema.required : undefined;
    return Array.isArray(required) ? String(required[0]) : undefined;
  }
  return (
    error.params.missingProperty ??
    error.params.additionalProperty ??
    error.propertyName ??
    error.params.propertyName
  );
}

// Formats the prose adds to the schema; a record that breaks one is not well-formed.

function formatIssues(data: unknown): ValidationIssue[] {
  if (!isObject(data)) return [];
  const issues: ValidationIssue[] = [];
  for (const key of ['record_id', 'corrects'] as const) {
    const id = data[key];
    if (typeof id === 'string' && !ULID.test(id) && !UUID7.test(id)) {
      issues.push(issue('INVALID_IDENTIFIER', `/${key}`));
    }
  }
  const { timing, run } = data;
  if (isObject(timing)) {
    const eventTime = timing.event_time;
    if (typeof eventTime === 'string' && parseTimestamp(eventTime) === undefined) {
      issues.push(issue('INVALID_DATETIME', '/timing/event_time'));
    }
    if (timing.received_time !== undefined) issues.push(issue('FORBIDDEN', SINK_OWNED));
  }
  if (isObject(run) && typeof run.trace_id === 'string' && !TRACE_ID.test(run.trace_id)) {
    issues.push(issue('INVALID_IDENTIFIER', '/run/trace_id'));
  }
  return issues;
}

// Rules the specification states only in prose.

function proseIssues(record: AudrRecord, now: number): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const eventTime = parseTimestamp(record.timing.event_time);
  if (eventTime && /[1-9]/.test(eventTime.fraction.slice(3))) {
    issues.push(issue('MILLISECOND_PRECISION', '/timing/event_time'));
  }
  if (eventTime && eventTime.epochMs > now + FUTURE_SKEW_MS) {
    issues.push(issue('FUTURE_EVENT_TIME', '/timing/event_time'));
  }
  const { environment, user_id } = record.attribution;
  if (environment === undefined) {
    issues.push(issue('REQUIRED', '/attribution/environment'));
  }
  if (user_id?.includes('@')) {
    issues.push(issue('NON_PSEUDONYMOUS_ID', '/attribution/user_id'));
  }
  return issues;
}

/**
 * `value` as JSON sees it: a property set to `undefined` is absent. A label is caller data,
 * so one set to `undefined` stays, and fails as a value of the wrong type.
 */
function asJson(value: unknown, key?: string): unknown {
  if (!isObject(value)) return value;
  const entries = Object.entries(value);
  const present =
    key === CALLER_KEYED ? entries : entries.filter(([, field]) => field !== undefined);
  return Object.fromEntries(present.map(([name, field]) => [name, asJson(field, name)]));
}

function valueAt(data: unknown, path: readonly string[]): unknown {
  return path.reduce<unknown>((parent, key) => (isObject(parent) ? parent[key] : undefined), data);
}

function unescape(segment: string): string {
  return segment.replaceAll('~1', '/').replaceAll('~0', '~');
}

export function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function pointer(path: readonly PropertyKey[]): string {
  const segments = path.map((segment, index) =>
    index > 0 && path[index - 1] === CALLER_KEYED
      ? REDACTED
      : String(segment).replaceAll('~', '~0').replaceAll('/', '~1'),
  );
  return segments.length === 0 ? '/' : `/${segments.join('/')}`;
}

/** Epoch milliseconds and the raw fraction digits of an RFC 3339 timestamp, if it is one. */
export function parseTimestamp(value: string): { epochMs: number; fraction: string } | undefined {
  const match = TIMESTAMP.exec(value);
  if (!match) return undefined;
  const [, year, month, day, hour, minute, second, fraction = '', sign, offsetH, offsetM] = match;
  const [y, mo, d] = [Number(year), Number(month), Number(day)];
  const [h, mi, s] = [Number(hour), Number(minute), Number(second)];
  const [oh, om] = [Number(offsetH ?? 0), Number(offsetM ?? 0)];
  const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth || h > 23 || mi > 59 || s > 59) {
    return undefined;
  }
  if (oh > 23 || om > 59) return undefined;
  const offsetMinutes = (sign === '-' ? -1 : 1) * (oh * 60 + om);
  const millis = Number(fraction.slice(0, 3).padEnd(3, '0'));
  return { epochMs: Date.UTC(y, mo - 1, d, h, mi, s, millis) - offsetMinutes * 60_000, fraction };
}

function dedupe(issues: ValidationIssue[]): ValidationIssue[] {
  const unique = new Map(issues.map((found) => [`${found.code} ${found.path}`, found]));
  return [...unique.values()];
}
