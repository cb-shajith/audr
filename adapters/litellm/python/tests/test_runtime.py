"""No-network tests against the supported LiteLLM runtime."""

from __future__ import annotations

import asyncio
from typing import Any

import litellm
from audr import Attribution, Client
from audr.testing import MemorySink
from litellm.router import Router

from audr_adapter_litellm import LiteLLMAudrCallback, LiteLLMConfig

_MESSAGES: Any = [{"role": "user", "content": "This request is served by LiteLLM's mock."}]


async def _wait_for_submission(client: Client, *, expected: int) -> None:
    loop = asyncio.get_running_loop()
    deadline = loop.time() + 5
    while client.stats.submitted < expected and loop.time() < deadline:
        await asyncio.sleep(0.01)
    assert client.stats.submitted == expected


async def test_sdk_streaming_sync_and_router_fallback_runtime() -> None:
    """Exercise all supported LiteLLM paths with one process-wide callback."""
    sink = MemorySink()
    old_callbacks = [
        callback for callback in litellm.callbacks if not isinstance(callback, LiteLLMAudrCallback)
    ]
    router = Router(
        model_list=[
            {
                "model_name": "primary",
                "litellm_params": {
                    "model": "openai/primary-model",
                    "api_key": "test-key",
                },
            },
            {
                "model_name": "fallback",
                "litellm_params": {
                    "model": "openai/fallback-model",
                    "api_key": "test-key",
                },
            },
        ],
        fallbacks=[{"primary": ["fallback"]}],
        num_retries=0,
    )
    async with Client(sink, batch_max_size=1, linger_seconds=0.01) as client:
        callback = LiteLLMAudrCallback(
            client=client,
            config=LiteLLMConfig(
                attribution_defaults=Attribution(environment="test"),
            ),
        )
        litellm.callbacks = [*old_callbacks, callback]
        try:
            await litellm.acompletion(
                model="openai/test-model",
                messages=_MESSAGES,
                api_key="test-key",
                mock_response="mock response",
                metadata={
                    "audr": {
                        "run": {"run_id": "agent-run-123", "run_type": "agent_run"},
                        "resource": {"deployment": "test"},
                    }
                },
            )
            await _wait_for_submission(client, expected=1)

            await asyncio.to_thread(
                litellm.completion,
                model="openai/test-model",
                messages=_MESSAGES,
                api_key="test-key",
                mock_response="mock response",
            )
            await _wait_for_submission(client, expected=2)

            stream = await litellm.acompletion(
                model="openai/test-model",
                messages=_MESSAGES,
                api_key="test-key",
                stream=True,
                mock_response="streamed mock response",
            )
            chunks = [chunk async for chunk in stream]
            await _wait_for_submission(client, expected=3)

            fallback_result = await router.acompletion(
                model="primary",
                messages=_MESSAGES,
                mock_testing_fallbacks=True,
                mock_response="fallback response",
            )
            await _wait_for_submission(client, expected=4)

            # LiteLLM deliberately runs logging callbacks out of band. Let its
            # logging task finish before unregistering and closing the callback.
            await asyncio.sleep(0.25)
            await callback.drain(timeout=5)
            assert client.stats.submitted == 4
            await client.flush()
        finally:
            litellm.callbacks = old_callbacks
            callback.close()
            router.reset()  # type: ignore[no-untyped-call]
    assert chunks
    assert isinstance(fallback_result, litellm.ModelResponse)
    assert fallback_result.model == "fallback-model"
    assert len(sink.records) == 4
    assert sink.records[0].resource.provider == "openai"
    assert sink.records[0].usage.llm is not None
    assert sink.records[0].usage.llm.input_tokens == 10
    assert sink.records[0].usage.llm.output_tokens == 20
    assert sink.records[0].run.run_id == "agent-run-123"
    assert sink.records[-1].resource.name == "fallback-model"
    assert sink.records[-1].usage.llm is not None
