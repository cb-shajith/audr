# AGENTS.md

Directives for working inside this package. Tier-wide directives are in
[`adapters/AGENTS.md`](../../AGENTS.md); repository setup, the shared Python toolchain and
the contribution process are in the top-level [`CONTRIBUTING.md`](../../../CONTRIBUTING.md).

## What this is

`adapters/nemo-relay/python` is the `audr-adapter-nemo-relay` distribution: an in-process
NVIDIA NeMo Relay plugin that observes completed Relay LLM and tool scopes and hands
attributed `AgentUsageRecord`s to an `audr.Client` the host application owns. The host
constructs the client and its sink and controls startup and shutdown; this package never
creates either.

## Layout

| Path | Owns |
| --- | --- |
| `src/audr_adapter_nemo_relay/_plugin.py` | `NeMoRelayPlugin`: Relay's plugin protocol, activation, `drain()`, lifecycle errors |
| `src/audr_adapter_nemo_relay/_bridge.py` | The thread-safe handoff from Relay's subscriber worker onto the client's event loop |
| `src/audr_adapter_nemo_relay/_attribution.py` | Attribution resolution across scope trees, with defaults |
| `src/audr_adapter_nemo_relay/_mapping.py` | Privacy-preserving mapping from Relay events to records |
| `src/audr_adapter_nemo_relay/_config.py` | `NeMoRelayConfig` and the `ConfigDiagnostic` codes Relay's protocol requires |
| `src/audr_adapter_nemo_relay/_errors.py` | Exceptions with stable codes and value-free messages |
| `tests/` | The suite; `test_runtime.py` carries the `nemo_relay`-marked tests that need the real runtime |
| `examples/nemo_relay_chat.py` | A terminal chat that makes billable network calls; not run in CI |

## Working rules

1. One `NeMoRelayPlugin` instance accepts one component activation. A second would install
   a second subscriber on the same process-wide event stream and double-count.
2. The plugin captures the client's running event loop at construction (or takes `loop=`).
   Relay fires callbacks on its own worker threads; every record crosses to the loop
   through `_bridge.py`, bounded by `max_pending_handoffs`, dropping with a warning on
   overflow rather than blocking Relay.
3. Shutdown order is stop producing → exit Relay's plugin context → `await drain()` →
   `await client.shutdown()`. `drain()` after `close()` raises rather than discarding
   handoffs. Only `deregister` belongs in `finally`.
4. Attribution comes from the **root** scope's `audr` metadata at scope start, then
   `attribution_defaults`. A scope whose observed ancestor was evicted or completed is
   skipped, never billed to defaults. Metadata on a completing scope is ignored.
5. The plugin reads no prompts, model responses, tool arguments or tool results. Warnings
   carry stable event IDs, field paths, counts and queue outcomes — never values.
6. `record_id` is minted by the SDK. Relay's scope UUID goes on `run.span_id` and the root
   scope UUID on `run.run_id`. `total_tokens`, raw payloads and cost are never copied;
   `input_tokens` excludes cache reads and writes.
7. `nemo-relay` is the `runtime` extra, imported at activation. Importing this package
   must not import Relay.
8. Every diagnostic has a stable `NeMoRelayDiagnosticCode` or `NeMoRelayRunErrorCode`;
   add a code rather than a free-text message.

## Toolchain

The shared toolchain is defined in the top-level
[`CONTRIBUTING.md`](../../../CONTRIBUTING.md#shared-python-toolchain). Specific to this
package:

- **Runtime deps:** `audr`, `pydantic`. **Extras:** `runtime` (`nemo-relay>=0.8,<0.9`),
  `example` (the runtime plus `httpx`, for `examples/`).
- **Version:** `src/audr_adapter_nemo_relay/_version.py`.
- **Tests:** `pyproject.toml` sets `addopts = "-m 'not nemo_relay'"`, so `make test`
  deselects every test that needs the installed runtime. To run them:

  ```bash
  uv sync --locked --group dev --extra runtime
  uv run pytest -m nemo_relay
  ```

`make verify` is `lint test build`. This package has no `isolation` target; its
dependency on `audr` is intended.

## What not to do

- Do not construct a `Client` or a `Sink` inside this package.
- Do not fall back to `attribution_defaults` for a scope whose parent was observed and
  then lost; that could bill the wrong subscription.
- Do not log, raise or `repr()` anything containing scope metadata values, prompts or
  responses.
- Do not import `nemo_relay` at module import time.
