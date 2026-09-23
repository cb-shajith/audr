import { type ErrorCode, issue, type ValidationIssue } from './errors.js';
import {
  type AudrRecord,
  EMITTER_COMPONENTS,
  ENVIRONMENTS,
  MODALITIES,
  MODEL_OPERATIONS,
  OPERATIONS,
  RESOURCE_TYPES,
  RUN_OUTCOMES,
  RUN_TYPES,
  SUPPORTED_SPEC_VERSION,
  TOOL_OPERATIONS,
} from './record.js';

export interface ValidateOptions {
  /** The moment `timing.event_time` is compared against. Defaults to now. */
  readonly now?: Date | undefined;
}

/**
 * Every rule `value` breaks as an AUDR record; empty when it is conformant. Never throws.
 *
 * Structural rules (types, formats, closed objects) are checked first. The cross-field
 * rules the specification states in prose run once the record is structurally sound.
 */
export function validate(value: unknown, options: ValidateOptions = {}): ValidationIssue[] {
  return inspect(value, options).issues;
}

/** `validate`, also reporting whether `value` is well-formed enough to be a record. */
export function inspect(
  value: unknown,
  options: ValidateOptions = {},
): { issues: ValidationIssue[]; wellFormed: boolean } {
  const structural: ValidationIssue[] = [];
  checkRecord(value, '', structural);
  if (structural.length > 0) {
    return { issues: dedupe(structural), wellFormed: false };
  }
  const now = options.now?.getTime() ?? Date.now();
  return { issues: dedupe(crossFieldIssues(value as AudrRecord, now)), wellFormed: true };
}

// Structural rules, transcribed from spec/audr.schema.json. `tests/schema.test.ts` fails if
// a property or enumerant here drifts from the schema.

type Check = (value: unknown, path: string, issues: ValidationIssue[]) => void;

export interface Shape {
  readonly required: readonly string[];
  readonly properties: Readonly<Record<string, Check>>;
  /** The code for a bad `x_*` value; a shape without it admits no extensions. */
  readonly extensions?: ErrorCode;
  /** The code when the object is empty; a shape without it may be empty. */
  readonly nonEmpty?: ErrorCode;
}

const EXTENSION_KEY = /^x_[a-z0-9_]+$/;
const LABEL_KEY = /^[a-zA-Z0-9_.-]+$/;
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const UUID7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:Z|([+-])(\d{2}):(\d{2}))$/;
// Emitter clocks drift, so a record minted slightly ahead of the validator remains valid.
const FUTURE_SKEW_MS = 5 * 60 * 1000;
// Label keys are caller data, not schema names, so a label's path never includes its key.
const REDACTED = '*';
const SURROGATE_PAIR = /[\uD800-\uDBFF][\uDC00-\uDFFF]/g;

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(
  rules: { min?: number; max?: number; pattern?: RegExp; patternCode?: ErrorCode } = {},
): Check {
  return (value, path, issues) => {
    if (typeof value !== 'string') {
      issues.push(issue('INVALID_TYPE', path));
    } else if (rules.max !== undefined && codePoints(value) > rules.max) {
      issues.push(issue('STRING_TOO_LONG', path));
    } else if (codePoints(value) < (rules.min ?? 0)) {
      issues.push(issue('INVALID_STRING', path));
    } else if (rules.pattern && !rules.pattern.test(value)) {
      issues.push(issue(rules.patternCode ?? 'INVALID_STRING', path));
    }
  };
}

function oneOf(allowed: readonly string[]): Check {
  return (value, path, issues) => {
    if (typeof value !== 'string' || !allowed.includes(value)) {
      issues.push(issue('INVALID_ENUM', path));
    }
  };
}

function numeric(code: ErrorCode, rules: { integer?: boolean; max?: number } = {}): Check {
  return (value, path, issues) => {
    if (typeof value !== 'number') {
      issues.push(issue('INVALID_TYPE', path));
    } else if (rules.integer && !Number.isInteger(value)) {
      issues.push(issue('INVALID_TYPE', path));
    } else if (!Number.isFinite(value) || value < 0 || value > (rules.max ?? Infinity)) {
      issues.push(issue(code, path));
    }
  };
}

const identifier: Check = (value, path, issues) => {
  if (typeof value !== 'string') {
    issues.push(issue('INVALID_TYPE', path));
  } else if (!ULID.test(value) && !UUID7.test(value)) {
    issues.push(issue('INVALID_IDENTIFIER', path));
  }
};

const timestamp: Check = (value, path, issues) => {
  if (typeof value !== 'string') {
    issues.push(issue('INVALID_TYPE', path));
  } else if (parseTimestamp(value) === undefined) {
    issues.push(issue('INVALID_DATETIME', path));
  }
};

