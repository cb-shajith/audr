import { vi } from 'vitest';

import {
  type AudrRecord,
  BatchResult,
  type DeliverOptions,
  type Logger,
  type Sink,
} from '../src/index.js';

export const EMITTER = { component: 'harness', name: 'test-harness', version: '1.0.0' } as const;

/** A logger that keeps every line so tests can assert on what was said. */
export function recordingLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    warn: (message) => lines.push(message),
    error: (message) => lines.push(message),
  };
}

/** A sink whose every `deliver()` stays pending until the test answers it. */
export class ControlledSink implements Sink {
  readonly batches: (readonly AudrRecord[])[] = [];
  readonly signals: (AbortSignal | undefined)[] = [];
  readonly #pending: ((result: BatchResult) => void)[] = [];
  closed = 0;

  deliver(batch: readonly AudrRecord[], options?: DeliverOptions): Promise<BatchResult> {
    this.batches.push(batch);
    this.signals.push(options?.signal);
    return new Promise((resolve) => this.#pending.push(resolve));
  }

  /** Answer the oldest outstanding `deliver()`. */
  answer(result: BatchResult = BatchResult.accepted()): void {
    const resolve = this.#pending.shift();
    if (resolve === undefined) throw new Error('no deliver() is pending');
    resolve(result);
  }

  close(): Promise<void> {
    this.closed += 1;
    return Promise.resolve();
  }
}

/** Let every pending promise callback run without advancing the clock. Needs fake timers. */
export async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}
