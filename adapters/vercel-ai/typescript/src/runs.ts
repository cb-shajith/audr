import { AsyncLocalStorage } from 'node:async_hooks';

import type { Attribution, RunType } from 'audr';

import { toolSpanId } from './mapping.js';

/** The attribution snapshot and identifiers of one AI SDK operation, keyed by its `callId`. */
export interface RunState {
  /** The operation's own `callId` for a root; the root's `runId` for a spawned agent. */
  readonly runId: string;
  /** This operation's AI SDK `operationId`, the only operation name diagnostics carry. */
  readonly operationId: string;
  /** The spawning tool span, set on every record of a spawned agent. */
  readonly parentSpanId: string | undefined;
  readonly attribution: Attribution;
  readonly runType: RunType;
  /** The root's `telemetry.functionId`. */
  readonly name: string | undefined;
  /** The run-wide `run.step` sequence, shared by a root and every agent it spawns. */
  readonly counter: { next: number };
  /** Model calls so far in this operation, for span ids. */
  modelCalls: number;
  /** Rerank calls so far in this operation, for span ids. */
  rerankCalls: number;
  /** Every tool span id this operation has handed out, so none is reused. */
  readonly toolSpans: Set<string>;
  /** The span of each tool execution between its start and end, by `toolCallId`. */
  readonly openTools: Map<string, string>;
  /** `performance.now()` at each embed call's start, by `embedCallId`. */
  readonly embedStarts: Map<string, number>;
  /** `performance.now()` at the latest rerank attempt's start. */
  rerankStartedAt: number | undefined;
}

/** The run and span a tool's `execute` runs under, so a nested AI SDK call can join it. */
export interface SpawnContext {
  readonly run: RunState;
  readonly spanId: string;
}

/**
 * An insertion-ordered map holding at most `limit` entries. Adding past the limit evicts
 * the oldest entries first.
 */
export class BoundedMap<V> {
  readonly #entries = new Map<string, V>();
  readonly #limit: number;

  constructor(limit: number) {
    this.#limit = limit;
  }

  get size(): number {
    return this.#entries.size;
  }

  /** Returns how many entries were evicted to make room. */
  set(key: string, value: V): number {
    this.#entries.delete(key);
    this.#entries.set(key, value);
    let evicted = 0;
    for (const oldest of this.#entries.keys()) {
      if (this.#entries.size <= this.#limit) break;
      this.#entries.delete(oldest);
      evicted += 1;
    }
    return evicted;
  }

  get(key: string): V | undefined {
    return this.#entries.get(key);
  }

  /** Removes and returns the entry for `key`. */
  take(key: string): V | undefined {
    const value = this.#entries.get(key);
    this.#entries.delete(key);
    return value;
  }
}

export interface RunStart {
  readonly callId: string;
  readonly operationId: string;
  readonly attribution: Attribution;
  readonly runType: RunType;
  readonly name: string | undefined;
}

/**
 * Tracks operations by `callId` from `onStart` until `onEnd`, `onAbort` or `onError`. A
 * later event for an evicted operation finds nothing and is dropped; it is never
 * re-attributed.
 */
export class RunTracker {
  readonly #runs: BoundedMap<RunState>;
  /** Per tracker, so a call metered by another integration never joins this one's runs. */
  readonly #spawn = new AsyncLocalStorage<SpawnContext>();

  constructor(limit: number) {
    this.#runs = new BoundedMap(limit);
  }

  /** Begin a root run. Returns how many runs were evicted to make room. */
  beginRoot(start: RunStart): number {
    return this.#runs.set(start.callId, {
      ...freshOperation(),
      runId: start.callId,
      operationId: start.operationId,
      parentSpanId: undefined,
      attribution: start.attribution,
      runType: start.runType,
      name: start.name,
      counter: { next: 0 },
    });
  }

  /**
   * Begin an operation spawned inside a tool: it joins the parent's run, inherits its
   * attribution, run type, name and step sequence, and points at the spawning span.
   */
  beginSpawned(callId: string, operationId: string, parent: SpawnContext): number {
    return this.#runs.set(callId, {
      ...freshOperation(),
      runId: parent.run.runId,
      operationId,
      parentSpanId: parent.spanId,
      attribution: parent.run.attribution,
      runType: parent.run.runType,
      name: parent.run.name,
      counter: parent.run.counter,
    });
  }

  get(callId: string): RunState | undefined {
    return this.#runs.get(callId);
  }

  end(callId: string): void {
    this.#runs.take(callId);
  }

  /** The tool span the current async context runs inside, if one of this tracker's. */
  spawningSpan(): SpawnContext | undefined {
    return this.#spawn.getStore();
  }

  /** Runs `execute` so that an operation it starts joins `context`. */
  runInSpan<T>(context: SpawnContext, execute: () => T): T {
    return this.#spawn.run(context, execute);
  }
}

type OperationFields = Pick<
  RunState,
  'modelCalls' | 'rerankCalls' | 'toolSpans' | 'openTools' | 'embedStarts' | 'rerankStartedAt'
>;

function freshOperation(): OperationFields {
  return {
    modelCalls: 0,
    rerankCalls: 0,
    toolSpans: new Set(),
    openTools: new Map(),
    embedStarts: new Map(),
    rerankStartedAt: undefined,
  };
}

/**
 * Open a tool execution and return its span id: `tool:<callId>:<toolCallId>`, with `:<n>`
 * appended when that id is already taken in this operation, as happens when a provider
 * reuses tool call ids across steps.
 */
export function openToolSpan(run: RunState, callId: string, toolCallId: string): string {
  const base = toolSpanId(callId, toolCallId);
  let spanId = base;
  for (let n = 1; run.toolSpans.has(spanId); n += 1) spanId = `${base}:${String(n)}`;
  run.toolSpans.add(spanId);
  run.openTools.set(toolCallId, spanId);
  return spanId;
}

/** Close a tool execution and return its span id, opening one if its start was not seen. */
export function closeToolSpan(run: RunState, callId: string, toolCallId: string): string {
  const spanId = run.openTools.get(toolCallId) ?? openToolSpan(run, callId, toolCallId);
  run.openTools.delete(toolCallId);
  return spanId;
}
