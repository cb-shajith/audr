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
and shutdown in one file. The `example` extra installs everything it imports; the file
itself lives in the repository rather than in the distribution:

```bash
pip install "audr-adapter-nemo-relay[example]"
curl -O https://raw.githubusercontent.com/openaudr/audr/main/adapters/nemo-relay/python/examples/nemo_relay_chat.py
export OPENAI_API_KEY="..."
python nemo_relay_chat.py
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

Scope start metadata wins over `attribution_defaults` field by field, and child scopes
inherit the snapshot taken at their parent's start;
[attribution resolution](https://github.com/openaudr/audr/blob/main/adapters/nemo-relay/python/docs/attribution.md) states the full rules, including how
to require per-scope attribution and never bill to a fallback.

Do not place credentials in Relay metadata. The plugin reads no prompts, model responses,
tool arguments, or tool results.

## Reference

Behaviour consulted once the plugin is running, in the repository:

- [Errors](https://github.com/openaudr/audr/blob/main/adapters/nemo-relay/python/docs/errors.md) — every exception this package raises and what produces it.
- [Attribution resolution](https://github.com/openaudr/audr/blob/main/adapters/nemo-relay/python/docs/attribution.md) — how scope metadata, inheritance and defaults combine.
- [Record mapping](https://github.com/openaudr/audr/blob/main/adapters/nemo-relay/python/docs/record-mapping.md) — how Relay LLM and tool events become AUDR fields, including response codecs and token accounting.
- [Operational warnings and bounds](https://github.com/openaudr/audr/blob/main/adapters/nemo-relay/python/docs/operations.md) — the warnings the plugin emits, and the handoff and scope limits.

## Contributing

Contributions are welcome — see
[`CONTRIBUTING.md`](https://github.com/openaudr/audr/blob/main/CONTRIBUTING.md).

Licensed under Apache-2.0.
