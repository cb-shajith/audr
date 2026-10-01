# @openaudr/audr-adapter-merge-gateway

[![npm](https://img.shields.io/npm/v/@openaudr/audr-adapter-merge-gateway?include_prereleases)](https://www.npmjs.com/package/@openaudr/audr-adapter-merge-gateway)
[![Node versions](https://img.shields.io/node/v/@openaudr/audr-adapter-merge-gateway)](https://www.npmjs.com/package/@openaudr/audr-adapter-merge-gateway)

> **Status: experimental.** Its public names may change in minor releases until it
> graduates.

Meters calls made through [Merge Gateway](https://docs.merge.dev/merge-gateway/overview)'s
native TypeScript SDK. Every `responses.create()`, streaming or not, and every
`embeddings.create()` becomes one [AUDR](https://openaudr.dev/spec/v1.0.0/) record, handed
to an `@openaudr/audr` `Client` your application owns. The adapter reads requested output
modalities, usage, cost, identifiers and the served model only: never input, output, tools,
tags or error messages. The application owns the client and its sink, including construction
and shutdown.

## Install

```bash
npm install @openaudr/audr @openaudr/audr-adapter-merge-gateway merge-gateway-sdk
```

Requires Node.js 22.12 or later and `merge-gateway-sdk` 0.4.x. Both
`merge-gateway-sdk` and `@openaudr/audr` are peer dependencies, so the adapter uses the
application's compatible copies. It imports only the Gateway SDK's types.

## Activate and shut down

Wrap your `MergeGateway` once at startup and use the returned facade wherever you would use
the client:

```ts
import { instrumentMergeGateway } from '@openaudr/audr-adapter-merge-gateway';
import { Client } from '@openaudr/audr';
import { FileSink } from '@openaudr/audr/file';
import { MergeGateway } from 'merge-gateway-sdk';

const client = new Client(new FileSink('audr.jsonl'));
const gateway = instrumentMergeGateway(
  new MergeGateway({ apiKey: process.env.MERGE_GATEWAY_API_KEY ?? '', timeout: 300_000 }),
  { client, attributionDefaults: { environment: 'production', account_id: 'acct_42' } },
);

await gateway.responses.create({ model: 'openai/gpt-5.4', input: 'Where is order 42?' });

// After the application has stopped starting Gateway calls and awaited the ones in flight.
await client.shutdown();
```

The facade is the native client behind a `Proxy`: it is still an `instanceof MergeGateway`,
has the SDK's own type, keeps its return values and forwards `models`, `tags`, `customers`
and every other member untouched. Every argument you pass to `create()` reaches the native
method unchanged. The native client itself is never modified, so calls made on it directly
are not metered. Instrumenting a facade a second time throws, so no call is recorded twice;
instrumenting the same native client twice gives two independent facades.

Each call submits its record to `client.record()` before its promise settles (for a stream,
before the terminal frame reaches your loop), so the adapter holds nothing once a call
completes; there is no `drain()` or `close()`. Shut down in this order: stop starting
Gateway calls, await the ones in flight, then `await client.shutdown()`. The adapter never
creates, flushes or shuts down the client.

The `timeout: 300_000` above follows Merge's
[streaming guidance](https://docs.merge.dev/merge-gateway/streaming#timeouts-and-disconnects):
the SDK aborts a request whose response has not started within `timeout`, 60 seconds by
default, Gateway still bills a call it has started, and an aborted call produces no record
(see [What is not metered](#what-is-not-metered)).

Runnable versions, answered by a local stand-in for the Gateway API, are
[`examples/responses.ts`](https://github.com/openaudr/audr/blob/main/adapters/merge-gateway/typescript/examples/responses.ts),
[`examples/streaming.ts`](https://github.com/openaudr/audr/blob/main/adapters/merge-gateway/typescript/examples/streaming.ts),
[`examples/embeddings.ts`](https://github.com/openaudr/audr/blob/main/adapters/merge-gateway/typescript/examples/embeddings.ts)
and
[`examples/tracing.ts`](https://github.com/openaudr/audr/blob/main/adapters/merge-gateway/typescript/examples/tracing.ts).

## Attribution

A single-tenant service can put its whole billing identity in `attributionDefaults`. When
it varies per request, open a scope with `withAudr` where it is known. Every call an
instrumented client starts inside the scope, including in promises the scope creates,
carries it:

```ts
import { withAudr } from '@openaudr/audr-adapter-merge-gateway';

const answer = await withAudr(
  {
    attribution: {
      account_id: 'acct_42',
      subscription_id: 'sub_7',
      user_id: 'u_8f14e45f', // pseudonymous, never an email or a name
      labels: { feature: 'support-chat' },
    },
  },
  () => gateway.responses.create({ model: 'openai/gpt-5.4', input: 'Where is order 42?' }),
);
```

- A scope applies to every instrumented client, not only one: a client created inside the
  scope, such as a per-run client for [tracing](#tracing-with-merge-gateway), carries it too.
  `withAudr` returns exactly what its body returns.
- Scope attribution is merged field by field over `attributionDefaults` (the scope wins;
  `labels` merge by key). Scopes nest the same way, the inner scope winning.
- Attribution is captured when a call starts, so a stream read after its scope has exited
  keeps the identity it was created under.
- Only `environment`, `account_id`, `subscription_id`, `user_id` and `labels` are copied
  into a record; any other key is dropped. The values themselves are checked by the
  `Client`, not the adapter: a record it rejects, for example a `production` record without
  `account_id` or one whose `account_id` is not a string, is logged as `RECORD_NOT_QUEUED`
  with the path of each problem.
- `attributionDefaults` is copied when you instrument; changing the object afterwards has
  no effect.
- Omit `environment` from `attributionDefaults` to require it in every scope. A call whose
  attribution has no `environment` is not metered and logs `ATTRIBUTION_UNRESOLVED`; the
  call itself proceeds unchanged.
- A context `withAudr` cannot read is ignored: the body still runs, under the outer scope.
- Merge's own `customer`, `project_id`, `tags` and `session_id` are never read. They
  configure Gateway routing and budgets, not AUDR attribution.

### Agent runs

A harness that already has a run id can pass it, so every Gateway call in the scope joins
that run:

```ts
await withAudr(
  { run: { run_id: 'run-order-42-support', parent_span_id: 'agent:1', name: 'support-agent' } },
  async () => {
    await gateway.responses.create({ model: 'openai/gpt-5.4', input: 'Plan the reply.' });
    await gateway.responses.create({ model: 'openai/gpt-5.4', input: 'Write the reply.' });
  },
);
```

- Those records share `run.run_id`, carry `run.parent_span_id` and `run.name`, and have
  `run.run_type` `agent_run`. Each keeps its own `run.span_id`, `response:<response id>`.
- A nested scope with the same `run_id` keeps the outer `parent_span_id` and `name` unless
  it sets its own, so a tool can pass `{ run_id, parent_span_id: 'tool:1' }` alone. A nested
  scope with a different `run_id` starts a separate run and inherits nothing from the outer
  one.
- `run.step` is not written. The adapter cannot know a call's position in a run that spans
  several scopes, processes or concurrent calls; order records by `timing.event_time`.
- `run_id` must be 8 to 64 characters, or the `Client` rejects the record.

## Tracing with Merge Gateway

Merge Gateway groups the requests of one run into a trace when each carries an
`X-Merge-Trace-Id` header ([Tracing](https://docs.merge.dev/merge-gateway/observability/tracing)).
AUDR groups the records of one run by `run.run_id`. Use the same id for both, and Merge's
Logs and your AUDR records describe the same run.

`merge-gateway-sdk` 0.4 sends headers per client (`defaultHeaders`), not per call, so give
each run its own client. A `MergeGateway` holds no connections, so creating one per run is
cheap, and because scopes apply to every instrumented client, the per-run client is covered
by the scope it runs in:

```ts
import { instrumentMergeGateway, withAudr } from '@openaudr/audr-adapter-merge-gateway';
import { uuidv7 } from '@openaudr/audr';
import { MergeGateway } from 'merge-gateway-sdk';

async function handleTicket(accountId: string, ticket: string): Promise<void> {
  const runId = `run-${uuidv7()}`;
  const gateway = instrumentMergeGateway(
    new MergeGateway({
      apiKey: process.env.MERGE_GATEWAY_API_KEY ?? '',
      timeout: 300_000,
      defaultHeaders: { 'X-Merge-Trace-Id': runId, 'X-Merge-Thread-Id': ticket },
    }),
    { client, attributionDefaults: { environment: 'production' } },
  );
  await withAudr(
    { attribution: { account_id: accountId }, run: { run_id: runId, name: 'support-agent' } },
    async () => {
      await gateway.responses.create({ model: 'openai/gpt-5.4', input: 'Draft a reply.' });
      await gateway.responses.create({ model: 'openai/gpt-5.4', input: 'Critique the draft.' });
    },
  );
}
```

- **Choose an id both systems accept**: 8 to 64 characters (AUDR's `run_id` limit) from
  `A-Z a-z 0-9 . _ : -` (Merge's header alphabet). Merge silently drops an invalid or
  over-long header and the request goes untraced; the `Client` rejects a `run_id` outside 8
  to 64 characters and logs `RECORD_NOT_QUEUED`. `run-` and a UUID, as above, fits both.
- **Mint a fresh id per run.** Merge merges every request that shares a trace id, and AUDR
  requires `run_id` to be unique within an account.
- **Threads and turns** (`X-Merge-Thread-Id`, `X-Merge-Turn-Id`) group requests in Merge's
  Logs only. AUDR has no field for them, and a per-conversation id does not belong in
  `labels`.
- **Spans do not line up.** Merge identifies a span by the response's `X-Request-ID`
  header, which `merge-gateway-sdk` 0.4 does not expose, so a record's `run.span_id` is
  `response:<response id>` instead. Join records to Merge traces by run, not by span. For
  the same reason `X-Merge-Span-Name` and `X-Merge-Parent-Span-Id`, which describe a single
  call, cannot be set through 0.4: as `defaultHeaders` they would apply to every call of
  the client. If a later SDK accepts per-call options, the facade passes them on unchanged.
- **`run.parent_span_id` is your span, not Merge's**: the harness span that the scope's
  calls belong to.
- **`run.trace_id` is never written.** AUDR reserves it for a W3C trace id, which
  `X-Merge-Trace-Id` is not. Merge records a W3C `traceparent` header separately, as
  *Client trace ID*.
- **A traced Fusion request** shows its panel calls as child spans in Merge, but produces
  one record (see [Record shape](#record-shape)).

The runnable version is
[`examples/tracing.ts`](https://github.com/openaudr/audr/blob/main/adapters/merge-gateway/typescript/examples/tracing.ts).

## Streams

```ts
const stream = await gateway.responses.create({
  model: 'anthropic/claude-sonnet-5',
  input: 'Write a short answer.',
  stream: true,
});
for await (const frame of stream) {
  if (frame.object === 'response.done') console.log('done');
}
```

The returned stream is the native `Stream` behind a proxy, and every frame is yielded
unchanged. Gateway reports usage and cost only on the terminal `response.done` frame, so the
record is built from that frame. A `fallback_restart` frame, sent when Gateway fails over to
another vendor, needs nothing: only the terminal frame is read.

A stream that produces no terminal frame produces no record and logs one
`STREAM_INCOMPLETE` warning, whose `reason` is `error_frame` (a `response.error` frame,
which ends a Gateway stream), `ended` (the body ended first), `failed` (reading threw),
`abandoned` (the loop stopped early) or `closed` (`close()` was called first).

A stream your code never iterates or closes produces neither a record nor a warning: there
is no moment at which the adapter can tell it was dropped. Gateway still bills such a
stream, so read streams to their terminal frame when every call must be metered.

## Record shape

| Native call | `resource.operation` | `usage.llm` | `cost` |
| --- | --- | --- | --- |
| `responses.create()`, or the `response.done` frame of a stream | `generation` | tokens as below, `requests: 1` | `usage.cost` |
| `embeddings.create()` | `embedding` | `input_tokens` from `prompt_tokens`, `requests: 1` | `usage.cost` |

- **Tokens.** On Gateway's native API, `input_tokens` counts the whole prompt and
  `output_tokens` includes reasoning. The adapter writes `input_tokens` without the cache
  reads and writes, reported as `cache_read_tokens` (from `cache_read_input_tokens`) and
  `cache_write_tokens` (from `cache_creation_input_tokens`), and `output_tokens` without the
  reasoning, reported as `reasoning_tokens` (from `reasoning_output_tokens`). When a split
  counter is `null` because Gateway cannot count it, the dependent exclusive total is
  omitted rather than treating the unknown part as zero. A split field not present did not
  apply and is treated as zero. `total_tokens` is never copied.
- **Cost.** Gateway's per-call `usage.cost` becomes `cost.total_cost` with `currency`
  `USD`. It is Gateway's price for the route and service tier that served the call, net of
  discounts, without Merge's fee or server-tool charges such as web search; the invoice
  remains the authority. `null`, which Gateway returns for an unpriced route, writes no
  `cost`. No `cost.llm` breakdown is written.
- **Resource.** `resource.provider` is `merge-gateway` and `resource.name` is the model that
  served the call, verbatim (`openai/gpt-5.4`). `resource.modality` defaults to `text`;
  requested `image` or `audio` output uses that modality, and a request for more than one
  supported modality uses `multimodal`.
- **Emitter.** `emitter.component` is `router`, `emitter.name` is
  `@openaudr/audr-adapter-merge-gateway` and `emitter.version` is this package's version, because
  every counter and the cost are Gateway's own.
- **Identifiers.** Outside a run scope, `run.run_id` is the Merge response `id` and
  `run.run_type` is `single_call`; a response id outside 8 to 64 characters, and every
  embedding (whose response has no id), gets a fresh UUIDv7 instead. `run.span_id` is
  `response:<id>` or `embedding:<uuid>`. `run.step` is never written. The `@openaudr/audr`
  SDK mints `record_id`.
- **Failures.** A response with `status: 'failed'` is recorded with its usage and
  `run.error_code` `MERGE_GATEWAY_RESPONSE_FAILED` (exported as `RESPONSE_FAILED_CODE`). A
  call the SDK rejects, such as a `4xx`, produces no record.
- **Fusion.** A [Fusion](https://docs.merge.dev/merge-gateway/capabilities/fusion) request
  (`model: 'fusion'`) is one record. Gateway's `usage` and `usage.cost` already sum every
  panel call and the judge, so the cost is complete; `resource.name` is whatever `model` the
  response reports, and its token counts span several models, so price Fusion by `cost`
  rather than by tokens.
- **Timing.** `timing.event_time` is when the call completed (for a stream, when its
  terminal frame arrived) and `timing.duration_ms` is the time from the call to then.

### Mapping the resource

To price by the model vendor instead of by Gateway, return a mapping from `mapResource`. It
receives the served `model` and the execution `vendor` (`openai`, `bedrock`, ...):

```ts
const byVendor = instrumentMergeGateway(new MergeGateway({ apiKey: 'mg_...' }), {
  client,
  attributionDefaults: { environment: 'production' },
  mapResource: ({ model }) => {
    const [provider, ...name] = model?.split('/') ?? [];
    return provider && name.length > 0 ? { provider, name: name.join('/') } : null;
  },
});
```

Returning `undefined` or `null` keeps the default. A mapping whose `provider` does not match
`^[a-z0-9-]+$` is rejected by the `Client` and logged as `RECORD_NOT_QUEUED`; a
`mapResource` that throws skips the record with `HOOK_FAILED` rather than falling back to the
default; a call with no model name, reported or mapped, skips it with `MODEL_UNREPORTED`.

## What is not metered

- Calls made on the native client rather than the facade.
- Calls the SDK rejects: `4xx` and `5xx` responses, and requests it aborts because no
  response started within its `timeout` (60 seconds by default). Gateway still bills a call
  it has started and logs a disconnected request as `499`, so set `timeout` to at least 300
  seconds, as Merge recommends.
- Streams not read to their terminal frame, including streams never read at all (see
  [Streams](#streams)).
- The `models`, `tags` and `customers` resources, which are forwarded unmetered.
- Standalone endpoints the 0.4 SDK does not expose: chat completions, messages, images,
  audio, video, decisions and batches. Inline image output requested through
  `responses.create()` is metered as a response. Clients that reach Gateway through its
  OpenAI, Anthropic or AI SDK surfaces are metered by those SDKs' own adapters.
- Server-tool charges such as web search, which Gateway leaves out of `usage.cost`, and the
  served `service_tier`, which has no AUDR field.

## Operational bounds

- Metering never changes or fails a native call. A native error reaches your code
  unchanged and is never logged; an exception inside the adapter is logged as
  `HOOK_FAILED` with a fixed error category.
- The adapter holds no state between calls beyond the stream a call returned and the
  current `withAudr` scope.
- `instrumentMergeGateway` checks that `client` implements `record()`; other options use
  their TypeScript types as the contract. Record values are validated by `Client.record()`,
  which never throws: a record it does not queue is logged as `RECORD_NOT_QUEUED` with the
  outcome, the operation and each issue as `<code>@<path>`.
- `instrumentMergeGateway` throws `ConfigurationError` when `client` has no `record()` or
  when the gateway is already a facade. The adapter raises no other error of its own.
- Diagnostics go to `logger` as
  `@openaudr/audr-adapter-merge-gateway: <CODE> (<key>=<value>, ...)` and never carry a record
  value, an id, a model name, a mutable error name or an error message. `DiagnosticCode`
  lists every code. The default is silent; pass `console` to receive diagnostics:

| Code | Level | Logged when |
| --- | --- | --- |
| `ATTRIBUTION_UNRESOLVED` | warn | A call starts with no `environment` in its attribution; it is not metered |
| `MODEL_UNREPORTED` | warn | A response names no model and `mapResource` supplies none |
| `STREAM_INCOMPLETE` | warn | A stream ends without a terminal frame, with the `reason` |
| `RECORD_NOT_QUEUED` | warn | The `Client` does not queue a record, with the `outcome` and the `issues` |
| `HOOK_FAILED` | error | The adapter, `mapResource` or the client throws while metering, with the `error` category |

Each line also carries `operation`, `responses.create` or `embeddings.create`. Error
categories are `TypeError`, `RangeError`, `SyntaxError`, `ReferenceError`, `Error`, or the
`typeof` of a thrown non-error.

## Runtime support

The adapter is tested on Node.js 22, 24 and 26. Its only runtime API is
`AsyncLocalStorage` from `node:async_hooks`, used for `withAudr` scopes. Runtimes that
provide it, such as Bun, Deno and Cloudflare Workers with the `nodejs_compat` flag, are
expected to work but are not tested; reports are welcome.

## Reference

This adapter implements [AUDR v1.0.0](https://openaudr.dev/spec/v1.0.0/) through the
[`@openaudr/audr`](https://www.npmjs.com/package/@openaudr/audr) SDK. The Gateway behaviour
it relies on is documented in Merge's
[API details](https://docs.merge.dev/merge-gateway/api-overview),
[Streaming](https://docs.merge.dev/merge-gateway/streaming),
[Tracing](https://docs.merge.dev/merge-gateway/observability/tracing),
[Prompt caching](https://docs.merge.dev/merge-gateway/capabilities/prompt-caching),
[Reasoning](https://docs.merge.dev/merge-gateway/capabilities/reasoning) and
[Fusion](https://docs.merge.dev/merge-gateway/capabilities/fusion) pages. The rules every
adapter follows are in
[`adapters/CONTRIBUTING.md`](https://github.com/openaudr/audr/blob/main/adapters/CONTRIBUTING.md).

## Contributing

Contributions are welcome — see
[`CONTRIBUTING.md`](https://github.com/openaudr/audr/blob/main/CONTRIBUTING.md).

Licensed under Apache-2.0.
