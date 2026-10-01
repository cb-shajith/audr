# @openaudr/adapter-mastra

[![npm](https://img.shields.io/npm/v/@openaudr/adapter-mastra?include_prereleases)](https://www.npmjs.com/package/@openaudr/adapter-mastra)
[![Node versions](https://img.shields.io/node/v/@openaudr/adapter-mastra)](https://www.npmjs.com/package/@openaudr/adapter-mastra)

> **Status: experimental.** Its public names may change in minor releases until it
> graduates.

A [Mastra](https://mastra.ai) observability exporter that turns each ended `model_generation`
span and each `tool_call` / `mcp_tool_call` span into one
[AUDR](https://openaudr.dev/spec/v1.0.0/) record and hands it to an `@openaudr/audr` `Client`
your application owns. It reads usage, identifiers and timings only: never prompts,
completions, tool inputs, tool outputs or error messages. The application owns the client
and its sink, including construction and shutdown.

## Install

```bash
npm install @openaudr/audr @openaudr/adapter-mastra @mastra/observability
```

Requires Node.js 22.12 or later. `@mastra/core`, `@mastra/observability` and `@openaudr/audr`
are peer dependencies: the adapter uses the application's copies and imports only types from
`@mastra/*`. The `@mastra/observability` floor is the first release that emits `span_ended`
once per span and does not re-add Anthropic cache tokens to `inputTokens`; older releases
can produce duplicate or inflated records.

## Activate and shut down

Create a host-owned `Client`, an `AudrExporter`, and register the exporter on Mastra
observability:

```ts
import { Agent } from '@mastra/core/agent';
import { Mastra } from '@mastra/core/mastra';
import { Observability } from '@mastra/observability';
import { Client } from '@openaudr/audr';
import { AudrExporter } from '@openaudr/adapter-mastra';
import { FileSink } from '@openaudr/audr/file';

const client = new Client(new FileSink('audr.jsonl'), {
  emitter: { component: 'harness', name: 'my-app', version: '1.0.0' },
});
const exporter = new AudrExporter({
  client,
  attributionDefaults: { environment: 'production' },
});

const model = …; // any AI SDK language model
const agent = new Agent({ id: 'support', name: 'Support', instructions: '…', model });
const mastra = new Mastra({
  agents: { agent },
  observability: new Observability({
    configs: { default: { serviceName: 'my-app', exporters: [exporter] } },
  }),
});

await agent.generate('Where is order 42?', {
  tracingOptions: { metadata: { audr: { account_id: 'acct_42', subscription_id: 'sub_7' } } },
});

await mastra.shutdown();
await client.shutdown();
```

Shut down in that order: `await mastra.shutdown()` then `await client.shutdown()`. The
exporter's `shutdown()` does not close the client; `flush()` on the exporter delegates to
`client.flush()`. The adapter never creates, configures or shuts down a sink.

A runnable version of this, with a mock model and no network, is
[`examples/agent.ts`](https://github.com/openaudr/audr/blob/main/adapters/mastra/typescript/examples/agent.ts).

### Observability settings

Metered spans reach the exporter only when Mastra observability emits them. At registration
the exporter warns with `CONFIG_DROPS_SPANS` when `sampling.type` is not `always` or when
`excludeSpanTypes` lists `model_generation`, `tool_call` or `mcp_tool_call`.

## Attribution

Attribution is resolved per ended span from `metadata.audr` merged field by field over
`attributionDefaults` (span metadata wins; `labels` merge by key):

```ts
await agent.generate('…', {
  tracingOptions: {
    metadata: {
      audr: {
        account_id: 'acct_42',
        subscription_id: 'sub_7',
        user_id: 'u_8f14e45f', // pseudonymous, never an email or a name
        labels: { feature: 'support-chat' },
      },
    },
  },
});
```

Alternatively, set attribution on the request context and list the key in the observability
config so Mastra copies it onto span metadata:

```ts
import { RequestContext } from '@mastra/core/request-context';

const requestContext = new RequestContext();
requestContext.set('audr', { account_id: 'acct_42' });

const observability = new Observability({
  configs: {
    default: {
      serviceName: 'my-app',
      exporters: [exporter],
      requestContextKeys: ['audr'],
    },
  },
});

await agent.generate('…', { requestContext });
```

Metadata propagates from the root span to every child span. The reader keeps `environment`,
`user_id`, `account_id` and `subscription_id` when each is a string, and `labels` when it is
an object of strings; anything else is dropped. The `Client` validates the rest; for example a
`production` record without `account_id` is rejected and logged. A span with no resolvable
`environment` after the merge is skipped with an `ATTRIBUTION_UNRESOLVED` warning rather than
billed to a guess.

## Record shape

| Mastra span (`span_ended`) | `resource.operation` | `resource.type` | `usage` |
| --- | --- | --- | --- |
| `model_generation` | `generation` | `model` | `llm` |
| `tool_call`, `mcp_tool_call` | `tool_execution` | `tool` | `tool: { type: 'invocation', call_count: 1 }` |

`model_step` and `model_chunk` spans are ignored: Mastra rolls step usage into
`model_generation`, so metering those spans would double-count.

- **Tokens.** `input_tokens` is Mastra `inputTokens` minus cache read and write, reported as
  `cache_read_tokens` and `cache_write_tokens`; `output_tokens` is `outputTokens` minus
  reasoning, reported as `reasoning_tokens`. Audio and image tokens stay inside the input and
  output totals. `requests` and `cost` are never written. A counter Mastra did not report is
  omitted, not zeroed. A generation that ends with no usage is not recorded.
- **Model.** `resource.name` is `responseModel` when set, otherwise `model`.
  `resource.modality` is `text`. `resource.provider` is derived from the AI SDK provider id on
  the span (see below).
- **Tools.** `resource.provider` is `self-hosted` and `resource.name` is the tool name
  (`entityName`). A failed tool sets `run.error_code` to `MASTRA_TOOL_ERROR`; the error itself
  is never read. A failed generation that still reported usage is recorded with
  `MASTRA_MODEL_ERROR`.
- **Identifiers.** `run.run_id` is Mastra `traceId`, so sub-agents in the same trace share a
  run; `run.trace_id` is the same value when it is a 32-digit W3C trace id. A caller-supplied
  `tracingOptions.traceId` shorter than 8 characters cannot be a `run_id`, so the client
  rejects those records. `run.span_id` is the span id; `run.parent_span_id` is set when
  present. The `@openaudr/audr` SDK mints `record_id`, and the `Client` stamps its own
  `emitter`.
- **Timing.** `timing.event_time` is when the span ended. `timing.duration_ms` is the span
  wall time when both ends are valid.

### Provider slugs

`resource.provider` must match `^[a-z0-9-]+$`. The Mastra provider id is mapped in this order:

1. The alias table below. Each prefix matches itself and every `<prefix>.<api>` id.
2. The text before the first `.`, lowercased, with other characters replaced by `-`:
   `openai.chat` → `openai`, `anthropic.messages` → `anthropic`.

| AI SDK provider id | `resource.provider` |
| --- | --- |
| `gateway` | `vercel-ai-gateway` |
| `azure` | `azure-openai` |
| `amazon-bedrock`, `bedrock`, `bedrock-mantle` | `aws-bedrock` |
| `google.vertex`, `googleVertex`, `vertex` | `google-vertex` |

A generation with no valid provider slug or model name is skipped with `RESOURCE_UNRESOLVED`.

## What is not metered

- `model_step`, `model_chunk`, and every span type other than `model_generation`, `tool_call`
  and `mcp_tool_call`.
- Mastra internal model calls, whose usage Mastra rolls into `internalUsage` on an ancestor
  span, unless observability is configured with `includeInternalSpans: true`.
- Embedding calls (`rag_embedding` spans).
- Provider-executed tools and client-side tools Mastra does not surface as `tool_call` /
  `mcp_tool_call` spans.
- Mastra's own estimated cost on spans.
- Spans dropped by sampling, `excludeSpanTypes` or a `spanFilter`.
- Generations that end without reported token usage.

Prompts, completions, tool arguments, tool results and error messages are never read.

## Operational bounds

- The exporter handles `span_ended` events only. It never throws back into Mastra; an
  exception while exporting is logged as `EXPORT_FAILED` with the error class name only.
- A record the client does not queue is logged as `RECORD_NOT_QUEUED` with the outcome and each
  issue as `<code>@<path>`.
- The adapter logs nothing unless given a `logger`. Pass `console` or any logger with `warn`
  and `error` to receive diagnostics as
  `@openaudr/adapter-mastra: <CODE> (<key>=<value>, ...)`. They carry span types,
  setting names, submit outcomes, issue paths and error class names, never a record value or an
  error message.
- `AudrExporter` throws `ConfigurationError` when `client` does not implement `record()` and
  `flush()`. Nothing else in the package throws.

## Reference

This adapter implements [AUDR v1.0.0](https://openaudr.dev/spec/v1.0.0/) through the
[`@openaudr/audr`](https://www.npmjs.com/package/@openaudr/audr) SDK. The rules every adapter
follows are in
[`adapters/CONTRIBUTING.md`](https://github.com/openaudr/audr/blob/main/adapters/CONTRIBUTING.md).

## Contributing

Contributions are welcome — see
[`CONTRIBUTING.md`](https://github.com/openaudr/audr/blob/main/CONTRIBUTING.md).

Licensed under Apache-2.0.
