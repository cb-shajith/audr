import type { Telemetry } from 'ai';
import {
  type Attribution,
  type Client,
  ConfigurationError,
  createRecord,
  type Logger,
  type Operation,
  type Resource,
  type Usage,
} from '@openaudr/audr';

import { type AttributionSource, resolveAttribution } from './attribution.js';
import { Diagnostics, errorName, formatIssues } from './diagnostics.js';
import {
  counter,
  durationMs,
  embedSpanId,
  isProviderSlug,
  isSupportedOperation,
  modelSpanId,
  providerSlug,
  rerankSpanId,
  runTypeFor,
  TOOL_ERROR_CODE,
  TOOL_PROVIDER,
  toLlmUsage,
} from './mapping.js';
import {
  CallTracker,
  closeToolSpan,
  openToolSpan,
  type ToolSpan,
  toolSpanFor,
  type TrackedCall,
} from './runs.js';

const DEFAULT_MAX_TRACKED_OPERATIONS = 10_000;

export interface AudrTelemetryOptions {
  /** The host's client. The adapter never creates, flushes or shuts it down. */
  readonly client: Client;
  /** Applied field by field under per-call attribution. Omit `environment` to require it per call. */
  readonly attributionDefaults?: Attribution | undefined;
  /** Overrides the provider slug and model name for a model call. Returning `undefined` or `null` keeps the default; throwing skips the record. */
  readonly mapResource?:
    ((source: ResourceSource) => ResourceMapping | null | undefined) | undefined;
  /** Upper bound on concurrently tracked operations, sub-agents included. Integer >= 1. Default 10_000. */
  readonly maxTrackedOperations?: number | undefined;
  /** Where diagnostics go. Default `console`. Messages never carry record values. */
  readonly logger?: Logger | undefined;
}

export interface ResourceSource {
  /** The AI SDK provider id, e.g. `openai.responses`, `anthropic.messages`, `gateway`. */
  readonly provider: string;
  /** The model id from the end event (provider-echoed for language models). */
  readonly modelId: string;
}

export interface ResourceMapping {
  /** Must match `^[a-z0-9-]+$`. */
  readonly provider: string;
  readonly name: string;
}

type EventOf<K extends keyof Telemetry> = Parameters<NonNullable<Telemetry[K]>>[0];

type ModelOperation = Extract<Operation, 'generation' | 'embedding' | 'reranking'>;

interface RecordParts {
  readonly spanId: string;
  readonly durationMs: number | undefined;
  readonly resource: Resource;
  readonly usage: Usage;
  readonly errorCode?: string | undefined;
}

/**
 * An AI SDK 7 telemetry integration that turns every provider model call, client-side tool
 * execution, embedding call and rerank call into one AUDR record for the host's `client`.
 *
 * ```ts
 * registerTelemetry(audrTelemetry({ client, attributionDefaults: { environment: 'production' } }));
 * ```
 *
 * Reads usage, identifiers and timings only; never prompts, messages, content, tool inputs,
 * tool outputs or errors. Throws `ConfigurationError` for invalid options; its hooks never
 * throw into the AI SDK.
 */
export function audrTelemetry(options: AudrTelemetryOptions): Telemetry {
  return new AudrTelemetry(options);
}

class AudrTelemetry implements Telemetry {
  readonly #client: Client;
  readonly #defaults: Attribution | undefined;
  readonly #mapResource: AudrTelemetryOptions['mapResource'];
  readonly #diagnostics: Diagnostics;
  readonly #tracker: CallTracker;
  readonly #warnedUnsupported = new Set<string>();

  constructor(options: AudrTelemetryOptions) {
    const candidate = options as Partial<AudrTelemetryOptions> | null | undefined;
    if (typeof (candidate?.client as Partial<Client> | undefined)?.record !== 'function') {
      throw new ConfigurationError('client must implement record()');
    }
    const maxTrackedOperations = options.maxTrackedOperations ?? DEFAULT_MAX_TRACKED_OPERATIONS;
    if (!Number.isInteger(maxTrackedOperations) || maxTrackedOperations < 1) {
      throw new ConfigurationError('maxTrackedOperations must be an integer >= 1');
    }
    const defaults: unknown = options.attributionDefaults;
    if (defaults !== undefined && (typeof defaults !== 'object' || defaults === null)) {
      throw new ConfigurationError('attributionDefaults must be an object');
    }
    const mapResource: unknown = options.mapResource;
    if (mapResource !== undefined && typeof mapResource !== 'function') {
      throw new ConfigurationError('mapResource must be a function');
    }
    this.#client = options.client;
    this.#defaults = options.attributionDefaults;
    this.#mapResource = options.mapResource;
    this.#diagnostics = new Diagnostics(options.logger ?? console);
    this.#tracker = new CallTracker(maxTrackedOperations);
  }

