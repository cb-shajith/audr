"""Record the metered result of a LiteLLM Router fallback chain."""

from __future__ import annotations

import asyncio
import os

import litellm
from audr import Attribution, Client, FileSink
from litellm.router import Router

from audr_adapter_litellm import LiteLLMAudrCallback, LiteLLMConfig


async def _wait_for_callback(client: Client, submitted_before: int) -> None:
    loop = asyncio.get_running_loop()
    deadline = loop.time() + 5
    while client.stats.submitted == submitted_before and loop.time() < deadline:
        await asyncio.sleep(0.01)
    if client.stats.submitted == submitted_before:
        raise TimeoutError("LiteLLM did not publish usage to the AUDR callback")


async def main() -> None:
    primary_model = os.getenv("PRIMARY_MODEL", "openai/gpt-4o-mini")
    fallback_model = os.getenv(
        "FALLBACK_MODEL",
        "anthropic/claude-3-5-haiku-20241022",
    )
    router = Router(
        model_list=[
            {"model_name": "primary", "litellm_params": {"model": primary_model}},
            {"model_name": "fallback", "litellm_params": {"model": fallback_model}},
        ],
        fallbacks=[{"primary": ["fallback"]}],
        num_retries=0,
    )
    old_callbacks = list(litellm.callbacks)

    async with Client(FileSink("router-usage.jsonl")) as client:
        callback = LiteLLMAudrCallback(
            client=client,
            config=LiteLLMConfig(
                attribution_defaults=Attribution(
                    environment="production",
                    account_id="account_123",
                    subscription_id="subscription_123",
                )
            ),
        )
        litellm.callbacks = [*old_callbacks, callback]
        try:
            submitted_before = client.stats.submitted
            response = await router.acompletion(
                model="primary",
                messages=[{"role": "user", "content": "Summarize AUDR in one sentence."}],
                metadata={
                    "audr": {
                        "run": {
                            "run_id": "router-example-run",
                            "run_type": "agent_run",
                        }
                    }
                },
            )
            await _wait_for_callback(client, submitted_before)
            print(response.choices[0].message.content)
        finally:
            litellm.callbacks = old_callbacks
            await callback.drain(timeout=5)
            callback.close()
            router.reset()  # type: ignore[no-untyped-call]


if __name__ == "__main__":
    asyncio.run(main())
