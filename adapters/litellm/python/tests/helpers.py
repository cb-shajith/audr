"""Shared callback fixtures."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

from audr import Attribution

from audr_adapter_litellm._mapping import MappingResult, map_callback

START = datetime(2026, 9, 21, 12, 0, tzinfo=UTC)
END = START + timedelta(milliseconds=125)
CALL_ID = "0199f123-0000-7000-8000-000000000012"


def callback_kwargs(**overrides: Any) -> dict[str, Any]:
    values: dict[str, Any] = {
        "call_type": "acompletion",
        "model": "openai/gpt-5.6-luna",
        "custom_llm_provider": "openai",
        "litellm_call_id": CALL_ID,
        "litellm_trace_id": "0199f123-0000-7000-8000-000000000011",
        "litellm_params": {"metadata": {}},
    }
    values.update(overrides)
    return values


def response(**overrides: Any) -> dict[str, Any]:
    values: dict[str, Any] = {
        "model": "gpt-5.6-luna-2026-09-01",
        "usage": {
            "prompt_tokens": 120,
            "completion_tokens": 40,
            "total_tokens": 160,
        },
    }
    values.update(overrides)
    return values


def map_result(
    *,
    kwargs: object | None = None,
    response_obj: object | None = None,
    defaults: Attribution | None = None,
    failed: bool = False,
) -> MappingResult:
    return map_callback(
        kwargs=callback_kwargs() if kwargs is None else kwargs,
        response=response() if response_obj is None else response_obj,
        start_time=START,
        end_time=END,
        attribution_defaults=defaults or Attribution(environment="test"),
        failed=failed,
    )