const forbidden: Check = (_value, path, issues) => {
  issues.push(issue('FORBIDDEN', path));
};

const labels: Check = (value, path, issues) => {
  if (!isObject(value)) {
    issues.push(issue('INVALID_TYPE', path));
    return;
  }
  const entries = Object.entries(value);
  if (entries.length > 20) {
    issues.push(issue('TOO_MANY_PROPERTIES', path));
  }
  const entryPath = `${path}/${REDACTED}`;
  for (const [key, label] of entries) {
    if (codePoints(key) > 64 || !LABEL_KEY.test(key)) {
      issues.push(issue('INVALID_PROPERTY_NAME', entryPath));
    }
    text({ max: 256 })(label, entryPath, issues);
  }
};

function object(shape: Shape): Check & { readonly shape: Shape } {
  const check: Check = (value, path, issues) => {
    if (!isObject(value)) {
      issues.push(issue('INVALID_TYPE', path || '/'));
      return;
    }
    for (const key of shape.required) {
      if (value[key] === undefined) {
        issues.push(issue('REQUIRED', `${path}/${key}`));
      }
    }
    const entries = Object.entries(value).filter(([, field]) => field !== undefined);
    if (shape.nonEmpty && entries.length === 0) {
      issues.push(issue(shape.nonEmpty, path));
    }
    for (const [key, field] of entries) {
      const fieldPath = `${path}/${escape(key)}`;
      const property = Object.hasOwn(shape.properties, key) ? shape.properties[key] : undefined;
      if (property) {
        property(field, fieldPath, issues);
      } else if (shape.extensions && EXTENSION_KEY.test(key)) {
        numeric(shape.extensions)(field, fieldPath, issues);
      } else {
        issues.push(issue('UNKNOWN_PROPERTY', fieldPath));
      }
    }
  };
  return Object.assign(check, { shape });
}

const counter = numeric('INVALID_COUNTER', { integer: true });
const quantity = numeric('INVALID_COUNTER');
const amount = numeric('INVALID_COST');
const nonEmpty = text({ min: 1 });
const anyText = text();

const emitter = object({
  required: ['component', 'name', 'version'],
  properties: { component: oneOf(EMITTER_COMPONENTS), name: nonEmpty, version: nonEmpty },
});

const timing = object({
  required: ['event_time'],
  properties: { event_time: timestamp, received_time: forbidden, duration_ms: counter },
});

const resource = object({
  required: ['provider', 'type', 'name', 'operation'],
  properties: {
    provider: text({ pattern: /^[a-z0-9-]+$/ }),
    type: oneOf(RESOURCE_TYPES),
    name: nonEmpty,
    operation: oneOf(OPERATIONS),
    modality: oneOf(MODALITIES),
    key_name: anyText,
    region: anyText,
    deployment: nonEmpty,
  },
});

const run = object({
  required: ['run_id', 'span_id'],
  properties: {
    run_id: text({ min: 8, max: 64 }),
    name: nonEmpty,
    span_id: nonEmpty,
    parent_span_id: nonEmpty,
    step: counter,
    trace_id: text({ pattern: /^[0-9a-f]{32}$/, patternCode: 'INVALID_IDENTIFIER' }),
    run_type: oneOf(RUN_TYPES),
    error_code: nonEmpty,
    error_reason: text({ max: 32 }),
    outcome: oneOf(RUN_OUTCOMES),
  },
});

const attribution = object({
  required: [],
  properties: {
    environment: oneOf(ENVIRONMENTS),
    user_id: anyText,
    account_id: nonEmpty,
    subscription_id: anyText,
    labels,
  },
});

const llmUsage = object({
  required: [],
  nonEmpty: 'EMPTY_USAGE',
  extensions: 'INVALID_COUNTER',
  properties: {
    input_tokens: counter,
    output_tokens: counter,
    cache_read_tokens: counter,
    cache_write_tokens: counter,
    reasoning_tokens: counter,
    requests: counter,
    images_processed: counter,
    audio_input_seconds: quantity,
    audio_output_seconds: quantity,
  },
});

const toolUsage = object({
  required: [],
  nonEmpty: 'EMPTY_USAGE',
  extensions: 'INVALID_COUNTER',
  properties: { type: nonEmpty, call_count: counter, sandbox_time: quantity },
});

const usage = object({ required: [], properties: { llm: llmUsage, tool: toolUsage } });

const llmCost = object({
  required: ['total_token_cost'],
  properties: {
    total_token_cost: amount,
    input_token_cost: amount,
    output_token_cost: amount,
    cache_read_cost: amount,
    cache_write_cost: amount,
    reasoning_cost: amount,
  },
});