  onStart(event: EventOf<'onStart'>): void {
    this.#guard('onStart', () => {
      if (!isSupportedOperation(event.operationId)) {
        this.#warnUnsupportedOnce(event.operationId);
        return;
      }
      const toolSpan = this.#tracker.currentToolSpan();
      if (toolSpan !== undefined) {
        this.#warnIfEvicted(this.#tracker.startChild(event.callId, event.operationId, toolSpan));
        return;
      }
      const source: AttributionSource = {
        operationId: event.operationId,
        functionId: nonEmpty(event.functionId),
        runtimeContext: asObject('runtimeContext' in event ? event.runtimeContext : undefined),
      };
      const resolution = resolveAttribution(source, this.#defaults);
      switch (resolution.kind) {
        case 'unresolved':
          this.#diagnostics.warn('ATTRIBUTION_UNRESOLVED', { operation: event.operationId });
          return;
        case 'resolved':
          this.#warnIfEvicted(
            this.#tracker.startRoot({
              callId: event.callId,
              operationId: event.operationId,
              attribution: resolution.attribution,
              runType: runTypeFor(event.operationId),
              name: source.functionId,
            }),
          );
          return;
        default: {
          const unhandled: never = resolution;
          return unhandled;
        }
      }
    });
  }

  onLanguageModelCallEnd(event: EventOf<'onLanguageModelCallEnd'>): void {
    this.#guard('onLanguageModelCallEnd', () => {
      const call = this.#tracker.get(event.callId);
      if (call === undefined) return;
      const resource = this.#modelResource(call, event.provider, event.modelId, 'generation');
      if (resource === undefined) return;
      this.#record(call, {
        spanId: modelSpanId(event.callId, call.modelCalls++),
        durationMs: durationMs(event.performance.responseTimeMs),
        resource: { ...resource, modality: 'text' },
        usage: { llm: toLlmUsage(event.usage) },
      });
    });
  }

  onToolExecutionStart(event: EventOf<'onToolExecutionStart'>): void {
    this.#guard('onToolExecutionStart', () => {
      const call = this.#tracker.get(event.callId);
      if (call === undefined) return;
      openToolSpan(call, event.toolCall.toolCallId);
    });
  }

  onToolExecutionEnd(event: EventOf<'onToolExecutionEnd'>): void {
    this.#guard('onToolExecutionEnd', () => {
      const call = this.#tracker.get(event.callId);
      if (call === undefined) return;
      this.#record(call, {
        spanId: closeToolSpan(call, event.toolCall.toolCallId),
        durationMs: durationMs(event.toolExecutionMs),
        resource: {
          provider: TOOL_PROVIDER,
          type: 'tool',
          name: event.toolCall.toolName,
          operation: 'tool_execution',
        },
        usage: { tool: { type: 'invocation', call_count: 1 } },
        // The discriminator only; the tool's output and error are never read.
        errorCode: event.toolOutput.type === 'tool-error' ? TOOL_ERROR_CODE : undefined,
      });
    });
  }

  onEmbedStart(event: EventOf<'onEmbedStart'>): void {
    this.#guard('onEmbedStart', () => {
      this.#tracker.get(event.callId)?.embedStartTimes.set(event.embedCallId, performance.now());
    });
  }

  onEmbedEnd(event: EventOf<'onEmbedEnd'>): void {
    this.#guard('onEmbedEnd', () => {
      const call = this.#tracker.get(event.callId);
      if (call === undefined) return;
      const startedAt = call.embedStartTimes.get(event.embedCallId);
      call.embedStartTimes.delete(event.embedCallId);
      const resource = this.#modelResource(call, event.provider, event.modelId, 'embedding');
      if (resource === undefined) return;
      const inputTokens = counter(event.usage.tokens);
      this.#record(call, {
        spanId: embedSpanId(event.embedCallId),
        durationMs: elapsedSince(startedAt),
        resource: { ...resource, modality: 'text' },
        usage: {
          llm:
            inputTokens === undefined
              ? { requests: 1 }
              : { input_tokens: inputTokens, requests: 1 },
        },
      });
    });
  }

  onRerankStart(event: EventOf<'onRerankStart'>): void {
    this.#guard('onRerankStart', () => {
      const call = this.#tracker.get(event.callId);
      if (call !== undefined) call.rerankStartedAt = performance.now();
    });
  }

  onRerankEnd(event: EventOf<'onRerankEnd'>): void {
    this.#guard('onRerankEnd', () => {
      const call = this.#tracker.get(event.callId);
      if (call === undefined) return;
      const startedAt = call.rerankStartedAt;
      call.rerankStartedAt = undefined;
      const resource = this.#modelResource(call, event.provider, event.modelId, 'reranking');
      if (resource === undefined) return;
      this.#record(call, {
        spanId: rerankSpanId(event.callId, call.rerankCalls++),
        durationMs: elapsedSince(startedAt),
        resource: { ...resource, modality: 'text' },
        usage: { llm: { requests: 1 } },
      });
    });
  }

  onEnd(event: EventOf<'onEnd'>): void {
    this.#guard('onEnd', () => {
      this.#tracker.end(event.callId);
    });
  }

  onAbort(event: EventOf<'onAbort'>): void {
    this.#guard('onAbort', () => {
      this.#tracker.end(event.callId);
    });
  }

  onError(event: unknown): void {
    this.#guard('onError', () => {
      // The payload is `{ callId, error }`; the error is never read.
      if (typeof event !== 'object' || event === null) return;
      const callId: unknown = (event as { readonly callId?: unknown }).callId;
      if (typeof callId === 'string') this.#tracker.end(callId);
    });
  }

  /**
   * Runs a tool's `execute` inside the tool's span so that an AI SDK call it starts joins
   * this run. Returns exactly what `execute` returns, including its rejection.
   */
  executeTool<T>(options: {
    readonly callId: string;
    readonly toolCallId: string;
    readonly execute: () => PromiseLike<T>;
  }): PromiseLike<T> {
    let span: ToolSpan | undefined;
    try {
      const call = this.#tracker.get(options.callId);
      if (call !== undefined) span = { call, spanId: toolSpanFor(call, options.toolCallId) };
    } catch (error) {
      this.#diagnostics.error('HOOK_FAILED', { hook: 'executeTool', error: errorName(error) });
    }
    return span === undefined
      ? options.execute()
      : this.#tracker.runInToolSpan(span, options.execute);
  }

  /**
   * The record's provider and name, or `undefined` (logged) when `mapResource` throws or no
   * valid provider maps. A throwing `mapResource` skips the record rather than falling back
   * to the default slug the host chose to override.
   */
  #modelResource(
    call: TrackedCall,
    provider: string,
    modelId: string,
    operation: ModelOperation,
  ): Resource | undefined {
    let mapped: ResourceMapping | null | undefined;
    try {
      mapped = this.#mapResource?.({ provider, modelId });
    } catch (error) {
      this.#diagnostics.warn('MAP_RESOURCE_FAILED', {
        operation: call.operationId,
        error: errorName(error),
      });
      return undefined;
    }
    const slug = mapped == null ? providerSlug(provider) : mapped.provider;
    if (!isProviderSlug(slug)) {
      this.#diagnostics.warn('PROVIDER_UNMAPPED', { operation: call.operationId });
      return undefined;
    }
    return { provider: slug, type: 'model', name: mapped?.name ?? modelId, operation };
  }

  #record(call: TrackedCall, parts: RecordParts): void {
    const record = createRecord({
      timing: parts.durationMs === undefined ? {} : { duration_ms: parts.durationMs },
      resource: parts.resource,
      usage: parts.usage,
      run: {
        run_id: call.runId,
        span_id: parts.spanId,
        step: call.steps.next++,
        run_type: call.runType,
        ...(call.parentSpanId === undefined ? {} : { parent_span_id: call.parentSpanId }),
        ...(call.name === undefined ? {} : { name: call.name }),
        ...(parts.errorCode === undefined ? {} : { error_code: parts.errorCode }),
      },
      attribution: call.attribution,
    });
    const result = this.#client.record(record);
    if (!result.queued) {
      this.#diagnostics.warn('RECORD_NOT_QUEUED', {
        outcome: result.outcome,
        operation: call.operationId,
        issues: formatIssues(result),
      });
    }
  }

  #warnUnsupportedOnce(operationId: string): void {
    if (this.#warnedUnsupported.has(operationId)) return;
    this.#warnedUnsupported.add(operationId);
    this.#diagnostics.warn('OPERATION_UNSUPPORTED', { operation: operationId });
  }

  #warnIfEvicted(count: number): void {
    if (count > 0) this.#diagnostics.warn('OPERATION_EVICTED', { count });
  }

  /** Runs a hook body; an exception is logged by class name and never reaches the AI SDK. */
  #guard(hook: string, body: () => void): void {
    try {
      body();
    } catch (error) {
      this.#diagnostics.error('HOOK_FAILED', { hook, error: errorName(error) });
    }
  }
}

function elapsedSince(startedAt: number | undefined): number | undefined {
  return startedAt === undefined ? undefined : durationMs(performance.now() - startedAt);
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.length === 0 ? undefined : value;
}

function asObject(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}
