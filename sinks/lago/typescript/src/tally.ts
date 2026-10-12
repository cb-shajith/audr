/**
 * Accumulates what is known about each record of a batch while its requests are sent, and
 * turns that into one `BatchResult`.
 *
 * A record reaches a distinct outcome once Lago confirms it or refuses it, or once it is
 * rejected locally. A later failure never relabels such a record: `BatchResult` applies a
 * failure to the whole batch, which would report a confirmed record as dropped. Once any
 * record has a distinct outcome, the batch is answered `accepted`: the records of a request
 * Lago refused are named `rejected` with the reason, and every record that never reached an
 * outcome is named `unknown`. Unknown records are derived from the outcomes recorded, so they
 * are complete however sending stopped.
 */
import { BatchResult, type RejectedRecord } from '@openaudr/audr';

import { type LagoEvent } from './event.js';

/**
 * Why sending stopped before every event had an outcome. `unconfirmed` is an answer from Lago
 * that neither confirms nor refuses the events.
 */
export type Stop =
  | { readonly kind: 'closed' }
  | { readonly kind: 'aborted' }
  | { readonly kind: 'unconfirmed' }
  | { readonly kind: 'failed'; readonly retryable: boolean; readonly detail: string };

export class Tally {
  readonly #events: readonly LagoEvent[];
  readonly #rejected: RejectedRecord[];
  readonly #refused: RejectedRecord[] = [];
  readonly #settled = new Set<string>();
  #confirmed = 0;
  #stop: Stop | undefined;

  /**
   * @param events Every event of the batch, in order; the records without an outcome once
   *   sending ends are the unknown ones.
   * @param rejected Records rejected before anything was sent.
   */
  constructor(events: readonly LagoEvent[], rejected: readonly RejectedRecord[]) {
    this.#events = events;
    this.#rejected = [...rejected];
  }

  get stopped(): boolean {
    return this.#stop !== undefined;
  }

  /** The events were accepted, or were found to be held by Lago already. */
  confirm(events: readonly LagoEvent[]): void {
    for (const event of events) this.#settled.add(event.transaction_id);
    this.#confirmed += events.length;
  }

  /** Lago refused the record, for a reason that no resend changes. */
  reject(recordId: string, detail: string): void {
    this.#rejected.push({ recordId, detail });
    this.#settled.add(recordId);
  }

  /**
   * Lago refused the request that carried `events`. The records are rejected with `detail`
   * when another record of the batch has an outcome; otherwise the whole batch fails.
   */
  refuse(events: readonly LagoEvent[], detail: string): void {
    for (const event of events) {
      this.#refused.push({ recordId: event.transaction_id, detail });
      this.#settled.add(event.transaction_id);
    }
  }

  /** Sending stopped; the first reason stands. */
  halt(stop: Stop): void {
    this.#stop ??= stop;
  }

  result(): BatchResult {
    const stop = this.#stop;
    const unresolved = this.#events
      .map((event) => event.transaction_id)
      .filter((recordId) => !this.#settled.has(recordId));
    const unknown = unresolved.length > 0 ? { unknown: unresolved } : {};
    if (stop === undefined) return BatchResult.accepted({ rejected: this.#rejected, ...unknown });

    const settled = this.#confirmed > 0 || this.#rejected.length > 0;
    // An aborted caller has already counted these records unknown, whatever else is settled,
    // and a failure would claim that records Lago may hold were dropped.
    if (stop.kind === 'aborted' || stop.kind === 'unconfirmed' || settled) {
      return BatchResult.accepted({
        rejected: [...this.#rejected, ...this.#refused],
        ...unknown,
      });
    }
    switch (stop.kind) {
      case 'closed':
        return BatchResult.closed();
      case 'failed':
        return BatchResult.failed({ retryable: stop.retryable, detail: stop.detail });
      default: {
        const unhandled: never = stop;
        throw new Error(`unhandled stop ${String(unhandled)}`);
      }
    }
  }
}
