import { AsyncLocalStorage } from 'node:async_hooks';

import type { Attribution, RunType } from '@openaudr/audr';

import { toolSpanId } from './mapping.js';

interface CallInfo {
  readonly callId: string;
  /** The call's own `callId` for a root; the root's `runId` for a child. */
  readonly runId: string;
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
  toolCalls: number;
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

export interface RootCall {
  readonly callId: string;
  readonly operationId: string;
  readonly attribution: Attribution;
  readonly runType: RunType;
  readonly name: string | undefined;
}

/**
 * Tracks calls by `callId` from `onStart` until `onEnd`, `onAbort` or `onError`. An event
 * for a call that is not tracked finds nothing and is dropped; it is never re-attributed.
 */
export class CallTracker {
  readonly #calls = new Map<string, TrackedCall>();

  startRoot(root: RootCall): void {
    this.#add({
      ...root,
      runId: root.callId,
      parentSpanId: undefined,
      steps: { next: 0 },
    });
  }

  /**
   * Start a call made inside `span`: it joins the parent's run and inherits its attribution,
   * run type, name and step sequence.
   */
  startChild(callId: string, operationId: string, span: ToolSpan): void {
    const parent = span.call;
    this.#add({
      callId,
      operationId,
      runId: parent.runId,
      parentSpanId: span.spanId,
      attribution: parent.attribution,
      runType: parent.runType,
      name: parent.name,
      steps: parent.steps,
    });
  }

  get(callId: string): TrackedCall | undefined {
    return this.#calls.get(callId);
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

  #add(info: CallInfo): void {
    this.#calls.set(info.callId, {
      ...info,
      modelCalls: 0,
      rerankCalls: 0,
      toolCalls: 0,
      openToolSpans: new Map(),
      embedStartTimes: new Map(),
      rerankStartedAt: undefined,
    });
  }
}

/** Open a tool span with a run-local invocation index, without retaining completed ids. */
export function openToolSpan(call: TrackedCall, toolCallId: string): string {
  const spanId = toolSpanId(call.callId, call.toolCalls++, toolCallId);
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
