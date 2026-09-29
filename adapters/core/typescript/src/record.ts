import {
  type AudrRecordShape,
  type Emitter,
  SPEC_VERSION,
  type Timing,
} from './generated-schema.js';
import { uuidv7 } from './uuid.js';

// The record types are generated from the schema. Every optional property also accepts
// `undefined`, which the SDK treats as absent, so records built from optional runtime values
// type-check under `exactOptionalPropertyTypes`.
export type {
  Attribution,
  Cost,
  Emitter,
  EmitterComponent,
  Environment,
  LlmCost,
  LlmUsage,
  Modality,
  Operation,
  Resource,
  ResourceType,
  Run,
  RunOutcome,
  RunType,
  Timing,
  ToolCost,
  ToolUsage,
  Usage,
} from './generated-schema.js';

/** One metered operation in an agent system. */
export interface AudrRecord extends Omit<AudrRecordShape, 'emitter'> {
  /** Left unset to let a `Client` stamp its own emitter on delivery. */
  readonly emitter?: Emitter | undefined;
}

/** The fields `createRecord` needs; everything SDK-owned is optional. */
export interface RecordInput extends Omit<AudrRecord, 'spec_version' | 'record_id' | 'timing'> {
  readonly spec_version?: string | undefined;
  readonly record_id?: string | undefined;
  readonly timing?:
    (Omit<Timing, 'event_time'> & { readonly event_time?: Date | string | undefined }) | undefined;
}

/**
 * Build a record, filling what the SDK owns: `spec_version`, a fresh UUIDv7 `record_id`,
 * and `timing.event_time` (now, unless given). A `Date` is rendered as RFC 3339 with
 * millisecond precision. The record is not validated here; `Client.record()` does that.
 */
export function createRecord(input: RecordInput): AudrRecord {
  const { timing, ...rest } = input;
  const eventTime = timing?.event_time ?? new Date();
  return {
    ...rest,
    spec_version: input.spec_version ?? SPEC_VERSION,
    record_id: input.record_id ?? uuidv7(),
    timing: {
      ...timing,
      event_time: typeof eventTime === 'string' ? eventTime : toTimestamp(eventTime),
    },
  };
}

function toTimestamp(date: Date): string {
  return Number.isNaN(date.getTime()) ? String(date) : date.toISOString();
}
