import type { EmbeddingCreateParams, ResponseCreateParams } from 'merge-gateway-sdk';
import {
  type Attribution,
  type Client,
  ConfigurationError,
  createRecord,
  type Emitter,
  type Logger,
  type Modality,
  uuidv7,
} from '@openaudr/audr';

import { currentScope, mergeAttribution, type RunContext } from './attribution.js';
import {
  Diagnostics,
  errorKind,
  formatIssues,
  type IncompleteReason,
  type OperationName,
  SILENT,
} from './diagnostics.js';
import {
  embeddingUsage,
  fitsRunId,
  GATEWAY_PROVIDER,
  type GatewayResult,
  RESPONSE_FAILED_CODE,
  responseUsage,
  toCost,
} from './mapping.js';
import { VERSION } from './version.js';

const EMITTER: Emitter = {
  component: 'router',
  name: '@openaudr/audr-adapter-merge-gateway',
  version: VERSION,
};

/** The native client surface the facade meters. A `MergeGateway` satisfies it. */
export interface MergeGatewayLike {
  readonly responses: { create(params: ResponseCreateParams): Promise<unknown> };
  readonly embeddings: { create(params: EmbeddingCreateParams): Promise<unknown> };
}

export interface InstrumentMergeGatewayOptions {
  /** The host's client. The adapter only calls its `record()`; it never flushes or shuts it down. */
  readonly client: Client;
  /** Applied field by field under `withAudr` attribution. Omit `environment` to require it per scope. */
  readonly attributionDefaults?: Attribution | undefined;
  /** Overrides the provider slug and model name. Returning `undefined` or `null` keeps the default. */
  readonly mapResource?:
    ((source: ResourceSource) => ResourceMapping | null | undefined) | undefined;
  /**
   * Where diagnostics go. Default: none. Pass `console` or another logger to receive them.
   * Messages never carry record values.
   */
  readonly logger?: Logger | undefined;
}

export interface ResourceSource {
  /** The model that served the call, e.g. `openai/gpt-5.4`. */
  readonly model: string | undefined;
  /** The execution vendor that served it, e.g. `openai` or `bedrock`, when Gateway reports it. */
  readonly vendor: string | undefined;
}

export interface ResourceMapping {
  /** `resource.provider`; it must match `^[a-z0-9-]+$` or the `Client` rejects the record. */
  readonly provider: string;
  readonly name: string;
}

/** A metered call, resolved once when it starts and never changed afterwards. */
interface Call {
  readonly operation: OperationName;
  readonly modality: Modality;
  readonly attribution: Attribution;
  readonly run: RunContext | undefined;
  readonly startedAt: number;
}

type NativeStream = AsyncIterable<unknown> & { readonly close?: (() => void) | undefined };

const instrumented = new WeakSet<object>();

/**
 * Wrap a `MergeGateway` so that every `responses.create()` (streaming or not) and
 * `embeddings.create()` hands one AUDR record to the host's `client`. The facade has the
 * native client's type; every other resource and method is forwarded untouched, and the
 * native client is never modified.
 *
 * ```ts
 * const gateway = instrumentMergeGateway(new MergeGateway({ apiKey }), {
 *   client,
 *   attributionDefaults: { environment: 'production' },
 * });
 * ```
 *
 * Reads requested output modalities, usage, identifiers and the served model only; never
 * input, output, tools, tags or errors. Metering never changes or fails a native call.
 * Throws `ConfigurationError` when `client` has no `record()` or `gateway` is already a
 * facade, which would record every call twice.
 */
export function instrumentMergeGateway<G extends MergeGatewayLike>(
  gateway: G,
  options: InstrumentMergeGatewayOptions,
): G {
  if (instrumented.has(gateway)) {
    throw new ConfigurationError('gateway is already instrumented');
  }
  const meter = new Meter(options);
  const facade = forward(gateway, {
    responses: meterCreate(gateway.responses, (args, create) =>
      meter.measure('responses.create', responseModality(args[0]), create),
    ),
    embeddings: meterCreate(gateway.embeddings, (_args, create) =>
      meter.measure('embeddings.create', 'text', create),
    ),
  });
  instrumented.add(facade);
  return facade;
}

class Meter {
  readonly #client: Client;
  readonly #defaults: Attribution;
  readonly #mapResource: InstrumentMergeGatewayOptions['mapResource'];
  readonly #diagnostics: Diagnostics;

  constructor({ client, attributionDefaults, mapResource, logger }: InstrumentMergeGatewayOptions) {
    if (typeof (client as Partial<Client> | undefined)?.record !== 'function') {
      throw new ConfigurationError('client must implement record()');
    }
    this.#client = client;
    this.#defaults = mergeAttribution({}, attributionDefaults);
    this.#mapResource = mapResource;
    this.#diagnostics = new Diagnostics(logger ?? SILENT);
  }

