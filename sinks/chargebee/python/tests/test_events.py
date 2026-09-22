from datetime import UTC, datetime
from uuid import UUID

import pytest
from audr.ids import uuid7

from audr_sink_chargebee import UsageEvent
from audr_sink_chargebee._event_validation import InvalidUsageEventError

TIMESTAMP = 1_788_422_400_123


def test_event_mints_and_preserves_deduplication_identifier() -> None:
    minted = UsageEvent(
        subscription_id="sub_123",
        usage_timestamp=TIMESTAMP,
        properties={"api_calls": 1},
    )
    supplied = UsageEvent(
        subscription_id="sub_123",
        usage_timestamp=TIMESTAMP,
        deduplication_id="caller-id",
        properties={"api_calls": 1},
    )

    assert UUID(minted.deduplication_id).version == 7
    assert supplied.deduplication_id == "caller-id"


@pytest.mark.parametrize(
    ("kwargs", "field"),
    [
        ({"subscription_id": ""}, "subscription_id"),
        ({"subscription_id": "   "}, "subscription_id"),
        ({"subscription_id": 123}, "subscription_id"),
        ({"subscription_id": "s" * 51}, "subscription_id"),
        ({"deduplication_id": 123}, "deduplication_id"),
        ({"deduplication_id": "d" * 37}, "deduplication_id"),
        ({"usage_timestamp": 1_788_422_400}, "usage_timestamp"),  # epoch seconds
        ({"usage_timestamp": 17_884_224_001_234}, "usage_timestamp"),  # 14 digits
        ({"usage_timestamp": 1.5}, "usage_timestamp"),
        ({"usage_timestamp": True}, "usage_timestamp"),  # bool is an int in Python
        ({"properties": {}}, "properties"),
    ],
)
def test_event_rejects_invalid_destination_fields(kwargs: dict[str, object], field: str) -> None:
    values: dict[str, object] = {
        "subscription_id": "sub_123",
        "usage_timestamp": TIMESTAMP,
        "properties": {"api_calls": 1},
    }
    values.update(kwargs)

    with pytest.raises(InvalidUsageEventError, match=field):
        UsageEvent(
            subscription_id=values["subscription_id"],  # type: ignore[arg-type]
            usage_timestamp=values["usage_timestamp"],  # type: ignore[arg-type]
            properties=values["properties"],  # type: ignore[arg-type]
            deduplication_id=values.get("deduplication_id", uuid7()),  # type: ignore[arg-type]
        )


@pytest.mark.parametrize(
    "properties",
    [
        {"1_calls": 1},  # must start with a letter
        {"api-calls": 1},  # letters, digits, and underscores only
        {"subscription_id": "sub_123"},  # reserved by the destination
        {"event_meta": "x"},
        {"nested": {"inner_key": 1}},  # the destination answers 500 for containers
        {"tags": ["a", "b"]},
        {"at": datetime.now(UTC)},  # not a scalar
    ],
)
def test_event_rejects_properties_the_destination_would_reject(
    properties: dict[str, object],
) -> None:
    with pytest.raises(InvalidUsageEventError, match="properties"):
        UsageEvent(
            subscription_id="sub_123",
            usage_timestamp=TIMESTAMP,
            properties=properties,
        )


@pytest.mark.parametrize("value", [float("nan"), float("inf"), float("-inf")])
def test_event_rejects_non_finite_property_numbers(value: float) -> None:
    with pytest.raises(InvalidUsageEventError, match="finite JSON number"):
        UsageEvent(
            subscription_id="sub_123",
            usage_timestamp=TIMESTAMP,
            properties={"ratio": value},
        )


def test_event_accepts_the_flattened_audr_mapping() -> None:
    """Flattened AUDR properties must survive destination name rules."""
    event = UsageEvent(
        subscription_id="sub_123",
        usage_timestamp=TIMESTAMP,
        properties={
            "spec_version": "1.0.0",
            "record_id": "01991f5e-7aa1-7b37-a315-2f6a58a91234",
            "emitter__component": "harness",
            "resource__provider": "openai",
            "resource__type": "model",
            "resource__name": "gpt-5",
            "resource__operation": "generation",
            "usage__llm__input_tokens": 120,
            "usage__llm__output_tokens": 34,
            "run__span_id": "span_7",
            "attribution__environment": "production",
            "attribution__account_id": "account_123",
            "apiCalls": 1,  # the destination's regex permits uppercase
            "ratio": 1.5,
            "billable": False,
            "absent": None,
        },
    )

    assert event.properties["usage__llm__input_tokens"] == 120


def test_event_rejection_message_never_leaks_property_values() -> None:
    with pytest.raises(InvalidUsageEventError) as excinfo:
        UsageEvent(
            subscription_id="sub_123",
            usage_timestamp=TIMESTAMP,
            properties={"bad-name": "sk_live_secret"},
        )

    assert "sk_live_secret" not in str(excinfo.value)
    assert "bad-name" in str(excinfo.value)


def test_event_payload_is_isolated_from_callers_properties() -> None:
    properties = {"api_calls": 1}
    event = UsageEvent(
        subscription_id="sub_123",
        usage_timestamp=TIMESTAMP,
        deduplication_id="event-1",
        properties=properties,
    )
    properties["api_calls"] = 2

    payload = event.to_payload()
    assert set(payload) == {
        "subscription_id",
        "usage_timestamp",
        "deduplication_id",
        "properties",
    }
    assert payload["properties"] == {"api_calls": 1}


def test_event_rejects_properties_that_are_not_a_json_object() -> None:
    with pytest.raises(InvalidUsageEventError, match="properties must be a JSON object"):
        UsageEvent(
            subscription_id="sub_123",
            usage_timestamp=TIMESTAMP,
            properties=["not", "a", "mapping"],  # type: ignore[arg-type]
        )


@pytest.mark.parametrize("value", ["", "   ", "\t\n"])
def test_event_rejects_a_blank_deduplication_id(value: str) -> None:
    with pytest.raises(InvalidUsageEventError, match="deduplication_id must not be empty"):
        UsageEvent(
            subscription_id="sub_123",
            usage_timestamp=TIMESTAMP,
            deduplication_id=value,
            properties={"api_calls": 1},
        )


def test_event_rejects_a_non_string_property_name() -> None:
    with pytest.raises(InvalidUsageEventError, match="properties names must be strings"):
        UsageEvent(
            subscription_id="sub_123",
            usage_timestamp=TIMESTAMP,
            properties={1: "one"},  # type: ignore[dict-item]
        )
