# AGENTS.md

Guidance for working in this package. Rules for every adapter are in
[`adapters/AGENTS.md`](../../AGENTS.md). Setup, the shared TypeScript toolchain and the
contribution process are in the top-level [`CONTRIBUTING.md`](../../../CONTRIBUTING.md).
To integrate this adapter into an application, see [`README.md`](README.md); this file
covers changes to the package itself.

## What this is

`adapters/vercel-ai/typescript` is the `audr-adapter-vercel-ai` npm package: a Vercel AI
SDK 7 `Telemetry` integration that turns provider model calls, client-side tool
executions, embedding calls and rerank calls into attributed `AUDR` records for an `audr`
`Client` the host application owns.

## Layout

| Path | Owns |
| --- | --- |
| `src/index.ts` | The public exports, pinned by `tests/public-api.test.ts` |
| `src/telemetry.ts` | `audrTelemetry`, option validation, and every `Telemetry` hook |
| `src/attribution.ts` | The `runtimeContext.audr` reader, the merge over defaults, resolver error capture |
| `src/runs.ts` | `RunTracker` with its per-instance `AsyncLocalStorage` spawn context, `BoundedMap`, per-operation state and unique tool span allocation |
| `src/mapping.ts` | Pure functions: token arithmetic, provider slugs, span ids, run type, supported operations |
| `src/diagnostics.ts` | `DiagnosticCode`, the message format, `errorName` |
| `tests/` | The Vitest suite; test names carry the requirement they cover (`VAI-nn`, below) |
| `examples/` | Runnable examples on mock models; no credentials or network calls |

## Requirements

Every test name starts with the requirement it covers. A behaviour change updates the
matching tests; a new behaviour takes the next number.

| Id | Requirement |
| --- | --- |
| `VAI-01` | Telemetry integration entry point |
| `VAI-02` | Option validation |
| `VAI-03` | Host owns the client |
| `VAI-04` | Generation record per provider model call |
| `VAI-05` | Token arithmetic |
| `VAI-06` | Tool execution record |
| `VAI-07` | Embedding and reranking records |
| `VAI-08` | Attribution resolution |
| `VAI-09` | Run identifiers |
| `VAI-10` | Spawned agents join the parent run |
| `VAI-11` | Bounded state and cleanup |
| `VAI-12` | No payloads, no values in diagnostics |
| `VAI-13` | Hooks never break generation |
| `VAI-14` | Rejected records are reported without values |
| `VAI-15` | Provider slug |
| `VAI-16` | Opt-outs are honoured |
| `VAI-17` | Unsupported operations are reported once |

## Rules

1. `ai` is an optional peer dependency. Import only its types (`import type`); ESLint
   rejects a value import in `src/`, and `tests/public-api.test.ts` checks the emitted
   JavaScript. The only Node API is `AsyncLocalStorage`, imported in `src/runs.ts` alone.
2. Read no payloads. Never read prompts, instructions, messages, content, provider
   metadata, tool inputs, tool outputs, tool errors, embeddings, documents, queries or
   rankings. From a tool's result read only the `toolOutput.type` discriminator.
   `tests/privacy.test.ts` plants a sentinel in every payload position.
3. Resolve attribution once, at `onStart`, and never change the snapshot afterwards. An
   operation without a resolved `environment` is skipped with `ATTRIBUTION_UNRESOLVED`. An
   operation started inside a tracked tool's `execute` inherits the parent's attribution,
   `run_id` and step counter and ignores its own `runtimeContext`.
4. An event for an unknown or evicted `callId` produces no record and no log line; it is
   never re-attributed to defaults.
5. Every hook body runs inside `#guard` and never throws into the AI SDK. `executeTool`
   returns exactly what `execute` returns and never catches its rejection. Option
   validation in the constructor is the only place the package throws.
6. Diagnostics go through `Diagnostics` with a `DiagnosticCode` and the fixed field set in
   `src/diagnostics.ts`. Add a code for every new diagnostic. The `operation` field is
   always the AI SDK `operationId`. Never log a record value, an id, a model name, a tool
   name or an error message; error class names only.
7. Never write `cost`, `run.outcome`, `run.trace_id`, `emitter` or `totalTokens`.
   `input_tokens` excludes cache reads and writes; `output_tokens` excludes reasoning.

## Toolchain

The shared toolchain is defined in the top-level
[`CONTRIBUTING.md`](../../../CONTRIBUTING.md#shared-typescript-toolchain). Specific to this
package:

- **Peer dependencies:** `ai` (optional) and `audr`. The dev dependency on `ai` is pinned
  exactly to the floor of the `ai` peer range, so CI runs the suite against the oldest
  release the package claims to support. Raise the two together, and only when the adapter
  needs a newer `ai`. The floor is where `embed`, `embedMany` and `rerank` gained
  `runtimeContext`; earlier 7.x releases drop per-call attribution on those calls.
- **`audr` is a `file:` dependency** on `../../core/typescript` until the `audr` package is
  published, and the core's `exports` point at its `dist/`, so `make install` installs and
  builds the core first. Once `audr` is on npm, switch the dev dependency to the registry
  range and drop that step from the `Makefile`.
- **Version:** `package.json` and `src/version.ts`; `tests/public-api.test.ts` keeps them
  equal.

```bash
make install     # build the core, then npm ci
make lint        # eslint, prettier --check and tsc --noEmit
make test        # vitest with the 90% coverage gate
make examples    # build, then run every example against dist/
make isolation   # build, then publint --strict and attw
make verify      # lint + test + examples + isolation
```

`make isolation` does not run the core's `scripts/verify-package.ts`: this package's peer
dependencies are intended.
