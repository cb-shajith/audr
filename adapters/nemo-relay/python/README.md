# audr-adapter-nemo-relay

[![PyPI](https://img.shields.io/pypi/v/audr-adapter-nemo-relay?include_prereleases)](https://pypi.org/project/audr-adapter-nemo-relay/)

> **Status: experimental.** Its public names may change in minor releases until it
> graduates.

This adapter observes completed Relay 0.8 LLM and tool scopes and hands attributed
records to an existing `audr.Client`. The host application owns the
client and its sink, including construction, startup and shutdown.

## Install

```bash
pip install "audr-adapter-nemo-relay[runtime]"
```

The extra supports `nemo-relay>=0.8,<0.9`. `plugin.validate(...)` reports an unsupported
release, and activation requires a supported one to be installed. NeMo Relay is imported
at activation, so importing this package leaves it out of the process.

A runnable [NeMo Relay terminal chat example](https://github.com/openaudr/audr/blob/main/adapters/nemo-relay/python/examples/nemo_relay_chat.py) shows
plugin configuration, scoped attribution, an OpenAI-compatible model call, handoff drain,
and shutdown in one file. From this package directory:

```bash
pip install -e ".[example]"
export OPENAI_API_KEY="..."
python examples/nemo_relay_chat.py
```

The example makes billable network requests and appends usage records to
`nemo-relay-usage.jsonl` by default.

## Activate and shut down

```python
import asyncio

from nemo_relay import plugin as relay_plugin

from audr import Attribution, Client, FileSink
from audr_adapter_nemo_relay import (
    PLUGIN_KIND,
    NeMoRelayConfig,
    NeMoRelayPlugin,
)

component_config = NeMoRelayConfig(
    attribution_defaults=Attribution(
        environment="production",
        account_id="account_123",
    ),
)
relay_config = relay_plugin.PluginConfig(
    components=[
        relay_plugin.ComponentSpec(
            kind=PLUGIN_KIND,
            config=component_config.to_dict(),
        )
    ]
)


async def main() -> None:
    sink = FileSink("usage-events.jsonl")  # any Sink: FileSink, a Chargebee sink, your own
    client = Client(sink)
    # Construct on the running loop that owns the client, or pass loop= explicitly.
    usage_plugin = NeMoRelayPlugin(client=client)

    relay_plugin.register(PLUGIN_KIND, usage_plugin)
    try:
        async with relay_plugin.plugin(relay_config):
            # Run Relay-managed LLM and tool operations here.
            ...
        # Relay's context has flushed its callbacks and removed its registrations.
        await usage_plugin.drain(timeout=5)
        await client.shutdown()
    finally:
        relay_plugin.deregister(PLUGIN_KIND)


asyncio.run(main())
```

The shutdown order is significant, and each step depends on the previous one finishing:

1. Stop producing Relay-managed work.
2. Exit Relay's plugin context so its subscriber queue is flushed and cleared.
3. Await `usage_plugin.drain()` so every accepted cross-thread handoff reaches
   `client.record()`.
4. Shut down the client so its own delivery queue drains and its sink closes.

Only `deregister` belongs in `finally`. Draining or shutting down after a failed
activation would work on a client that never received anything, and `drain()` after
`close()` raises `NeMoRelayActivationError` rather than silently discarding handoffs.

Relay runs plugin registration and subscriber callbacks on its own worker threads.
`NeMoRelayPlugin` captures the client's event loop at construction and requires a running
loop, so build it inside the async function that owns the client or pass `loop=`
explicitly. That loop must be running when Relay activates the component.

`drain(timeout=...)` raises `TimeoutError` if its handoffs cannot complete in time.
One instance accepts one component activation: two would install two subscribers over
the same process-wide event stream and double-count every operation.

### Errors

| Error | Raised when |
| --- | --- |
| `NeMoRelayCompatibilityError` (a `ConfigurationError`) | The `nemo-relay` distribution is missing or outside `>=0.8,<0.9`. |
| `ConfigurationError` | Relay activated the component with configuration this plugin rejects. |
| `NeMoRelayActivationError` (a `LifecycleError`) | The host misused the lifecycle: no running loop, a second activation, or `drain()` after `close()`. |

A `register()` that raises for any reason leaves the instance unregistered, because
Relay rolls back every registration from that initialization.

## Attribution

Put AUDR attribution on the **root** Relay scope start under the `audr`
namespace:

```python
from nemo_relay import ScopeType, scope

with scope.scope(
    "support-agent",
    ScopeType.Agent,
    metadata={
        "audr": {
            "environment": "production",
            "account_id": "account_123",
            "subscription_id": "subscription_123",
            "user_id": "user_123",
            "labels": {"region": "us", "project": "support"},
        }
    },
):
    ...
```

Supported fields are `environment`, `user_id`, `account_id`, `subscription_id`, and
`labels`. Extra allocation dimensions belong in `labels`. A valid `environment` is
required before anything is submitted, and AUDR additionally requires `account_id`
when `environment` is `production`. `subscription_id` is not required by this
integration or by core AUDR; a destination that needs one to route or bill usage
(for example, the Chargebee sink) rejects records that arrive without it.

Resolution rules:

- Scope **start** metadata wins over `attribution_defaults`, field by field. Metadata on a
  completing scope is ignored, so a child cannot re-bill work its root already claimed.
- Child scopes inherit the snapshot taken at their parent's start.
- Relay never emits the outermost scope's own parent. A scope whose parent the plugin has
  **never observed** is therefore treated as a new billing root, and
  `attribution_defaults` apply.
- A scope whose parent the plugin observed and then **lost** — an evicted or already
  completed ancestor — is skipped instead of falling back to defaults, unless its own
  start declares the `audr` namespace. The ancestor that carried attribution is gone,
  and static defaults could bill the wrong subscription.

To require per-scope attribution and never bill to a fallback, omit `environment` from
`attribution_defaults`. Scopes that do not carry their own `environment` then resolve to
an incomplete attribution and are skipped.

Do not place credentials in Relay metadata. The plugin reads no prompts, model responses,
tool arguments, or tool results.

## LLM response codecs

Relay only emits provider-normalized token usage when the managed LLM call has a response
codec. Pass the matching codec to `nemo_relay.llm.execute`, for example
`nemo_relay.codecs.OpenAIChatCodec()`. An LLM end event without
`category_profile.annotated_response.usage` is skipped; the plugin derives usage from the
annotated response alone. Relay's `prompt_tokens` is the inclusive prompt total; AUDR's
`input_tokens` excludes cache reads and writes, so when Relay reports `cache_read_tokens` or
`cache_write_tokens` they are subtracted from it.

The billed model name is the provider-echoed `annotated_response.model`, as AUDR requires
(`resource.name` is the verbatim provider identifier), falling back to the `model_name` you
passed to `nemo_relay.llm.execute`. Providers version that echoed name — `gpt-4o` answering
as `gpt-4o-2024-08-06` — so aggregate across versions downstream rather than in the record.

The provider name is the Relay call name, lowercased and reduced to the `[a-z0-9-]`
alphabet AUDR requires, so a call named `My Provider_v2` meters as `my-provider-v2`.
Tool executions are client-executed, so they report the provider `self-hosted` and the
metering class `invocation`; the tool name is `resource.name`. LLM operations are billed
with `resource.operation="generation"` and `resource.modality="text"`.

## Record shape

Every completed operation becomes one `AUDR` record, with `record_id` minted fresh by
the SDK (Relay's scope UUIDs are not UUIDv7, the identifier shape AUDR's `record_id`
requires). The Relay scope UUID that ties related records together is carried on
`run.span_id` instead, and the Relay root scope UUID is `run.run_id`. The client applies
the normal AUDR validation before handing the record to your sink. `requests` and
`call_count` are one per completed operation. `total_tokens`, raw payloads, opaque
results, and cost are never copied.

## Operational warnings and bounds

Runtime counters live in the client, not the plugin. Skipped, malformed, dropped, evicted, and
internal-failure events produce privacy-safe warnings containing only stable event IDs,
field paths, counts, and queue outcomes. Unexpected failures are logged with a traceback;
values from the event are never logged. Use the host application's logs for plugin
failures and `client.stats` for end-to-end delivery totals. Relay component validation
returns the `ConfigDiagnostic` values Relay's Plugin protocol requires, each carrying a
stable `NeMoRelayDiagnosticCode`.

`max_pending_handoffs` bounds records waiting to reach the client's event loop
(1–100000, default 1000). `max_tracked_scopes` bounds incomplete structural scope state
(1–1000000, default 10000). Overflow is non-blocking: handoffs are dropped and old
incomplete scopes are evicted, with corresponding warnings.

## Contributing

[`AGENTS.md`](https://github.com/openaudr/audr/blob/main/adapters/nemo-relay/python/AGENTS.md)
records how to work inside this package — its layout, its invariants, and its commands.
[`adapters/CONTRIBUTING.md`](https://github.com/openaudr/audr/blob/main/adapters/CONTRIBUTING.md)
describes how to contribute an adapter, and the top-level
[`CONTRIBUTING.md`](https://github.com/openaudr/audr/blob/main/CONTRIBUTING.md) covers
repository setup and process.

Licensed under Apache-2.0.
