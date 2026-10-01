# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Initial release: `instrumentMergeGateway()`, a non-mutating facade over a
  `merge-gateway-sdk` `MergeGateway` that submits one AUDR record per
  `responses.create()` (`generation`, from the `response.done` frame when streamed) and
  `embeddings.create()` (`embedding`) to a host-owned `@openaudr/audr` `Client`, passing
  every argument to the native method unchanged. Token counters are made cache- and
  reasoning-exclusive, and Gateway's `usage.cost` is asserted as `cost.total_cost` in USD.
- `withAudr()`, which applies attribution and an optional host run to every call any
  instrumented client starts inside it, over each client's `attributionDefaults`. A run
  whose `run_id` is also sent as `X-Merge-Trace-Id` lines records up with Merge Gateway
  tracing; `examples/tracing.ts` shows the per-run client this needs with
  `merge-gateway-sdk` 0.4.
- Value-free diagnostics with stable codes: `ATTRIBUTION_UNRESOLVED`, `MODEL_UNREPORTED`,
  `STREAM_INCOMPLETE`, `RECORD_NOT_QUEUED` and `HOOK_FAILED`.

### Fixed

- Omit `input_tokens` when a cache counter is explicitly `null` instead of treating it as
  zero, and keep the whole completion as `output_tokens` when reasoning is `null`.
- Set `resource.modality` from the response modalities requested from Gateway, including
  image and multimodal generations.
- Return a native result unchanged when its stream shape cannot be inspected safely.
- Use the published `@openaudr/audr` package and required peer dependencies, matching the
  shared TypeScript adapter packaging convention.
- Keep diagnostics silent unless the host supplies a logger, and reject a client without
  `record()` when instrumentation is configured.
