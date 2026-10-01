# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Initial release: `audrTelemetry()`, a Vercel AI SDK 7 `Telemetry` integration that
  submits one AUDR record per provider model call (`generation`), client-side tool
  execution (`tool_execution`), embedding provider call (`embedding`) and rerank call
  (`reranking`) to a host-owned `@openaudr/audr` `Client`. Attribution is read from
  `runtimeContext.audr` over configurable defaults; an AI SDK
  call started inside a tool joins the calling run with `run.parent_span_id` set to the
  tool's span. Diagnostics carry stable codes and no record values, and nothing is logged
  unless a `logger` is given. `ai` and `@openaudr/audr` are peer dependencies.

### Fixed

- Require `runtimeContext.audr` and its attribution fields to be own properties so
  prototype pollution cannot supply billing attribution.
- Report only allowlisted built-in error classes in diagnostics; mutable error names are
  never logged.
- Number tool spans by invocation so completed tool-call identifiers do not accumulate
  for the lifetime of a long-running agent.
