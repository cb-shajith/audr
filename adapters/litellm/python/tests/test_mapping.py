"""LiteLLM callback normalization tests."""

from __future__ import annotations

import pytest
from audr import Attribution
from litellm.types.llms.openai import (
    InputTokensDetails,
    OutputTokensDetails,
    ResponseAPIUsage,
    ResponsesAPIResponse,
)
from litellm.types.rerank import RerankResponse

from audr_adapter_litellm import LiteLLMRunErrorCode
from audr_adapter_litellm._mapping import (
    RecordMalformed,
    RecordReady,
    RecordSkipped,
    map_callback,
)
from tests.helpers import CALL_ID, END, START, callback_kwargs, map_result, response


def _ready(result: object) -> RecordReady:
    assert isinstance(result, RecordReady)
    assert result.record.validate() == []
    return result


def test_maps_generation_usage_and_provider_echoed_model() -> None:
    record = _ready(map_result()).record

    assert record.emitter is not None
    assert record.emitter.component == "router"
    assert record.emitter.name == "litellm"
    assert record.resource.provider == "openai"
    assert record.resource.name == "gpt-5.6-luna-2026-09-01"
    assert record.resource.operation == "generation"
    assert record.resource.modality == "text"
    assert record.usage.llm is not None
    assert record.usage.llm.input_tokens == 120
    assert record.usage.llm.output_tokens == 40
    assert record.usage.llm.requests == 1
    assert record.run.span_id == CALL_ID
    assert record.timing.duration_ms == 125
    assert record.attribution.environment == "test"


def test_cache_and_reasoning_are_excluded_from_base_totals() -> None:
    result = map_result(
        response_obj=response(
            usage={
                "prompt_tokens": 120,
                "completion_tokens": 40,
                "prompt_tokens_details": {
                    "cached_tokens": 25,
                    "cache_creation_tokens": 5,
                },
                "completion_tokens_details": {"reasoning_tokens": 10},
            }
        )
    )
    usage = _ready(result).record.usage.llm

    assert usage is not None
    assert usage.input_tokens == 90
    assert usage.output_tokens == 30
    assert usage.cache_read_tokens == 25
    assert usage.cache_write_tokens == 5
    assert usage.reasoning_tokens == 10


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
    usage = _ready(result).record.usage.llm

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
        kwargs=callback_kwargs(call_type="arerank"),
        response_obj=rerank_response,
    )
    usage = _ready(result).record.usage.llm

    assert usage is not None
    assert usage.input_tokens == 42
    assert usage.output_tokens == 3
    assert usage.model_extra == {"x_search_units": 2}
    assert usage.requests == 1


def test_rerank_billed_total_falls_back_to_input_tokens() -> None:
    rerank_response = RerankResponse(
        id="rerank_123",
        results=[],
        meta={"billed_units": {"total_tokens": 45, "search_units": 1}},
    )
    result = map_result(
        kwargs=callback_kwargs(call_type="rerank"),
        response_obj=rerank_response,
    )
    usage = _ready(result).record.usage.llm

    assert usage is not None
    assert usage.input_tokens == 45
    assert usage.output_tokens is None
    assert usage.model_extra == {"x_search_units": 1}


@pytest.mark.parametrize(
    ("call_type", "operation"),
    [
        ("completion", "generation"),
        ("aresponses", "generation"),
        ("embedding", "embedding"),
        ("aembedding", "embedding"),
        ("rerank", "reranking"),
        ("arerank", "reranking"),
    ],
)
def test_supported_call_types(call_type: str, operation: str) -> None:
    record = _ready(map_result(kwargs=callback_kwargs(call_type=call_type))).record

    assert record.resource.operation == operation


def test_cost_is_encoded_as_an_informational_usd_assertion() -> None:
    record = _ready(map_result(kwargs=callback_kwargs(response_cost=0.0125))).record

    assert record.cost is not None
    assert record.cost.total_cost == 0.0125
    assert record.cost.currency == "USD"
    assert record.cost.llm is not None
    assert record.cost.llm.total_token_cost == 0.0125


def test_cost_alone_is_sufficient_metering_evidence() -> None:
    record = _ready(
        map_result(
            kwargs=callback_kwargs(response_cost=0.25),
            response_obj={"model": "model", "usage": None},
        )
    ).record

    assert record.usage.llm is not None
    assert record.usage.llm.requests == 1
    assert record.usage.llm.input_tokens is None


def test_unmetered_failure_is_skipped() -> None:
    result = map_result(
        kwargs=callback_kwargs(exception=TimeoutError("private message")),
        response_obj={"model": "model"},
        failed=True,
    )

    assert result == RecordSkipped("/usage")


def test_litellm_cache_hit_is_not_billed_as_a_provider_call() -> None:
    result = map_result(
        kwargs=callback_kwargs(cache_hit=True, response_cost=0.0),
    )

    assert result == RecordSkipped("/cache_hit")


