from datetime import UTC, datetime, timedelta

import pytest

from audr.errors import ValidationError, ValidationIssue
from audr.record import (
    AUDR,
    Attribution,
    Cost,
    LlmCost,
    LlmUsage,
    Resource,
    ToolCost,
    ToolUsage,
    Usage,
)
from audr.record.codes import ErrorCode
from tests.helpers import EMITTER, minimal


def codes(record: AUDR, *, now: datetime | None = None) -> list[tuple[ErrorCode, str]]:
    return [(i.code, i.path) for i in record.validate(now=now)]


def test_valid_record_has_no_issues() -> None:
    assert codes(minimal(emitter=EMITTER)) == []


def test_validate_never_raises_and_returns_every_issue() -> None:
    record = minimal(record_id="not-an-id-1", attribution=Attribution())
    issues = record.validate()
    assert isinstance(issues, list)
    assert {i.code for i in issues} == {
        ErrorCode.INVALID_IDENTIFIER,
        ErrorCode.REQUIRED,
    }
    assert len(issues) == 3


def test_missing_emitter() -> None:
    assert (ErrorCode.REQUIRED, "/emitter") in codes(minimal())


def test_bad_spec_version() -> None:
    record = minimal(emitter=EMITTER, spec_version="2.0.0")
    assert (ErrorCode.UNSUPPORTED_VERSION, "/spec_version") in codes(record)


def test_bad_record_id() -> None:
    record = minimal(emitter=EMITTER, record_id="not-an-id-1")
    assert (ErrorCode.INVALID_IDENTIFIER, "/record_id") in codes(record)


def test_bad_corrects() -> None:
    record = minimal(emitter=EMITTER, corrects="not-an-id-1")
    assert (ErrorCode.INVALID_IDENTIFIER, "/corrects") in codes(record)


def test_uuid7_record_id_is_accepted() -> None:
    record = minimal(emitter=EMITTER, record_id="01927f1c-2b3d-7abc-8def-0123456789ab")
    assert codes(record) == []


def test_millisecond_precision() -> None:
    timing = minimal().timing.model_copy(
        update={"event_time": datetime(2026, 1, 1, 0, 0, 0, 123456, tzinfo=UTC)}
    )
    record = minimal(emitter=EMITTER, timing=timing)
    assert (ErrorCode.MILLISECOND_PRECISION, "/timing/event_time") in codes(record)


def test_future_event_time() -> None:
    event_time = datetime.now(UTC).replace(microsecond=0) + timedelta(hours=1)
    timing = minimal().timing.model_copy(update={"event_time": event_time})
    record = minimal(emitter=EMITTER, timing=timing)
    assert (ErrorCode.FUTURE_EVENT_TIME, "/timing/event_time") in codes(record)


def test_small_clock_skew_is_tolerated() -> None:
    event_time = datetime.now(UTC).replace(microsecond=0) + timedelta(minutes=4)
    timing = minimal().timing.model_copy(update={"event_time": event_time})
    assert codes(minimal(emitter=EMITTER, timing=timing)) == []


def test_validate_accepts_an_explicit_now() -> None:
    event_time = datetime(2026, 1, 1, tzinfo=UTC)
    timing = minimal().timing.model_copy(update={"event_time": event_time})
    record = minimal(emitter=EMITTER, timing=timing)
    assert (ErrorCode.FUTURE_EVENT_TIME, "/timing/event_time") in codes(
        record, now=datetime(2025, 1, 1, tzinfo=UTC)
    )


def test_validate_normalises_a_naive_now() -> None:
    # A naive `now` is read as UTC rather than raising: `validate` never raises.
    event_time = datetime(2026, 1, 1, tzinfo=UTC)
    timing = minimal().timing.model_copy(update={"event_time": event_time})
    record = minimal(emitter=EMITTER, timing=timing)
    assert (ErrorCode.FUTURE_EVENT_TIME, "/timing/event_time") in codes(
        record, now=datetime(2025, 1, 1)
    )
    assert codes(record, now=datetime(2026, 6, 1)) == []


def test_received_time_forbidden() -> None:
    timing = minimal().timing.model_copy(update={"received_time": datetime(2026, 1, 1, tzinfo=UTC)})
    record = minimal(emitter=EMITTER, timing=timing)
    assert (ErrorCode.FORBIDDEN, "/timing/received_time") in codes(record)


def test_usage_both_blocks() -> None:
    usage = Usage(llm=LlmUsage(input_tokens=1), tool=ToolUsage(call_count=1))
    assert (ErrorCode.INVALID_STRUCTURE, "/usage") in codes(minimal(emitter=EMITTER, usage=usage))


def test_usage_no_blocks() -> None:
    assert (ErrorCode.INVALID_STRUCTURE, "/usage") in codes(minimal(emitter=EMITTER, usage=Usage()))


