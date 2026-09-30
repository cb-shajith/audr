import { AsyncLocalStorage } from 'node:async_hooks';

import type { Attribution, RunType } from '@openaudr/audr';

import { toolSpanId } from './mapping.js';

interface CallInfo {
  readonly callId: string;
  /** The call's own `callId` for a root; the root's `runId` for a child. */
  readonly runId: string;
  /** The call whose tool started this one; `undefined` for a root. */
  readonly parent: TrackedCall | undefined;
  /** The only operation name diagnostics carry. */
  readonly operationId: string;
  /** The tool span that started this call; set on every record of a child. */
  readonly parentSpanId: string | undefined;
  readonly attribution: Attribution;
  readonly runType: RunType;
  /** The root's `telemetry.functionId`. */
  readonly name: string | undefined;
  /** The `run.step` sequence, shared by a root and every child it starts. */
  readonly steps: { next: number };
}

/** One AI SDK operation, keyed by its `callId`, with the attribution it was started under. */
export interface TrackedCall extends CallInfo {
  modelCalls: number;
  rerankCalls: number;
  readonly usedToolSpanIds: Set<string>;
  /** Span id of each running tool, by `toolCallId`. */
  readonly openToolSpans: Map<string, string>;
  /** `performance.now()` at each embed call's start, by `embedCallId`. */
  readonly embedStartTimes: Map<string, number>;
  rerankStartedAt: number | undefined;
}

/** A tool span and the call it belongs to; an AI SDK call started inside it becomes a child. */
export interface ToolSpan {
  readonly call: TrackedCall;
  readonly spanId: string;
}

interface ActiveToolSpan {
  readonly tracker: CallTracker;
  readonly span: ToolSpan;
}

/**
 * Shared by every tracker. Under Node 22's `async_hooks` implementation each
 * `AsyncLocalStorage` that has ever run stays registered for the life of the process and
 * is visited on every async resource created, so one instance per tracker would slow the
 * whole process down as integrations are created.
 */
const activeToolSpans = new AsyncLocalStorage<readonly ActiveToolSpan[]>();

/**
 * A map holding at most `limit` entries in least-recently-used order. Adding past the limit
 * evicts the entries used longest ago first; `set`, `get` and `touch` count as use.
 */
export class LruMap<V> {
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
    this.touch(key);
    return this.#entries.get(key);
  }

  touch(key: string): void {
    const value = this.#entries.get(key);
    if (value === undefined) return;
    this.#entries.delete(key);
    this.#entries.set(key, value);
  }

  delete(key: string): void {
    this.#entries.delete(key);
  }
}

export interface RootCall {
  readonly callId: string;
  readonly operationId: string;
  readonly attribution: Attribution;
  readonly runType: RunType;
  readonly name: string | undefined;
}

/**
 * Tracks calls by `callId` from `onStart` until `onEnd`, `onAbort` or `onError`. A later
 * event for an evicted call finds nothing and is dropped; it is never re-attributed.
 */
export class CallTracker {
  readonly #calls: LruMap<TrackedCall>;

  constructor(limit: number) {
    this.#calls = new LruMap(limit);
  }

  /** Returns how many calls were evicted to make room. */
  startRoot(root: RootCall): number {
    return this.#add({
      ...root,
      runId: root.callId,
      parent: undefined,
      parentSpanId: undefined,
      steps: { next: 0 },
    });
  }

  /**
   * Start a call made inside `span`: it joins the parent's run and inherits its attribution,
   * run type, name and step sequence. Returns how many calls were evicted to make room.
   */
  startChild(callId: string, operationId: string, span: ToolSpan): number {
    const parent = span.call;
    this.#keepAncestorsAlive(parent);
    return this.#add({
      callId,
      operationId,
      runId: parent.runId,
      parent,
      parentSpanId: span.spanId,
      attribution: parent.attribution,
      runType: parent.runType,
      name: parent.name,
      steps: parent.steps,
    });
  }

  /**
   * The call for `callId`, marked as in use together with its ancestors: a parent waiting in
   * a tool on its child is still live.
   */
  get(callId: string): TrackedCall | undefined {
    const call = this.#calls.get(callId);
    this.#keepAncestorsAlive(call?.parent);
    return call;
  }

  end(callId: string): void {
    this.#calls.delete(callId);
  }

  /**
   * The innermost tool span of this tracker the current async context runs inside. Spans
   * of other trackers are skipped, so a call metered by another integration never joins
   * this one's runs.
   */
  currentToolSpan(): ToolSpan | undefined {
    return activeToolSpans.getStore()?.findLast((active) => active.tracker === this)?.span;
  }

  runInToolSpan<T>(span: ToolSpan, execute: () => T): T {
    const active = activeToolSpans.getStore() ?? [];
    return activeToolSpans.run([...active, { tracker: this, span }], execute);
  }

  #add(info: CallInfo): number {
    return this.#calls.set(info.callId, {
      ...info,
      modelCalls: 0,
      rerankCalls: 0,
      usedToolSpanIds: new Set(),
      openToolSpans: new Map(),
      embedStartTimes: new Map(),
      rerankStartedAt: undefined,
    });
  }

  #keepAncestorsAlive(call: TrackedCall | undefined): void {
    for (let current = call; current !== undefined; current = current.parent) {
      this.#calls.touch(current.callId);
    }
  }
}

/**
 * Open a tool span and return its id: `tool:<callId>:<toolCallId>`, with `:<n>` appended
 * when that id is already used in this call, as happens when a provider reuses tool call
 * ids across steps.
 */
export function openToolSpan(call: TrackedCall, toolCallId: string): string {
  const base = toolSpanId(call.callId, toolCallId);
  let spanId = base;
  let suffix = 0;
  while (call.usedToolSpanIds.has(spanId)) {
    suffix += 1;
    spanId = `${base}:${String(suffix)}`;
  }
  call.usedToolSpanIds.add(spanId);
  call.openToolSpans.set(toolCallId, spanId);
  return spanId;
}

/** The open span for `toolCallId`, opening one if its start was not seen. */
export function toolSpanFor(call: TrackedCall, toolCallId: string): string {
  return call.openToolSpans.get(toolCallId) ?? openToolSpan(call, toolCallId);
}

export function closeToolSpan(call: TrackedCall, toolCallId: string): string {
  const spanId = toolSpanFor(call, toolCallId);
  call.openToolSpans.delete(toolCallId);
  return spanId;
}
