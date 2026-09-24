# LiteLLM adapter for AUDR

[![PyPI](https://img.shields.io/pypi/v/audr-adapter-litellm?include_prereleases)](https://pypi.org/project/audr-adapter-litellm/)

> **Status: experimental.** Public names may change in minor releases until this
> adapter graduates.

`audr-adapter-litellm` turns provider-reported LiteLLM model usage into AUDR
records and submits them through an existing `audr.Client`. The host application
owns the client, sink, callback registration, and shutdown sequence.

The first release supports the LiteLLM Python SDK and `Router` on
`litellm>=1.95,<2`. LiteLLM Proxy deployment is not yet supported because
the Proxy does not expose a documented callback-shutdown hook with which this
adapter can guarantee that its AUDR client has drained.

## Install

```bash
pip install "audr-adapter-litellm[runtime]"
```

## Quick start

Construct the callback on the running event loop that owns the AUDR client,
register it through LiteLLM's callback manager without replacing other
callbacks, and leave it registered while requests are in flight:

```python
import asyncio

import litellm
from audr import Attribution, Client, FileSink
from audr_adapter_litellm import LiteLLMAudrCallback, LiteLLMConfig


async def wait_for_callback(client: Client, submitted_before: int) -> None:
    loop = asyncio.get_running_loop()
    deadline = loop.time() + 5
    while client.stats.submitted == submitted_before and loop.time() < deadline:
        await asyncio.sleep(0.01)
    if client.stats.submitted == submitted_before:
        raise TimeoutError("LiteLLM did not publish usage to the AUDR callback")


async def main() -> None:
    async with Client(FileSink("usage.jsonl")) as client:
        callback = LiteLLMAudrCallback(
            client=client,
            config=LiteLLMConfig(
                attribution_defaults=Attribution(
                    environment="production",
                    account_id="account_123",
                )
            ),
        )
        litellm.logging_callback_manager.add_litellm_callback(callback)
        try:
            submitted_before = client.stats.submitted
            await litellm.acompletion(
                model="openai/gpt-4o-mini",
                messages=[{"role": "user", "content": "Hello"}],
                metadata={
                    "audr": {
                        "attribution": {"subscription_id": "subscription_123"},
                        "run": {
                            "run_id": "agent-run-123",
                            "run_type": "agent_run",
                        },
                    }
                },
            )
            await wait_for_callback(client, submitted_before)
        finally:
            litellm.logging_callback_manager.remove_callback_from_all_lists(callback)
            await callback.drain(timeout=5)
            callback.close()


asyncio.run(main())
```

The quick start and runnable
[`examples/litellm_completion.py`](https://github.com/openaudr/audr/blob/main/adapters/litellm/python/examples/litellm_completion.py)
wait on the public `client.stats` counter instead of using a fixed delay. The
runnable example makes a billable network request and writes
`litellm-usage.jsonl`.

## What gets recorded

The adapter emits only when LiteLLM exposes provider usage or cost. It does not
invent zero-token usage for connection failures, rate limits, timeouts, or
other attempts that have no metering evidence.

- LiteLLM cache hits are skipped because no provider model call occurred.
- `completion`, `text_completion`, and Responses API calls map to
  `resource.operation="generation"`.
- Embedding calls map to `resource.operation="embedding"`.
- Reranking calls map to `resource.operation="reranking"`.
- The provider-echoed response model wins over the requested LiteLLM alias.
- Chat and Responses API totals are split into uncached input, cache-read, and
  cache-write counters. Reasoning tokens are removed from ordinary output
  tokens.
- Rerank `meta.tokens` maps to input and output tokens. When only
  `meta.billed_units.total_tokens` is available it becomes input usage, and
  billed search units are preserved as `usage.llm.x_<provider>_search_units`,
  for example `usage.llm.x_cohere_search_units`.
- LiteLLM `response_cost`, when present, becomes `cost.total_cost` in USD. It is
  a net amount that can include built-in tool fees, LiteLLM discounts and
  margins, so the adapter does not report it as `cost.llm.total_token_cost`.
- A successful metered call carries `usage.llm.requests=1`.

Failures are skipped unless their callback itself contains explicit usage or a
positive cost. LiteLLM sets `response_cost` to zero on failures, so a zero cost
is not treated as metering evidence. A metered failure receives a stable `LiteLLMRunErrorCode`; raw exception
messages are never copied.

LiteLLM can return model-requested tool calls, but it does not execute the
application's tools. This adapter therefore records the model generation, not
a separate AUDR tool execution. Instrument the component that actually runs
the tool if tool usage also needs billing.

## Router retries and fallbacks

The standard LiteLLM request callback fires for the logical request result. If
a `Router` attempt fails without usage and a fallback succeeds with usage, the
adapter emits one record for the successful fallback. It does not bill the
unmetered failed attempt.

The runnable
[`examples/router_fallback.py`](https://github.com/openaudr/audr/blob/main/adapters/litellm/python/examples/router_fallback.py)
shows a primary and fallback model group. Set `PRIMARY_MODEL` and
`FALLBACK_MODEL`, plus the provider API keys LiteLLM expects.

## Attribution and run metadata

Static defaults are merged with request-specific values under the reserved
`metadata["audr"]` namespace:

```python
metadata = {
    "audr": {
        "attribution": {
            "environment": "production",
            "account_id": "account_123",
            "subscription_id": "subscription_123",
            "user_id": "pseudonymous_user_123",
            "labels": {"region": "us", "feature": "support-agent"},
        },
        "run": {
            "run_id": "agent-run-123",
            "span_id": "model-call-7",
            "parent_span_id": "agent-step-2",
            "step": 7,
            "trace_id": "0123456789abcdef0123456789abcdef",
            "run_type": "agent_run",
        },
        "resource": {
            "modality": "text",
            "key_name": "production-shared",
            "region": "us-east-1",
            "deployment": "AWS",
        },
    }
}
```

Every sub-object rejects unknown fields. Request attribution overrides defaults
field by field. `environment` must resolve for every record, and production
records must resolve `account_id`. Missing billability data causes the callback
to skip the record rather than guess.

When no run metadata is supplied, the LiteLLM trace or call ID becomes
`run.run_id`, the call ID becomes `run.span_id`, and the run type is
`single_call`. Supplying the agent's run ID is recommended so model calls from
the same agent execution join downstream.

Do not put credentials or personal data in AUDR metadata. `user_id` must be a
pseudonymous identifier, never an email address or name.

## Streaming and synchronous calls

A stream is emitted only after it has been fully consumed and LiteLLM has
assembled final usage. Abandoned streams without final usage are skipped.

LiteLLM may invoke synchronous callbacks from a worker thread. The adapter uses
a bounded, non-blocking bridge back to the event loop that owns `Client`.
Construct it inside an async application and run synchronous `completion()`
calls in a worker while that loop remains active. A purely synchronous process
with no running event loop is not supported by the AUDR client's async delivery
lifecycle.

## Shutdown order

LiteLLM logging callbacks run out of band and LiteLLM 1.x has no documented
callback flush API. Shutdown must therefore happen after request tasks and
streams have finished:

1. Stop accepting new LiteLLM work.
2. Await all request tasks and fully consume active streams.
3. Allow the corresponding LiteLLM logging tasks to run. Applications that
   know how many metered calls they issued can observe `client.stats.submitted`;
   server processes normally use their graceful-shutdown window.
4. Unregister the callback with
   `litellm.logging_callback_manager.remove_callback_from_all_lists(callback)`.
   LiteLLM copies registered callbacks into its internal success and failure
   lists, so restoring `litellm.callbacks` alone leaves the callback active.
5. Await `callback.drain()` so accepted cross-thread handoffs reach
   `client.record()`.
6. Call `callback.close()`, then exit or shut down the client so its delivery
   queue and sink drain.

`drain(timeout=...)` raises `TimeoutError` if accepted handoffs cannot reach the
client in time. Calling it after `close()` raises `LiteLLMActivationError`
instead of silently losing records.

## Privacy and operational behavior

The mapper reads only documented identity, timing, provider, model, usage,
cost, and `metadata["audr"]` fields. It never reads or logs prompts, messages,
response content, tool arguments, API keys, raw exceptions, or arbitrary
metadata. Warnings contain only stable field paths and queue outcomes.

`max_pending_handoffs` bounds records waiting to enter the client loop
(1–100000, default 1000). Overflow is non-blocking and produces a warning.
Delivery status and failures remain owned by the client and sink; inspect
`client.stats` and configure the client's delivery callbacks as needed.

## Development

```bash
make install    # uv sync --locked --group dev
make lint       # Ruff formatting/lint and strict mypy
make test       # unit and no-network LiteLLM runtime tests, coverage >= 90%
make isolation  # build and install the wheel with the sibling core wheel
make verify     # all package gates
```

The runtime test uses LiteLLM's documented mock completion and Router fallback
facilities; it sends no provider network traffic.

Licensed under Apache-2.0.
