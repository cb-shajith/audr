/**
 * Conversion of AUDR records into Chargebee properties.
 *
 * Chargebee's ingest API accepts only scalar property values, so nested AUDR objects are
 * flattened here, in the sink, rather than in the record model. Nested objects become
 * `parent_child` keys; arrays and the caller-keyed `labels` map are stored as canonical
 * JSON under a terminal `json` key, so the destination only ever sees scalars.
 */
import { type AudrRecord } from 'audr';

import { InvalidUsageEventError, type PropertyValue } from './event.js';

const JSON_SUFFIX = 'json';
// Label keys are chosen by the caller; flattening them would mint unbounded property names.
const JSON_CONTAINER_KEYS = new Set(['labels']);

export interface FlattenOptions {
  /** Joins path segments. Chargebee needs one or more underscores. Default `_`. */
  readonly separator?: string | undefined;
}

/** Flatten every field of an AUDR record into Chargebee scalar properties. */
export function flattenRecord(
  record: AudrRecord,
  options: FlattenOptions = {},
): Record<string, PropertyValue> {
  return flatten(record, options);
}

/** Flatten a nested JSON object into Chargebee scalar properties. */
export function flatten(
  nested: unknown,
  { separator = '_' }: FlattenOptions = {},
): Record<string, PropertyValue> {
  if (!isPlainObject(nested)) {
    throw new InvalidUsageEventError('record must encode to a JSON object');
  }
  const output: Record<string, PropertyValue> = {};
  flattenInto(nested, [], output, separator);
  return output;
}

function flattenInto(
  value: Readonly<Record<string, unknown>>,
  path: readonly string[],
  output: Record<string, PropertyValue>,
  separator: string,
): void {
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    const itemPath = [...path, key];
    if (Array.isArray(item) || (isPlainObject(item) && JSON_CONTAINER_KEYS.has(key))) {
      output[[...itemPath, JSON_SUFFIX].join(separator)] = canonicalJson(item, itemPath);
    } else if (isPlainObject(item)) {
      flattenInto(item, itemPath, output, separator);
    } else if (isScalar(item)) {
      output[itemPath.join(separator)] = item;
    } else {
      throw notEncodable(itemPath);
    }
  }
}

/** JSON with sorted keys; refuses what `JSON.stringify` would silently coerce, like `NaN`. */
function canonicalJson(value: unknown, path: readonly string[]): string {
  return JSON.stringify(canonical(value, path));
}

function canonical(value: unknown, path: readonly string[]): unknown {
  if (typeof value === 'number' && !Number.isFinite(value)) throw notEncodable(path);
  if (isScalar(value)) return value;
  if (Array.isArray(value)) return value.map((item: unknown) => canonical(item, path));
  if (isPlainObject(value)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) sorted[key] = canonical(value[key], path);
    }
    return sorted;
  }
  throw notEncodable(path);
}

function isScalar(value: unknown): value is PropertyValue {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function notEncodable(path: readonly string[]): InvalidUsageEventError {
  return new InvalidUsageEventError(`field at ${pointer(path)} is not JSON-encodable`);
}

function pointer(segments: readonly string[]): string {
  return `/${segments.map((segment) => segment.replaceAll('~', '~0').replaceAll('/', '~1')).join('/')}`;
}
