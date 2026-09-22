"""Record one real LiteLLM completion to a local AUDR JSONL file."""

from __future__ import annotations

import asyncio
import os

import litellm
from audr import Attribution, Client, FileSink

from audr_adapter_litellm import LiteLLMAudrCallback, LiteLLMConfig


async def _wait_for_callback(client: Client, submitted_before: int) -> None:
    """Wait for LiteLLM's non-blocking logging task to invoke the callback."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + 5
    while client.stats.submitted == submitted_before and loop.time() < deadline:
        await asyncio.sleep(0.01)
    if client.stats.submitted == submitted_before:
        raise TimeoutError("LiteLLM did not publish usage to the AUDR callback")


async def main() -> None:
    model = os.getenv("LITELLM_MODEL", "openai/gpt-4o-mini")
    sink = FileSink("litellm-usage.jsonl")
    old_callbacks = list(litellm.callbacks)

    async with Client(sink) as client:
        callback = LiteLLMAudrCallback(
            client=client,
            config=LiteLLMConfig(
                attribution_defaults=Attribution(
                    environment="production",
                    account_id="account_123",
                )
            ),
        )
        litellm.callbacks = [*old_callbacks, callback]
        try:
            submitted_before = client.stats.submitted
            response = await litellm.acompletion(
                model=model,
                messages=[{"role": "user", "content": "Reply with one short greeting."}],
                metadata={
                    "audr": {
                        "attribution": {"subscription_id": "subscription_123"},
                        "run": {
                            "run_id": "example-agent-run",
                            "run_type": "agent_run",
                        },
                    }
                },
            )
            await _wait_for_callback(client, submitted_before)
            print(response.choices[0].message.content)
        finally:
            litellm.callbacks = old_callbacks
            await callback.drain(timeout=5)
            callback.close()


if __name__ == "__main__":
    asyncio.run(main())