const toolCost = object({
  required: [],
  nonEmpty: 'INVALID_STRUCTURE',
  extensions: 'INVALID_COST',
  properties: { type: nonEmpty, call_cost: amount, sandbox_cost: amount },
});

const cost = object({
  required: ['total_cost', 'currency'],
  properties: {
    total_cost: amount,
    currency: text({ pattern: /^[A-Z]{3}$/, patternCode: 'INVALID_CURRENCY' }),
    llm: llmCost,
    tool: toolCost,
    original_cost: amount,
    discount_amount: amount,
    discount_percent: numeric('INVALID_COST', { max: 100 }),
  },
});

const checkRecord = object({
  required: [
    'spec_version',
    'record_id',
    'emitter',
    'timing',
    'resource',
    'usage',
    'run',
    'attribution',
  ],
  properties: {
    spec_version: text({ pattern: SUPPORTED_SPEC_VERSION, patternCode: 'UNSUPPORTED_VERSION' }),
    record_id: identifier,
    emitter,
    corrects: identifier,
    timing,
    resource,
    usage,
    run,
    attribution,
    cost,
  },
});

/** Every object shape, keyed by its dotted path in the schema; `''` is the record. */
export const SHAPES: Readonly<Record<string, Shape>> = {
  '': checkRecord.shape,
  emitter: emitter.shape,
  timing: timing.shape,
  resource: resource.shape,
  run: run.shape,
  attribution: attribution.shape,
  usage: usage.shape,
  'usage.llm': llmUsage.shape,
  'usage.tool': toolUsage.shape,
  cost: cost.shape,
  'cost.llm': llmCost.shape,
  'cost.tool': toolCost.shape,
};

// Cross-field rules: what the specification states in prose or in `allOf` branches.

function crossFieldIssues(record: AudrRecord, now: number): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const eventTime = parseTimestamp(record.timing.event_time);
  if (eventTime && /[1-9]/.test(eventTime.fraction.slice(3))) {
    issues.push(issue('MILLISECOND_PRECISION', '/timing/event_time'));
  }
  if (eventTime && eventTime.epochMs > now + FUTURE_SKEW_MS) {
    issues.push(issue('FUTURE_EVENT_TIME', '/timing/event_time'));
  }

  const { resource, usage: counters, cost: asserted } = record;
  if ((counters.llm === undefined) === (counters.tool === undefined)) {
    issues.push(issue('INVALID_STRUCTURE', '/usage'));
  }
  if (isOneOf(resource.operation, MODEL_OPERATIONS)) {
    if (resource.type !== 'model') issues.push(issue('INVALID_STRUCTURE', '/resource/type'));
    if (resource.modality === undefined) issues.push(issue('REQUIRED', '/resource/modality'));
    if (counters.llm === undefined) issues.push(issue('INVALID_STRUCTURE', '/usage'));
    if (asserted?.tool !== undefined) issues.push(issue('FORBIDDEN', '/cost/tool'));
  } else if (isOneOf(resource.operation, TOOL_OPERATIONS)) {
    if (resource.type !== 'tool') issues.push(issue('INVALID_STRUCTURE', '/resource/type'));
    if (counters.tool === undefined) issues.push(issue('INVALID_STRUCTURE', '/usage'));
    if (asserted?.llm !== undefined) issues.push(issue('FORBIDDEN', '/cost/llm'));
  }

  const { environment, account_id, user_id } = record.attribution;
  if (environment === undefined) {
    issues.push(issue('REQUIRED', '/attribution/environment'));
  } else if (environment === 'production' && account_id === undefined) {
    issues.push(issue('REQUIRED', '/attribution/account_id'));
  }
  if (user_id?.includes('@')) {
    issues.push(issue('NON_PSEUDONYMOUS_ID', '/attribution/user_id'));
  }
  return issues;
}

function isOneOf<T extends string>(value: string, allowed: readonly T[]): value is T {
  return (allowed as readonly string[]).includes(value);
}

/** Epoch milliseconds and the raw fraction digits of an RFC 3339 timestamp, if it is one. */
function parseTimestamp(value: string): { epochMs: number; fraction: string } | undefined {
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

/** A string's length in code points, as JSON Schema `minLength` and `maxLength` count it. */
function codePoints(value: string): number {
  return value.length - (value.match(SURROGATE_PAIR)?.length ?? 0);
}

function escape(segment: string): string {
  return segment.replaceAll('~', '~0').replaceAll('/', '~1');
}

function dedupe(issues: ValidationIssue[]): ValidationIssue[] {
  const unique = new Map(issues.map((found) => [`${found.code} ${found.path}`, found]));
  return [...unique.values()];
}
