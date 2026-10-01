# AGENTS.md

Guidance for working in this package. Rules for every adapter are in
[`adapters/AGENTS.md`](../../AGENTS.md). Setup, the shared TypeScript toolchain and the
contribution process are in the top-level [`CONTRIBUTING.md`](../../../CONTRIBUTING.md).
To integrate this adapter into an application, see [`README.md`](README.md); this file
covers changes to the package itself. The agreed hook and record shape are in
[openaudr/audr#20](https://github.com/openaudr/audr/issues/20).

## What this is

`adapters/merge-gateway/typescript` is the `@openaudr/audr-adapter-merge-gateway` npm package: a
non-mutating facade over a `merge-gateway-sdk` `MergeGateway` that turns every
`responses.create()` (streaming or not) and `embeddings.create()` into an attributed AUDR
record for an `@openaudr/audr` `Client` the host application owns, plus `withAudr()`, which
scopes attribution and an optional host run over every call an instrumented client makes.

## Layout

| Path | Owns |
| --- | --- |
| `src/index.ts` | The public exports, pinned by `tests/public-api.test.ts` |
| `src/gateway.ts` | `instrumentMergeGateway`, the `Proxy` facade, requested modality, the metered stream and record building |
| `src/attribution.ts` | `withAudr`, scope nesting, the attribution merge and the one process-wide `AsyncLocalStorage` |
| `src/mapping.ts` | `GatewayResult`, the only response fields the adapter reads, and pure functions over it: token arithmetic, cost, run id length |
| `src/diagnostics.ts` | `DiagnosticCode`, value-free formatting and fixed error categories |
| `tests/` | The Vitest suite, run against the real SDK with `fetch` stubbed |
| `examples/` | Runnable examples with `fetch` answered locally; no credentials or network calls |

## Tests

Tests are named for the behaviour they pin, in plain words. A behaviour change updates the
matching test; a new behaviour gets a test in the file that owns it.

| File | Covers |
| --- | --- |
| `facade.test.ts` | The facade keeps the native type, forwards every member and argument, sends the native request, refuses double instrumentation, and only calls `client.record()` |
| `responses.test.ts` | One generation record per response, modalities, token counters, failed responses |
| `streaming.test.ts` | Streams recorded at `response.done`, and every way a stream can end without one |
| `embeddings.test.ts` | One embedding record per call |
| `mapping.test.ts` | The pure token, cost, run id and diagnostic functions |
| `scope.test.ts` | Attribution resolution and nesting, and scopes reaching every facade, including Merge's per-run tracing client |
| `runs.test.ts` | Run identifiers inside and outside `withAudr` run scopes |
| `resource.test.ts` | `resource.provider` and `resource.name`, with and without `mapResource` |
| `privacy.test.ts` | A sentinel in every payload position reaches no record and no log line |
| `isolation.test.ts` | Metering never breaks a native call; rejected records are reported without values |
| `public-api.test.ts` | The root exports, the version, and the absence of runtime SDK imports |

## Rules

1. `merge-gateway-sdk` is a peer dependency. Import only its types
   (`import type`); ESLint rejects a value import in `src/`, and `tests/public-api.test.ts`
   checks the emitted JavaScript. The only Node API is `AsyncLocalStorage`, imported in
   `src/attribution.ts` alone and instantiated once per process: under Node 22 every instance
   that has ever run stays registered and slows every async operation, so never create
   another.
2. Never modify the native client, its resources or its streams. Wrap them in a `Proxy`
   that overrides only what is metered and forwards everything else bound to the target.
   A metered `create()` passes every argument to the native method unchanged.
3. Read no payloads. From a response or stream frame read only the fields `GatewayResult`
   declares: `id`, `object`, `model`, `vendor`, `status` and `usage`. From request parameters
   read only `modalities`, which determines `resource.modality`; a stream is recognised by
   the result being async-iterable. Never read `input`, `output`, `tools`, `tags`, `customer`,
   `project_id`, `session_id`, `routing`, `guardrails`, `warnings` or an error.
   `tests/privacy.test.ts` plants a sentinel in every payload position.
4. Attribution comes from `attributionDefaults` (copied when instrumenting) under the
   innermost `withAudr` scope, merged by `mergeAttribution`, which copies only AUDR's
   attribution fields. Scopes are process-wide: one applies to every instrumented client,
   so a per-run client created inside it is covered. Attribution and the run are resolved
   once when a native call starts and never changed afterwards. A call without a resolved
   `environment` is not metered and logs `ATTRIBUTION_UNRESOLVED`. `withAudr` never
   throws: a context it cannot read is ignored.
5. Never change, delay or fail a native call. A native rejection propagates untouched and
   is never logged; every metering step after the call, including stream-shape inspection,
   is guarded. `instrumentMergeGateway` throws only when `client` has no `record()` or a
   gateway is already a facade, which would record every call twice. Other options use their
   TypeScript types as the contract.
6. Leave value validation to the `Client`. Do not re-check what `Client.record()` already
   validates (types, ranges, the provider slug, id lengths); a record it rejects is
   reported as `RECORD_NOT_QUEUED` with each issue as `<code>@<path>`. The adapter checks
   only what it needs to build a record at all: an `environment`, and a model name
   (`MODEL_UNREPORTED`).
7. Record a stream only from its `response.done` frame, before yielding it, and report any
   other ending once as `STREAM_INCOMPLETE` with its `reason`.
8. Diagnostics go through `Diagnostics` with a `DiagnosticCode` and the fixed field set in
   `src/diagnostics.ts`. Add a code for every new diagnostic. Never log a record value, an
   id, a model name, a mutable error name or an error message; fixed error categories only.
9. `emitter` is always the adapter as a `router`. `cost` is `total_cost` in `USD` from
   `usage.cost` only, never a `cost.llm` breakdown. `input_tokens` excludes cache reads and
   writes; `output_tokens` excludes reasoning. When Gateway reports a required split counter
   as `null`, omit the exclusive total rather than treating the unknown part as zero.
   `resource.modality` comes from requested `modalities`, defaulting to `text`. Never write
   `total_tokens`, `run.outcome` (the harness owns it), `run.trace_id` (it is a W3C trace id,
   which `X-Merge-Trace-Id` is not) or `run.step` (the adapter cannot know a call's position
   across scopes, processes or concurrent calls).

## Toolchain

The shared toolchain is defined in the top-level
[`CONTRIBUTING.md`](../../../CONTRIBUTING.md#shared-typescript-toolchain). Specific to this
package:

- **Peer dependencies:** `merge-gateway-sdk` and `@openaudr/audr`. The dev
  dependency on `merge-gateway-sdk` is pinned exactly to the floor of the peer range, so
  CI runs the suite against the oldest release the package claims to support. Raise the
  two together. The 0.4 type declarations omit fields Gateway returns (`usage.cost`, the
  cache and reasoning counters, `vendor`), so `GatewayResult` in `src/mapping.ts` declares
  the documented shape.
- **`@openaudr/audr`** is a peer dependency and a development dependency from npm, so the
  package tests and builds against the same published SDK range applications install.
- **Version:** `package.json` and `src/version.ts`; `tests/public-api.test.ts` keeps them
  equal.

```bash
make install     # install dependencies from the lockfile
make lint        # eslint, prettier --check and tsc --noEmit
make test        # vitest with the 90% coverage gate
make examples    # build, then run every example against dist/
make isolation   # build, then publint --strict and attw
make verify      # lint + test + examples + isolation
```

`make isolation` does not run the core's `scripts/verify-package.ts`: this package's peer
dependencies are intended.
