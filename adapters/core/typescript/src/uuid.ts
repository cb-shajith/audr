import { v7 } from 'uuid';

/**
 * A random UUIDv7 (RFC 9562): a 48-bit Unix-millisecond timestamp, a counter seeded at
 * random each millisecond, then random bits, so identifiers sort by creation time even
 * within one millisecond. AUDR uses it for `record_id`; adapters may use it for
 * `run.run_id`.
 */
export function uuidv7(): string {
  return v7();
}