def test_metered_failure_gets_a_stable_error_code() -> None:
    result = map_result(
        kwargs=callback_kwargs(exception=TimeoutError("private message")),
        failed=True,
    )
    record = _ready(result).record

    assert record.run.error_code == LiteLLMRunErrorCode.TIMEOUT
    assert record.run.error_reason is None


def test_request_metadata_overrides_attribution_and_run_fields() -> None:
    kwargs = callback_kwargs(
        litellm_params={
            "metadata": {
                "audr": {
                    "attribution": {
                        "environment": "production",
                        "account_id": "account_123",
                        "subscription_id": "subscription_123",
                        "labels": {"region": "us"},
                    },
                    "run": {
                        "run_id": "agent-run-123",
                        "span_id": "model-call-7",
                        "parent_span_id": "agent-step-2",
                        "step": 7,
                        "run_type": "agent_run",
                    },
                    "resource": {
                        "modality": "multimodal",
                        "region": "us-east-1",
                        "deployment": "AWS",
                    },
                }
            }
        }
    )
    record = _ready(
        map_result(
            kwargs=kwargs,
            defaults=Attribution(environment="staging", user_id="user_123"),
        )
    ).record

    assert record.attribution.environment == "production"
    assert record.attribution.account_id == "account_123"
    assert record.attribution.user_id == "user_123"
    assert record.attribution.labels == {"region": "us"}
    assert record.run.run_id == "agent-run-123"
    assert record.run.span_id == "model-call-7"
    assert record.run.parent_span_id == "agent-step-2"
    assert record.run.step == 7
    assert record.run.run_type == "agent_run"
    assert record.resource.modality == "multimodal"
    assert record.resource.region == "us-east-1"
    assert record.resource.deployment == "AWS"


def test_incomplete_attribution_is_skipped() -> None:
    result = map_result(defaults=Attribution())

    assert result == RecordSkipped("/attribution/environment")


def test_production_without_account_is_skipped() -> None:
    result = map_result(defaults=Attribution(environment="production"))

    assert result == RecordSkipped("/attribution/account_id")


def test_invalid_or_unknown_metadata_is_value_free() -> None:
    result = map_result(
        kwargs=callback_kwargs(
            litellm_params={"metadata": {"audr": {"private@example.com": "must not be reported"}}}
        )
    )

    assert result == RecordMalformed("/litellm_params/metadata/audr")
    assert "private@example.com" not in result.path


@pytest.mark.parametrize(
    "usage",
    [
        {"prompt_tokens": -1},
        {"completion_tokens": 1.5},
        {"prompt_tokens": True},
        {"prompt_tokens_details": {"cached_tokens": "secret"}},
    ],
)
def test_invalid_counters_are_malformed_without_values(usage: object) -> None:
    result = map_result(response_obj=response(usage=usage))

    assert isinstance(result, RecordMalformed)
    assert "secret" not in result.path


def test_unknown_call_type_is_not_misclassified() -> None:
    assert map_result(kwargs=callback_kwargs(call_type="image_generation")) == RecordSkipped(
        "/call_type"
    )


def test_provider_is_normalized_to_the_audr_alphabet() -> None:
    record = _ready(
        map_result(kwargs=callback_kwargs(custom_llm_provider="Vertex_AI/Gemini"))
    ).record

    assert record.resource.provider == "vertex-ai-gemini"


def test_content_fields_are_never_copied_to_the_record() -> None:
    secret = "private-prompt-and-response"
    kwargs = callback_kwargs(messages=[{"role": "user", "content": secret}])
    result = map_result(
        kwargs=kwargs,
        response_obj=response(choices=[{"message": {"content": secret}}]),
    )

    assert secret not in _ready(result).record.to_json()


def test_numeric_and_naive_timestamps_are_accepted_and_normalized() -> None:
    local_naive_end = END.astimezone().replace(tzinfo=None)
    result = map_callback(
        kwargs=callback_kwargs(),
        response=response(),
        start_time=START.timestamp(),
        end_time=local_naive_end,
        attribution_defaults=Attribution(environment="test"),
        failed=False,
    )
    timing = _ready(result).record.timing

    assert timing.event_time == END
    assert timing.duration_ms == 125


def test_invalid_timing_or_cost_is_reported_by_path() -> None:
    timing = map_callback(
        kwargs=callback_kwargs(),
        response=response(),
        start_time=START,
        end_time="not-a-time",
        attribution_defaults=Attribution(environment="test"),
        failed=False,
    )
    cost = map_result(kwargs=callback_kwargs(response_cost=float("nan")))

    assert timing == RecordMalformed("/timing")
    assert cost == RecordMalformed("/response_cost")
    assert END > START
