# audr-adapter-vercel-ai

[![npm](https://img.shields.io/npm/v/audr-adapter-vercel-ai?include_prereleases)](https://www.npmjs.com/package/audr-adapter-vercel-ai)
[![Node versions](https://img.shields.io/node/v/audr-adapter-vercel-ai)](https://www.npmjs.com/package/audr-adapter-vercel-ai)

> **Status: experimental.** Its public names may change in minor releases until it
> graduates.

A [Vercel AI SDK](https://ai-sdk.dev) 7 telemetry integration that turns every provider
model call, client-side tool execution, embedding call and rerank call into one
[AUDR](https://openaudr.dev/spec/v1.0.0/) record and hands it to an `audr` `Client` your
application owns. It reads usage, identifiers and timings only: never prompts, messages,
completions, tool inputs, tool outputs or error messages. The application owns the client
and its sink, including construction and shutdown.

## Install

```bash
npm install audr audr-adapter-vercel-ai ai
```

Requires Node.js 22.12 or later and `ai` 7.0.98 or later within 7.x, the first release
that passes `runtimeContext` to embedding and rerank calls. `ai` is an optional peer
dependency: the
adapter imports only its types, so installing the adapter never pulls the AI SDK into a
process that does not already use it.

## Activate and shut down

Register the integration once at startup. Every `generateText`, `streamText`,
`ToolLoopAgent`, `embed`, `embedMany` and `rerank` call is then metered:

```ts
import { generateText, registerTelemetry } from 'ai';
import { Client } from 'audr';
import { FileSink } from 'audr/file';
import { audrTelemetry } from 'audr-adapter-vercel-ai';

const client = new Client(new FileSink('audr.jsonl'), {
  emitter: { component: 'harness', name: 'my-app', version: '1.0.0' },
});
registerTelemetry(audrTelemetry({ client, attributionDefaults: { environment: 'production' } }));

await generateText({
  model: 'openai/gpt-5.4',
  prompt: 'Where is order 42?',
  runtimeContext: { audr: { account_id: 'acct_42', subscription_id: 'sub_7' } },
  telemetry: { includeRuntimeContext: { audr: true } },
});

// After the application has stopped starting AI SDK calls and awaited the ones in flight.
await client.shutdown();
```

To meter a single call instead, pass the integration per call. A single-tenant
application can put its `account_id` in the defaults:

```ts
const audr = audrTelemetry({
  client,
  attributionDefaults: { environment: 'production', account_id: 'acct_42' },
});

await generateText({ model, prompt, telemetry: { integrations: [audr] } }); // model, prompt: ...
```

Every hook submits its record to `client.record()` before it returns, so the adapter holds
nothing once an AI SDK call settles; there is no `drain()` or `close()`. Shut down in this
order: stop starting AI SDK calls, await the ones in flight, then `await client.shutdown()`.
The adapter never creates, flushes or shuts down the client.

A runnable version of this, with a mock model and no network, is
[`examples/generate-text.ts`](https://github.com/openaudr/audr/blob/main/adapters/vercel-ai/typescript/examples/generate-text.ts).

### Metering follows telemetry settings

> [!IMPORTANT]
> The AI SDK routes metering through its telemetry settings, so turning telemetry off
> turns metering off too.
>
> - `telemetry: { isEnabled: false }` on a call disables every integration for that call,
>   including this one. That call is not metered.
> - A per-call `telemetry.integrations` array **replaces** the globally registered
>   integrations. A call that passes `integrations: [otel]` must add the AUDR integration
>   to that array (`integrations: [otel, audr]`) or it is not metered.

## Attribution

Attribution is resolved once per operation, when it starts, from `runtimeContext.audr`
merged field by field over `attributionDefaults` (the call wins; `labels` merge by key):

```ts
await generateText({
  model,
  prompt, // model, prompt: ...
  runtimeContext: {
    audr: {
      account_id: 'acct_42',
      subscription_id: 'sub_7',
      user_id: 'u_8f14e45f', // pseudonymous, never an email or a name
      labels: { feature: 'support-chat' },
    },
  },
  telemetry: { includeRuntimeContext: { audr: true } },
});
```

- **`includeRuntimeContext: { audr: true }` is required.** The AI SDK strips every
  `runtimeContext` key not whitelisted there before integrations see it. Without it, only
  `attributionDefaults` apply.
- The default reader keeps `environment`, `user_id`, `account_id` and `subscription_id`
  when each is a string, and `labels` when it is an object of strings. Anything else is
  dropped. The `Client` validates the rest; for example a `production` record without
  `account_id` is rejected and logged.
- Omit `environment` from `attributionDefaults` to require it on every call. An operation
  whose attribution has no `environment` is skipped with an `ATTRIBUTION_UNRESOLVED`
  warning rather than billed to a guess.
- `resolveAttribution` replaces the default reader, for applications that keep tenancy
  elsewhere in `runtimeContext`. It receives the operation id, `telemetry.functionId` and
  the filtered `runtimeContext`; returning `undefined` means "defaults only". If it
  throws, the operation is skipped with a `RESOLVER_FAILED` warning.

```ts
audrTelemetry({
  client,
  attributionDefaults: { environment: 'production' },
  resolveAttribution: ({ runtimeContext }) => {
    const tenant = runtimeContext.tenant;
    return typeof tenant === 'string' ? { account_id: tenant } : undefined;
  },
});
```

### `ToolLoopAgent`

An agent's `runtimeContext` and `telemetry` are constructor settings. For per-request
attribution, declare the request options with `callOptionsSchema` and return
`runtimeContext` from `prepareCall`:

```ts
const agent = new ToolLoopAgent({
  model,
  tools, // model, tools: ...
  telemetry: { functionId: 'support-agent', includeRuntimeContext: { audr: true } },
  callOptionsSchema: z.object({ accountId: z.string() }),
  prepareCall: ({ options, ...settings }) => ({
    ...settings,
    runtimeContext: { audr: { account_id: options.accountId } },
  }),
});

await agent.generate({ prompt: 'Where is order 42?', options: { accountId: 'acct_42' } });
```

The full form is
[`examples/agent-call-options.ts`](https://github.com/openaudr/audr/blob/main/adapters/vercel-ai/typescript/examples/agent-call-options.ts).

### Sub-agents

An AI SDK call started inside a tool's `execute` joins the calling run: its records reuse
the parent's `run.run_id`, set `run.parent_span_id` to the spawning tool's span, share the
parent's `run.step` sequence and inherit the parent's attribution. The inner call's own
`runtimeContext.audr` is ignored, so a sub-agent cannot bill its work to another account.
Only a call metered by the same `audrTelemetry()` instance joins; a call that another
instance meters starts its own run with that instance's attribution. See
[`examples/sub-agent.ts`](https://github.com/openaudr/audr/blob/main/adapters/vercel-ai/typescript/examples/sub-agent.ts).

## Record shape

| AI SDK event | `resource.operation` | `resource.type` | `usage` |
| --- | --- | --- | --- |
| Each provider model call (each step of a tool loop; each stream) | `generation` | `model` | `llm` |
| Each client-side tool `execute` | `tool_execution` | `tool` | `tool: { type: 'invocation', call_count: 1 }` |
| Each embedding provider call (`embed`; each `embedMany` chunk) | `embedding` | `model` | `llm: { input_tokens?, requests: 1 }` |
| Each `rerank` provider call | `reranking` | `model` | `llm: { requests: 1 }` |

- **Tokens.** `input_tokens` excludes cache reads and writes, which are reported as
  `cache_read_tokens` and `cache_write_tokens`; `output_tokens` excludes reasoning, reported
  as `reasoning_tokens`. `requests` is always `1`. A counter the provider did not report is
  omitted, not zeroed. `totalTokens` and cost are never written; rating happens downstream.
- **Model.** `resource.name` is the model id the provider echoed in its response, and
  `resource.modality` is `text`.
- **Tools.** `resource.provider` is `self-hosted` and `resource.name` is the tool name. A
  tool that throws produces a record with `run.error_code` `VERCEL_AI_TOOL_ERROR`
  (exported as `TOOL_ERROR_CODE`); the error itself is never read.
- **Identifiers.** `run.run_id` is the AI SDK `callId` of the root call. `run.span_id` is
  `model:<callId>:<n>`, `tool:<callId>:<toolCallId>`, `embed:<embedCallId>` or
  `rerank:<callId>:<n>`. When a provider reuses a tool call id within one call, the later
  executions get `tool:<callId>:<toolCallId>:<n>`, so no two operations share a span.
  `run.step` is a run-wide ordinal in emission order; a record the `Client` does not queue
  still takes its step, so a gap in the sequence marks a record that was not delivered.
  `run.run_type` is `agent_run` for `generateText` and `streamText`, `single_call` for
  embeddings and reranking. `run.name` is `telemetry.functionId` when set. The `audr` SDK
  mints `record_id`, and the `Client` stamps its own `emitter`.
- **Timing.** `timing.event_time` is when the operation completed (for a stream, when it
  ended). `timing.duration_ms` is the provider response time, the tool's execution time,
  or the embedding or rerank call's wall time.

### Provider slugs

`resource.provider` must match `^[a-z0-9-]+$`. The AI SDK provider id is mapped in this
order:

1. `mapResource({ provider, modelId })`, when given and it returns a mapping.
2. The alias table below. Each prefix matches itself and every `<prefix>.<api>` id.
3. The text before the first `.`, lowercased, with other characters replaced by `-`:
   `openai.responses` → `openai`, `anthropic.messages` → `anthropic`.

| AI SDK provider id | `resource.provider` |
| --- | --- |
| `gateway` | `vercel-ai-gateway` |
| `azure` | `azure-openai` |
| `amazon-bedrock`, `bedrock`, `bedrock-mantle` | `aws-bedrock` |
| `google.vertex`, `googleVertex`, `vertex` | `google-vertex` |

A provider that maps to no valid slug is skipped with a `PROVIDER_UNMAPPED` warning. If
`mapResource` throws, the record is skipped with a `MAP_RESOURCE_FAILED` warning rather
than falling back to the default slug.

> [!NOTE]
> In AI SDK 7 a plain string model such as `'openai/gpt-5.4'` resolves to the Vercel AI
> Gateway by default, so those calls are recorded with `resource.provider`
> `vercel-ai-gateway` and `resource.name` `openai/gpt-5.4`, because the gateway meters and
> bills them. To attribute them to the model vendor instead, return a mapping from
> `mapResource`:
>
> ```ts
> audrTelemetry({
>   client,
>   mapResource: ({ provider, modelId }) => {
>     if (provider !== 'gateway') return undefined;
>     const slash = modelId.indexOf('/');
>     return slash > 0
>       ? { provider: modelId.slice(0, slash), name: modelId.slice(slash + 1) }
>       : undefined;
>   },
> });
> ```

## What is not metered

- Tokens of a model call aborted mid-stream: the AI SDK reports no end event for it.
- A provider attempt that fails and is retried: only the attempt that succeeds is reported.
- Provider-executed tools, such as a provider-hosted web search. The provider's own
  records cover them.
- The deprecated `generateObject` and `streamObject`. The first call of each logs one
  `OPERATION_UNSUPPORTED` warning. Use `generateText` with `output`.
- Image, speech, transcription, video and realtime models, and `experimental_evaluate`.
- Calls with `telemetry: { isEnabled: false }`, or with per-call `integrations` that omit
  this integration.
- Per-call attribution on a call without `includeRuntimeContext: { audr: true }`.

## Operational bounds

- `maxTrackedOperations` (default 10000) bounds the operations tracked at once, each
  sub-agent call counting as one. Past the bound the oldest is evicted with an
  `OPERATION_EVICTED` warning, and its later events produce no records.
  Everything else the adapter holds, such as embed and rerank start times, belongs to an
  operation and is released with it.
- Hooks never throw into the AI SDK. An exception inside one is logged as `HOOK_FAILED`
  with the hook name and the error class. A record the client does not queue is logged as
  `RECORD_NOT_QUEUED` with the outcome, the operation and each issue as `<code>@<path>`.
- Diagnostics go to `logger` (default `console`) as
  `audr-adapter-vercel-ai: <CODE> (<key>=<value>, ...)` and carry AI SDK operation ids
  (`operation=ai.generateText`), hook names, error class names, counts and issue paths,
  never a record value or an error message. `DiagnosticCode` lists every code.
- `audrTelemetry` throws `ConfigurationError` when `client` has no `record()` or
  `maxTrackedOperations` is not an integer of at least 1. Nothing else in the package
  throws.

## Runtime support

The adapter is tested on Node.js 22, 24 and 26. Its only runtime API is
`AsyncLocalStorage` from `node:async_hooks`, used for sub-agent joining. Runtimes that
provide it, such as Bun, Deno, Vercel Edge Functions and Cloudflare Workers with the
`nodejs_compat` flag, are expected to work but are not tested; reports are welcome.

## Reference

This adapter implements [AUDR v1.0.0](https://openaudr.dev/spec/v1.0.0/) through the
[`audr`](https://www.npmjs.com/package/audr) SDK. The rules every adapter follows are in
[`adapters/CONTRIBUTING.md`](https://github.com/openaudr/audr/blob/main/adapters/CONTRIBUTING.md).

## Contributing

Contributions are welcome — see
[`CONTRIBUTING.md`](https://github.com/openaudr/audr/blob/main/CONTRIBUTING.md).

Licensed under Apache-2.0.
