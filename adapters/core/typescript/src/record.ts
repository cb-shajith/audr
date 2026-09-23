import { uuidv7 } from './uuid.js';

/** The one AUDR release this package implements. */
export const SPEC_VERSION = '1.0.0';
/** Every `spec_version` this package reads and validates: the 1.0.x releases. */
export const SUPPORTED_SPEC_VERSION = /^1\.0\.\d+$/;

export const EMITTER_COMPONENTS = ['harness', 'router', 'provider'] as const;
export const RESOURCE_TYPES = ['model', 'tool'] as const;
export const MODEL_OPERATIONS = ['generation', 'embedding', 'reranking'] as const;
export const TOOL_OPERATIONS = ['tool_execution', 'retrieval'] as const;
export const OPERATIONS = [...MODEL_OPERATIONS, ...TOOL_OPERATIONS] as const;
export const MODALITIES = ['text', 'image', 'audio', 'multimodal'] as const;
export const RUN_TYPES = ['agent_run', 'workflow', 'single_call'] as const;
export const RUN_OUTCOMES = ['resolved', 'escalated', 'abandoned', 'failed'] as const;
export const ENVIRONMENTS = ['production', 'staging', 'development', 'test', 'evaluation'] as const;

export type EmitterComponent = (typeof EMITTER_COMPONENTS)[number];
export type ResourceType = (typeof RESOURCE_TYPES)[number];
export type Operation = (typeof OPERATIONS)[number];
export type Modality = (typeof MODALITIES)[number];
export type RunType = (typeof RUN_TYPES)[number];
export type RunOutcome = (typeof RUN_OUTCOMES)[number];
export type Environment = (typeof ENVIRONMENTS)[number];

/** An `x_*` provider or implementation counter: a non-negative number. */
export type ExtensionKey = `x_${string}`;

// Every optional property also accepts `undefined`, which the SDK treats as absent, so
// records built from optional runtime values type-check under `exactOptionalPropertyTypes`.

/** The software component that wrote the record. */
export interface Emitter {
  readonly component: EmitterComponent;
  /** Package identifier for the emitter. */
  readonly name: string;
  /** Emitter release, used to attribute data-quality issues. */
  readonly version: string;
}

/** When the operation happened and how long it took. */
export interface Timing {
  /** RFC 3339 with millisecond precision. For streams, use stream termination. */
  readonly event_time: string;
  /** Set by the sink at ingest; an emitter never sends it. */
  readonly received_time?: string | undefined;
  readonly duration_ms?: number | undefined;
}

/** The consumed model or tool. */
export interface Resource {
  /** Canonical lowercase provider slug, such as `anthropic` or `self-hosted`. */
  readonly provider: string;
  readonly type: ResourceType;
  /** Verbatim model identifier, or a stable logical tool name. */
  readonly name: string;
  readonly operation: Operation;
  /** Required for model operations. */
  readonly modality?: Modality | undefined;
  /** Credential label. Never key material or any part of it. */
  readonly key_name?: string | undefined;
  readonly region?: string | undefined;
  readonly deployment?: string | undefined;
}

/** Groups metered operations into a run and span hierarchy. */
export interface Run {
  readonly run_id: string;
  readonly span_id: string;
  readonly name?: string | undefined;
  readonly parent_span_id?: string | undefined;
  readonly step?: number | undefined;
  /** W3C trace identifier: 32 lowercase hex characters. */
  readonly trace_id?: string | undefined;
  readonly run_type?: RunType | undefined;
  readonly error_code?: string | undefined;
  /** At most 32 characters. */
  readonly error_reason?: string | undefined;
  /** Emitted only by the harness. */
  readonly outcome?: RunOutcome | undefined;
}

/** Billability and allocation dimensions. */
export interface Attribution {
  /** Required: a record without it is never rated. */
  readonly environment?: Environment | undefined;
  /** Pseudonymous identity of the user; never an email or name. */
  readonly user_id?: string | undefined;
  /** The account that pays. Required when `environment` is `production`. */
  readonly account_id?: string | undefined;
  readonly subscription_id?: string | undefined;
  /** Up to 20 non-billable dimensions. Never PII. */
  readonly labels?: Readonly<Record<string, string>> | undefined;
}

/** Model-call counters. Absent means unreported; zero means measured as zero. */
export interface LlmUsage {
  readonly input_tokens?: number | undefined;
  readonly output_tokens?: number | undefined;
  readonly cache_read_tokens?: number | undefined;
  readonly cache_write_tokens?: number | undefined;
  readonly reasoning_tokens?: number | undefined;
  readonly requests?: number | undefined;
  readonly images_processed?: number | undefined;
  readonly audio_input_seconds?: number | undefined;
  readonly audio_output_seconds?: number | undefined;
  readonly [counter: ExtensionKey]: number | undefined;
}

/** Tool counters, reported by the component that executed the tool. */
export interface ToolUsage {
  readonly type?: string | undefined;
  readonly call_count?: number | undefined;
  /** Sandbox wall-clock time in milliseconds. */
  readonly sandbox_time?: number | undefined;
  readonly [counter: ExtensionKey]: number | undefined;
}

/** Exactly one of `llm` or `tool`, selected by `resource.operation`. */
export interface Usage {
  readonly llm?: LlmUsage | undefined;
  readonly tool?: ToolUsage | undefined;
}

export interface LlmCost {
  readonly total_token_cost: number;
  readonly input_token_cost?: number | undefined;
  readonly output_token_cost?: number | undefined;
  readonly cache_read_cost?: number | undefined;
  readonly cache_write_cost?: number | undefined;
  readonly reasoning_cost?: number | undefined;
}

export interface ToolCost {
  readonly type?: string | undefined;
  readonly call_cost?: number | undefined;
  readonly sandbox_cost?: number | undefined;
  readonly [amount: ExtensionKey]: number | undefined;
}

/** An informational cost assertion that rating may use or ignore. */
export interface Cost {
  readonly total_cost: number;
  /** Uppercase ISO 4217 code. */
  readonly currency: string;
  readonly llm?: LlmCost | undefined;
  readonly tool?: ToolCost | undefined;
  readonly original_cost?: number | undefined;
  readonly discount_amount?: number | undefined;
  readonly discount_percent?: number | undefined;
}

/** One metered operation in an agent system. */
export interface AudrRecord {
  readonly spec_version: string;
  /** ULID or UUIDv7, fresh for every record. */
  readonly record_id: string;
  /** Left unset to let a `Client` stamp its own emitter on delivery. */
  readonly emitter?: Emitter | undefined;
  /** The `record_id` of an earlier record this one fully restates. */
  readonly corrects?: string | undefined;
  readonly timing: Timing;
  readonly resource: Resource;
  readonly usage: Usage;
  readonly run: Run;
  readonly attribution: Attribution;
  readonly cost?: Cost | undefined;
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