def test_empty_llm_block() -> None:
    usage = Usage(llm=LlmUsage())
    assert (ErrorCode.EMPTY_USAGE, "/usage/llm") in codes(minimal(emitter=EMITTER, usage=usage))


def test_llm_block_with_only_an_extension_is_not_empty() -> None:
    usage = Usage(llm=LlmUsage(x_acme_widgets=2))
    assert (ErrorCode.EMPTY_USAGE, "/usage/llm") not in codes(minimal(emitter=EMITTER, usage=usage))


def test_empty_tool_block() -> None:
    resource = Resource(provider="self-hosted", type="tool", name="t", operation="tool_execution")
    record = minimal(emitter=EMITTER, resource=resource, usage=Usage(tool=ToolUsage()))
    assert (ErrorCode.EMPTY_USAGE, "/usage/tool") in codes(record)


def test_model_op_with_tool_type() -> None:
    resource = Resource(
        provider="a", type="tool", name="m", operation="generation", modality="text"
    )
    record = minimal(emitter=EMITTER, resource=resource)
    assert (ErrorCode.INVALID_STRUCTURE, "/resource/type") in codes(record)


def test_model_op_requires_modality() -> None:
    resource = Resource(provider="a", type="model", name="m", operation="generation")
    record = minimal(emitter=EMITTER, resource=resource)
    assert (ErrorCode.REQUIRED, "/resource/modality") in codes(record)


def test_model_op_with_cost_tool() -> None:
    cost = Cost(total_cost=1, currency="USD", tool=ToolCost(call_cost=1))
    assert (ErrorCode.FORBIDDEN, "/cost/tool") in codes(minimal(emitter=EMITTER, cost=cost))


def test_tool_op_with_usage_llm() -> None:
    resource = Resource(provider="self-hosted", type="tool", name="t", operation="tool_execution")
    record = minimal(emitter=EMITTER, resource=resource)
    assert (ErrorCode.INVALID_STRUCTURE, "/usage") in codes(record)


def test_tool_op_with_model_type() -> None:
    resource = Resource(provider="self-hosted", type="model", name="t", operation="retrieval")
    record = minimal(emitter=EMITTER, resource=resource, usage=Usage(tool=ToolUsage(call_count=1)))
    assert (ErrorCode.INVALID_STRUCTURE, "/resource/type") in codes(record)


def test_tool_op_with_cost_llm() -> None:
    resource = Resource(provider="self-hosted", type="tool", name="t", operation="retrieval")
    record = minimal(
        emitter=EMITTER,
        resource=resource,
        usage=Usage(tool=ToolUsage(call_count=1)),
        cost=Cost(total_cost=1, currency="USD", llm=LlmCost(total_token_cost=1)),
    )
    assert (ErrorCode.FORBIDDEN, "/cost/llm") in codes(record)


def test_tool_op_is_otherwise_valid() -> None:
    resource = Resource(provider="self-hosted", type="tool", name="t", operation="retrieval")
    record = minimal(emitter=EMITTER, resource=resource, usage=Usage(tool=ToolUsage(call_count=1)))
    assert codes(record) == []


def test_trace_id_shape() -> None:
    run = minimal().run.model_copy(update={"trace_id": "xyz"})
    record = minimal(emitter=EMITTER, run=run)
    assert (ErrorCode.INVALID_IDENTIFIER, "/run/trace_id") in codes(record)


def test_well_formed_trace_id_is_accepted() -> None:
    run = minimal().run.model_copy(update={"trace_id": "0af7651916cd43dd8448eb211c80319c"})
    assert codes(minimal(emitter=EMITTER, run=run)) == []


def test_attribution_rules() -> None:
    assert (ErrorCode.REQUIRED, "/attribution/environment") in _pairs(Attribution().validate())
    assert (ErrorCode.REQUIRED, "/attribution/account_id") in _pairs(
        Attribution(environment="production").validate()
    )
    assert (ErrorCode.NON_PSEUDONYMOUS_ID, "/attribution/user_id") in _pairs(
        Attribution(environment="test", user_id="a@b.c").validate()
    )
    assert Attribution(environment="production", account_id="acct").validate() == []


def test_attribution_rules_apply_to_the_record() -> None:
    attribution = Attribution(environment="production", user_id="a@b.c")
    found = codes(minimal(emitter=EMITTER, attribution=attribution))
    assert (ErrorCode.REQUIRED, "/attribution/account_id") in found
    assert (ErrorCode.NON_PSEUDONYMOUS_ID, "/attribution/user_id") in found


def test_ensure_valid_returns_self_when_clean() -> None:
    record = minimal(emitter=EMITTER)
    assert record.ensure_valid() is record


def test_ensure_valid_raises() -> None:
    with pytest.raises(ValidationError) as info:
        minimal().ensure_valid()
    assert info.value.issues[0].code == ErrorCode.REQUIRED


def _pairs(issues: list[ValidationIssue]) -> list[tuple[ErrorCode, str]]:
    return [(i.code, i.path) for i in issues]
