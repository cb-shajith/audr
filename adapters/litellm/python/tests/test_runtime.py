"""No-network tests against the supported LiteLLM runtime."""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

pytest.importorskip("litellm")

import litellm
from audr import Attribution, Client
from audr.testing import MemorySink
from litellm.router import Router
from litellm.types.llms.openai import (
    InputTokensDetails,
    OutputTokensDetails,
    ResponseAPIUsage,
    ResponsesAPIResponse,
)
from litellm.types.rerank import RerankResponse

from audr_adapter_litellm import LiteLLMAudrCallback, LiteLLMConfig
from tests.helpers import callback_kwargs, map_result, ready

pytestmark = pytest.mark.litellm

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
        litellm.logging_callback_manager.add_litellm_callback(callback)
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
            litellm.logging_callback_manager.remove_callback_from_all_lists(callback)
            callback.close()
            router.reset()  # type: ignore[no-untyped-call]
    assert callback not in litellm.logging_callback_manager._get_all_callbacks()
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


def test_maps_real_responses_api_usage_shape() -> None:
    responses_api_response = ResponsesAPIResponse(
        id="resp_123",
        created_at=1,
        model="gpt-5.6-luna-2026-09-01",
        object="response",
        output=[],
        usage=ResponseAPIUsage(
            input_tokens=100,
            input_tokens_details=InputTokensDetails(cached_tokens=20),
            output_tokens=30,
            output_tokens_details=OutputTokensDetails(reasoning_tokens=5),
            total_tokens=130,
        ),
    )
    result = map_result(
        kwargs=callback_kwargs(call_type="aresponses"),
        response_obj=responses_api_response,
    )
    usage = ready(result).record.usage.llm

    assert usage is not None
    assert usage.input_tokens == 80
    assert usage.output_tokens == 25
    assert usage.cache_read_tokens == 20
    assert usage.reasoning_tokens == 5
    assert usage.requests == 1


def test_maps_real_rerank_tokens_and_billed_search_units() -> None:
    rerank_response = RerankResponse(
        id="rerank_123",
        results=[],
        meta={
            "tokens": {"input_tokens": 42, "output_tokens": 3},
            "billed_units": {"total_tokens": 45, "search_units": 2},
        },
    )
    result = map_result(
        kwargs=callback_kwargs(call_type="arerank", custom_llm_provider="cohere"),
        response_obj=rerank_response,
    )
    usage = ready(result).record.usage.llm

    assert usage is not None
    assert usage.input_tokens == 42
    assert usage.output_tokens == 3
    assert usage.model_extra == {"x_cohere_search_units": 2}
    assert usage.requests == 1


def test_rerank_billed_total_falls_back_to_input_tokens() -> None:
    rerank_response = RerankResponse(
        id="rerank_123",
        results=[],
        meta={"billed_units": {"total_tokens": 45, "search_units": 1}},
    )
    result = map_result(
        kwargs=callback_kwargs(call_type="rerank", custom_llm_provider="azure_ai"),
        response_obj=rerank_response,
    )
    usage = ready(result).record.usage.llm

    assert usage is not None
    assert usage.input_tokens == 45
    assert usage.output_tokens is None
    assert usage.model_extra == {"x_azure_ai_search_units": 1}
