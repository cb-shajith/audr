/** Meter Merge Gateway responses and embeddings as AUDR (Agent Usage Detail Record) records. */

export { type AudrContext, type RunContext, withAudr } from './attribution.js';
export type { DiagnosticCode } from './diagnostics.js';
export {
  instrumentMergeGateway,
  type InstrumentMergeGatewayOptions,
  type MergeGatewayLike,
  type ResourceMapping,
  type ResourceSource,
} from './gateway.js';
export { RESPONSE_FAILED_CODE } from './mapping.js';
export { VERSION } from './version.js';
