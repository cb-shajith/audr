"""Privacy-preserving mapping from LiteLLM callback data to AUDR."""

from __future__ import annotations

import math
import re
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import Enum
from importlib.metadata import PackageNotFoundError, version
from typing import TypeAlias

from audr import (
    AUDR,
    Attribution,
    Cost,
    Emitter,
    LlmCost,
    LlmUsage,
    Modality,
    Operation,
    Resource,
    Run,
    RunType,
    Timing,
    Usage,
)
from audr.ids import uuid7
from pydantic import BaseModel, ConfigDict, ValidationError

from audr_adapter_litellm._errors import LiteLLMRunErrorCode

_PROVIDER_DISALLOWED = re.compile(r"[^a-z0-9-]+")
_GENERATION_CALLS = frozenset(
    {
        "acompletion",
        "aresponses",
        "atext_completion",
        "completion",
        "responses",
        "text_completion",
    }
)
_EMBEDDING_CALLS = frozenset({"aembedding", "embedding", "embeddings"})
_RERANK_CALLS = frozenset({"arerank", "rerank"})
_ATTRIBUTION_FIELDS = frozenset(Attribution.model_fields)
_MISSING = object()


class _RunMetadata(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    run_id: str | None = None
    span_id: str | None = None
    parent_span_id: str | None = None
    step: int | None = None
    trace_id: str | None = None
    run_type: RunType | None = None


class _ResourceMetadata(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    modality: Modality = "text"
    key_name: str | None = None
    region: str | None = None
    deployment: str | None = None


class _AudrMetadata(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    attribution: Attribution | None = None
    run: _RunMetadata = _RunMetadata()
    resource: _ResourceMetadata = _ResourceMetadata()


@dataclass(frozen=True, slots=True)
class RecordReady:
    """A callback carried enough metering data to emit a record."""

    record: AUDR


@dataclass(frozen=True, slots=True)
class RecordSkipped:
    """A callback was valid but had no billable AUDR representation."""

    path: str


@dataclass(frozen=True, slots=True)
class RecordMalformed:
    """A documented callback field had an invalid shape."""

    path: str


MappingResult: TypeAlias = RecordReady | RecordSkipped | RecordMalformed


def map_callback(
    *,
    kwargs: object,
    response: object,
    start_time: object,
    end_time: object,
    attribution_defaults: Attribution,
    failed: bool,
) -> MappingResult:
    """Map one request-level LiteLLM callback without reading request content."""
    if not isinstance(kwargs, Mapping):
        return RecordMalformed("/")
    if kwargs.get("cache_hit") is True:
        return RecordSkipped("/cache_hit")

    metadata_result = _parse_metadata(kwargs)
    if isinstance(metadata_result, RecordMalformed):
        return metadata_result
    metadata = metadata_result

    attribution_result = _resolve_attribution(
        defaults=attribution_defaults,
        overrides=metadata.attribution,
    )
    if isinstance(attribution_result, RecordSkipped):
        return attribution_result
    attribution = attribution_result

    operation = _operation_from(kwargs.get("call_type"))
    if operation is None:
        return RecordSkipped("/call_type")

    usage_result = _usage_from(response, operation)
    if isinstance(usage_result, RecordMalformed):
        return usage_result
    cost_result = _cost_from(kwargs, response)
    if isinstance(cost_result, RecordMalformed):
        return cost_result
    cost, cost_present = cost_result
    if usage_result is None and not cost_present:
        return RecordSkipped("/usage")

    provider = _provider_from(kwargs)
    if provider is None:
        return RecordSkipped("/custom_llm_provider")
    model = _model_from(kwargs, response)
    if model is None:
        return RecordSkipped("/model")

    timing = _timing_from(start_time, end_time)
    if timing is None:
        return RecordMalformed("/timing")

    usage = usage_result or LlmUsage(requests=1)
    run = _run_from(kwargs, metadata.run, failed=failed)
    resource_metadata = metadata.resource
    record = AUDR(
        emitter=Emitter(
            component="router",
            name="litellm",
            version=_litellm_version(),
        ),
        timing=timing,
        resource=Resource(
            provider=provider,
            type="model",
            name=model,
            operation=operation,
            modality=resource_metadata.modality,
            key_name=resource_metadata.key_name,
            region=resource_metadata.region,
            deployment=resource_metadata.deployment,
        ),
        usage=Usage(llm=usage),
        run=run,
        attribution=attribution,
        cost=cost,
    )
    issues = record.validate()
    if issues:
        return RecordMalformed(issues[0].path)
    return RecordReady(record)


def _parse_metadata(kwargs: Mapping[object, object]) -> _AudrMetadata | RecordMalformed:
    litellm_params = kwargs.get("litellm_params")
    if litellm_params is None:
        return _AudrMetadata()
    if not isinstance(litellm_params, Mapping):
        return RecordMalformed("/litellm_params")
    metadata = litellm_params.get("metadata")
    if metadata is None:
        return _AudrMetadata()
    if not isinstance(metadata, Mapping):
        return RecordMalformed("/litellm_params/metadata")
    namespace = metadata.get("audr")
    if namespace is None:
        return _AudrMetadata()
    if not isinstance(namespace, Mapping):
        return RecordMalformed("/litellm_params/metadata/audr")
    try:
        return _AudrMetadata.model_validate(dict(namespace))
    except ValidationError:
        return RecordMalformed("/litellm_params/metadata/audr")


def _resolve_attribution(
    *,
    defaults: Attribution,
    overrides: Attribution | None,
) -> Attribution | RecordSkipped:
    values: dict[str, object] = {
        name: getattr(defaults, name)
        for name in _ATTRIBUTION_FIELDS
        if getattr(defaults, name) is not None
    }
    if overrides is not None:
        for name in overrides.model_fields_set:
            values[name] = getattr(overrides, name)
    try:
        attribution = Attribution.model_validate(values)
    except ValidationError:
        return RecordSkipped("/attribution")
    issues = attribution.validate()
    if issues:
        return RecordSkipped(issues[0].path)
    return attribution


def _operation_from(value: object) -> Operation | None:
    if isinstance(value, Enum):
        value = value.value
    if not isinstance(value, str):
        return None
    normalized = value.lower()
    if normalized in _GENERATION_CALLS:
        return "generation"
    if normalized in _EMBEDDING_CALLS:
        return "embedding"
    if normalized in _RERANK_CALLS:
        return "reranking"
    return None


def _usage_from(
    response: object,
    operation: Operation,
) -> LlmUsage | RecordMalformed | None:
    usage = _field(response, "usage")
    if usage is not _MISSING and usage is not None:
        return _standard_usage_from(usage)
    if operation == "reranking":
        return _rerank_usage_from(response)
    return None


def _standard_usage_from(usage: object) -> LlmUsage | RecordMalformed | None:
    input_total = _first_counter(
        (
            (usage, "prompt_tokens", "/usage/prompt_tokens"),
            (usage, "input_tokens", "/usage/input_tokens"),
        )
    )
    output_total = _first_counter(
        (
            (usage, "completion_tokens", "/usage/completion_tokens"),
            (usage, "output_tokens", "/usage/output_tokens"),
        )
    )
    total = _counter(usage, "total_tokens", "/usage/total_tokens")
    for value in (input_total, output_total, total):
        if isinstance(value, RecordMalformed):
            return value

    prompt_details = _field(usage, "prompt_tokens_details")
    input_details = _field(usage, "input_tokens_details")
    completion_details = _field(usage, "completion_tokens_details")
    output_details = _field(usage, "output_tokens_details")
    cache_read = _first_counter(
        (
            (usage, "cache_read_input_tokens", "/usage/cache_read_input_tokens"),
            (prompt_details, "cached_tokens", "/usage/prompt_tokens_details/cached_tokens"),
            (input_details, "cached_tokens", "/usage/input_tokens_details/cached_tokens"),
        )
    )
    cache_write = _first_counter(
        (
            (usage, "cache_creation_input_tokens", "/usage/cache_creation_input_tokens"),
            (
                prompt_details,
                "cache_creation_tokens",
                "/usage/prompt_tokens_details/cache_creation_tokens",
            ),
            (
                input_details,
                "cache_creation_tokens",
                "/usage/input_tokens_details/cache_creation_tokens",
            ),
        )
    )
    reasoning = _first_counter(
        (
            (
                completion_details,
                "reasoning_tokens",
                "/usage/completion_tokens_details/reasoning_tokens",
            ),
            (
                output_details,
                "reasoning_tokens",
                "/usage/output_tokens_details/reasoning_tokens",
            ),
            (usage, "reasoning_tokens", "/usage/reasoning_tokens"),
        )
    )
    for value in (cache_read, cache_write, reasoning):
        if isinstance(value, RecordMalformed):
            return value

    input_total_count = _counter_value(input_total)
    output_total_count = _counter_value(output_total)
    cache_read_count = _counter_value(cache_read)
    cache_write_count = _counter_value(cache_write)
    reasoning_count = _counter_value(reasoning)
    evidence = any(
        _counter_present(value)
        for value in (input_total, output_total, total, cache_read, cache_write, reasoning)
    )
    if not evidence:
        return None

    input_tokens = _exclusive(input_total_count, cache_read_count, cache_write_count)
    output_tokens = _exclusive(output_total_count, reasoning_count)
    return LlmUsage(
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        cache_read_tokens=cache_read_count,
        cache_write_tokens=cache_write_count,
        reasoning_tokens=reasoning_count,
        requests=1,
    )


def _rerank_usage_from(response: object) -> LlmUsage | RecordMalformed | None:
    meta = _field(response, "meta")
    if meta is _MISSING or meta is None:
        return None
    tokens = _field(meta, "tokens")
    billed_units = _field(meta, "billed_units")
    input_tokens = _counter(tokens, "input_tokens", "/meta/tokens/input_tokens")
    output_tokens = _counter(tokens, "output_tokens", "/meta/tokens/output_tokens")
    billed_total = _counter(
        billed_units,
        "total_tokens",
        "/meta/billed_units/total_tokens",
    )
    search_units = _counter(
        billed_units,
        "search_units",
        "/meta/billed_units/search_units",
    )
    for value in (input_tokens, output_tokens, billed_total, search_units):
        if isinstance(value, RecordMalformed):
            return value
    if not any(
        _counter_present(value)
        for value in (input_tokens, output_tokens, billed_total, search_units)
    ):
        return None

    input_count = _counter_value(input_tokens)
    output_count = _counter_value(output_tokens)
    if input_count is None:
        total_count = _counter_value(billed_total)
        if total_count is not None:
            input_count = max(0, total_count - (output_count or 0))
    values: dict[str, object] = {
        "input_tokens": input_count,
        "output_tokens": output_count,
        "requests": 1,
    }
    search_count = _counter_value(search_units)
    if search_count is not None:
        values["x_search_units"] = search_count
    return LlmUsage.model_validate(values)


def _cost_from(
    kwargs: Mapping[object, object],
    response: object,
) -> tuple[Cost | None, bool] | RecordMalformed:
    raw = kwargs.get("response_cost", _MISSING)
    if raw is _MISSING or raw is None:
        hidden = _field(response, "_hidden_params")
        raw = _field(hidden, "response_cost")
    if raw is _MISSING or raw is None:
        return None, False
    if isinstance(raw, bool) or not isinstance(raw, int | float):
        return RecordMalformed("/response_cost")
    amount = float(raw)
    if not math.isfinite(amount) or amount < 0:
        return RecordMalformed("/response_cost")
    return (
        Cost(
            total_cost=amount,
            currency="USD",
            llm=LlmCost(total_token_cost=amount),
        ),
        True,
    )


def _provider_from(kwargs: Mapping[object, object]) -> str | None:
    litellm_params = kwargs.get("litellm_params")
    candidates = [kwargs.get("custom_llm_provider")]
    if isinstance(litellm_params, Mapping):
        candidates.append(litellm_params.get("custom_llm_provider"))
    model = kwargs.get("model")
    if isinstance(model, str) and "/" in model:
        candidates.append(model.split("/", 1)[0])
    for candidate in candidates:
        if isinstance(candidate, str) and candidate:
            provider = _PROVIDER_DISALLOWED.sub("-", candidate.lower()).strip("-")
            if provider:
                return provider
    return None


def _model_from(kwargs: Mapping[object, object], response: object) -> str | None:
    candidates = [_field(response, "model")]
    litellm_params = kwargs.get("litellm_params")
    if isinstance(litellm_params, Mapping):
        candidates.append(litellm_params.get("model"))
    candidates.append(kwargs.get("model"))
    for candidate in candidates:
        if isinstance(candidate, str) and candidate:
            return candidate
    return None


def _timing_from(start_time: object, end_time: object) -> Timing | None:
    start = _datetime(start_time)
    end = _datetime(end_time)
    if start is None or end is None:
        return None
    duration_ms = max(0, int((end - start).total_seconds() * 1000))
    return Timing(
        event_time=end.replace(microsecond=(end.microsecond // 1000) * 1000),
        duration_ms=duration_ms,
    )


def _run_from(
    kwargs: Mapping[object, object],
    metadata: _RunMetadata,
    *,
    failed: bool,
) -> Run:
    call_id = _non_empty(kwargs.get("litellm_call_id"))
    trace_id = _non_empty(kwargs.get("litellm_trace_id"))
    run_id = metadata.run_id or trace_id or call_id or uuid7()
    span_id = metadata.span_id or call_id or uuid7()
    error_code = _error_code(kwargs.get("exception")) if failed else None
    return Run(
        run_id=run_id,
        span_id=span_id,
        parent_span_id=metadata.parent_span_id,
        step=metadata.step,
        trace_id=metadata.trace_id,
        run_type=metadata.run_type or "single_call",
        error_code=error_code,
    )


def _error_code(error: object) -> LiteLLMRunErrorCode:
    name = type(error).__name__.lower()
    status = getattr(error, "status_code", None)
    if "timeout" in name:
        return LiteLLMRunErrorCode.TIMEOUT
    if "ratelimit" in name or status == 429:
        return LiteLLMRunErrorCode.RATE_LIMIT
    if "authentication" in name or status in {401, 403}:
        return LiteLLMRunErrorCode.AUTHENTICATION
    if "contextwindow" in name:
        return LiteLLMRunErrorCode.CONTEXT_WINDOW
    if "contentpolicy" in name:
        return LiteLLMRunErrorCode.CONTENT_POLICY
    return LiteLLMRunErrorCode.PROVIDER_ERROR


def _field(value: object, name: str) -> object:
    if value is _MISSING or value is None:
        return _MISSING
    if isinstance(value, Mapping):
        return value.get(name, _MISSING)
    return getattr(value, name, _MISSING)


def _counter(
    value: object,
    name: str,
    path: str,
) -> tuple[bool, int | None] | RecordMalformed:
    raw = _field(value, name)
    if raw is _MISSING or raw is None:
        return False, None
    if isinstance(raw, bool) or not isinstance(raw, int) or raw < 0:
        return RecordMalformed(path)
    return True, raw


def _first_counter(
    candidates: tuple[tuple[object, str, str], ...],
) -> tuple[bool, int | None] | RecordMalformed:
    for value, name, path in candidates:
        result = _counter(value, name, path)
        if isinstance(result, RecordMalformed) or result[0]:
            return result
    return False, None


def _counter_present(value: tuple[bool, int | None] | RecordMalformed) -> bool:
    return not isinstance(value, RecordMalformed) and value[0]


def _counter_value(value: tuple[bool, int | None] | RecordMalformed) -> int | None:
    if isinstance(value, RecordMalformed):
        return None
    return value[1]


def _exclusive(total: int | None, *parts: int | None) -> int | None:
    if total is None:
        return None
    return max(0, total - sum(part or 0 for part in parts))


def _datetime(value: object) -> datetime | None:
    if isinstance(value, datetime):
        # LiteLLM currently supplies naive ``datetime.now()`` values. Python's
        # astimezone() correctly interprets those in the process-local timezone.
        return value.astimezone(UTC)
    if isinstance(value, int | float) and not isinstance(value, bool):
        try:
            return datetime.fromtimestamp(value, tz=UTC)
        except (OverflowError, OSError, ValueError):
            return None
    return None


def _non_empty(value: object) -> str | None:
    return value if isinstance(value, str) and value else None


def _litellm_version() -> str:
    try:
        return version("litellm")
    except PackageNotFoundError:
        return "unknown"


__all__ = [
    "MappingResult",
    "RecordMalformed",
    "RecordReady",
    "RecordSkipped",
    "map_callback",
]