  /** Makes the native call and meters what it returns, which reaches the host unchanged. */
  async measure(
    operation: OperationName,
    modality: Modality,
    create: () => Promise<unknown>,
  ): Promise<unknown> {
    const call = this.#begin(operation, modality);
    const result = await create();
    if (call === undefined) return result;
    try {
      if (isStream(result)) return this.#meterStream(result, call);
    } catch (error) {
      this.#hookFailed(call, error);
      return result;
    }
    this.#guard(call, () => {
      this.#record(call, result as GatewayResult);
    });
    return result;
  }

  /** The call's attribution and run, captured where it starts; `undefined` when not metered. */
  #begin(operation: OperationName, modality: Modality): Call | undefined {
    const scope = currentScope();
    const attribution = mergeAttribution(this.#defaults, scope.attribution);
    if (attribution.environment === undefined) {
      this.#diagnostics.warn('ATTRIBUTION_UNRESOLVED', { operation });
      return undefined;
    }
    return { operation, modality, attribution, run: scope.run, startedAt: performance.now() };
  }

  /**
   * The native stream behind a proxy that records the `response.done` frame before yielding
   * it. Every frame is yielded unchanged; a stream that ends any other way is reported once
   * as `STREAM_INCOMPLETE`.
   */
  #meterStream(stream: NativeStream, call: Call): NativeStream {
    let open = true;
    const incomplete = (reason: IncompleteReason): void => {
      if (!open) return;
      open = false;
      this.#diagnostics.warn('STREAM_INCOMPLETE', { operation: call.operation, reason });
    };
    const observe = (frame: GatewayResult | null): void => {
      if (!open) return;
      if (frame?.object === 'response.done') {
        open = false;
        this.#guard(call, () => {
          this.#record(call, frame);
        });
      } else if (frame?.object === 'response.error') {
        incomplete('error_frame');
      }
    };
    async function* iterate(): AsyncGenerator<unknown, void, undefined> {
      try {
        for await (const frame of stream) {
          observe(frame as GatewayResult | null);
          yield frame;
        }
        incomplete('ended');
      } catch (error) {
        incomplete('failed');
        throw error;
      } finally {
        incomplete('abandoned');
      }
    }
    const overrides: Record<PropertyKey, unknown> = { [Symbol.asyncIterator]: iterate };
    if (typeof stream.close === 'function') {
      const close = stream.close.bind(stream);
      overrides.close = (): void => {
        incomplete('closed');
        close();
      };
    }
    return forward(stream, overrides);
  }

  #record(call: Call, result: GatewayResult): void {
    const { model, vendor, usage } = result;
    const resource = this.#mapResource?.({ model, vendor }) ?? {
      provider: GATEWAY_PROVIDER,
      name: model,
    };
    if (!resource.name) {
      this.#diagnostics.warn('MODEL_UNREPORTED', { operation: call.operation });
      return;
    }
    const generation = call.operation === 'responses.create';
    const id = result.id ?? uuidv7();
    const run = call.run;
    const submitted = this.#client.record(
      createRecord({
        emitter: EMITTER,
        timing: { duration_ms: Math.round(performance.now() - call.startedAt) },
        resource: {
          provider: resource.provider,
          type: 'model',
          name: resource.name,
          operation: generation ? 'generation' : 'embedding',
          modality: call.modality,
        },
        usage: { llm: generation ? responseUsage(usage) : embeddingUsage(usage) },
        cost: toCost(usage),
        run: {
          run_id: run?.run_id ?? (fitsRunId(id) ? id : uuidv7()),
          span_id: `${generation ? 'response' : 'embedding'}:${id}`,
          parent_span_id: run?.parent_span_id,
          name: run?.name,
          run_type: run === undefined ? 'single_call' : 'agent_run',
          error_code: result.status === 'failed' ? RESPONSE_FAILED_CODE : undefined,
        },
        attribution: call.attribution,
      }),
    );
    if (!submitted.queued) {
      this.#diagnostics.warn('RECORD_NOT_QUEUED', {
        operation: call.operation,
        outcome: submitted.outcome,
        issues: formatIssues(submitted),
      });
    }
  }

  /** Runs one metering step; an exception is logged by category and never reaches the host. */
  #guard(call: Call, step: () => void): void {
    try {
      step();
    } catch (error) {
      this.#hookFailed(call, error);
    }
  }

  #hookFailed(call: Call, error: unknown): void {
    this.#diagnostics.error('HOOK_FAILED', {
      operation: call.operation,
      error: errorKind(error),
    });
  }
}

/** `resource` with `create()` metered; every argument is passed to the native method unchanged. */
function meterCreate<R extends { create(...args: never[]): Promise<unknown> }>(
  resource: R,
  meter: (args: readonly unknown[], create: () => Promise<unknown>) => Promise<unknown>,
): R {
  return forward(resource, {
    create: (...args: unknown[]) => meter(args, () => resource.create(...(args as never[]))),
  });
}

/** The requested response modality. Merge defaults an omitted list to text. */
function responseModality(params: unknown): Modality {
  try {
    if (typeof params !== 'object' || params === null) return 'text';
    const modalities: unknown = Reflect.get(params, 'modalities');
    if (!Array.isArray(modalities)) return 'text';
    const text = modalities.includes('text');
    const image = modalities.includes('image');
    const audio = modalities.includes('audio');
    if ([text, image, audio].filter(Boolean).length > 1) return 'multimodal';
    if (image) return 'image';
    if (audio) return 'audio';
    return 'text';
  } catch {
    return 'text';
  }
}

function isStream(value: unknown): value is NativeStream {
  return typeof value === 'object' && value !== null && Symbol.asyncIterator in value;
}

/**
 * A proxy over `target` that answers `overrides` itself and forwards everything else, with
 * methods bound to `target` so that they run exactly as on the native object.
 */
function forward<T extends object>(
  target: T,
  overrides: Readonly<Record<PropertyKey, unknown>>,
): T {
  return new Proxy(target, {
    get(object, key): unknown {
      if (Object.hasOwn(overrides, key)) return overrides[key];
      const value: unknown = Reflect.get(object, key, object);
      return typeof value === 'function' ? (value as () => unknown).bind(object) : value;
    },
  });
}
