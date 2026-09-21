import pytest

from audr.errors import ValidationError
from audr.record import AUDR
from audr.record.codes import ErrorCode
from tests.helpers import EMITTER, minimal


def _pairs(error: ValidationError) -> set[tuple[ErrorCode, str]]:
    return {(i.code, i.path) for i in error.issues}


def test_round_trip() -> None:
    r = minimal(emitter=EMITTER)
    assert AUDR.from_json(r.to_json()) == r


def test_round_trip_from_bytes() -> None:
    r = minimal(emitter=EMITTER)
    assert AUDR.from_json(r.to_json().encode()) == r


def test_not_json() -> None:
    with pytest.raises(ValidationError) as info:
        AUDR.from_json("{nope")
    assert len(info.value.issues) == 1
    assert info.value.issues[0].code == ErrorCode.NOT_JSON


def test_json_that_is_not_an_object() -> None:
    with pytest.raises(ValidationError) as info:
        AUDR.from_json("[]")
    assert _pairs(info.value) == {(ErrorCode.INVALID_TYPE, "/")}


def test_missing_spec_version() -> None:
    d = minimal(emitter=EMITTER).to_dict()
    del d["spec_version"]
    with pytest.raises(ValidationError) as info:
        AUDR.from_dict(d)
    assert _pairs(info.value) == {(ErrorCode.REQUIRED, "/spec_version")}


def test_wrong_major_version() -> None:
    d = minimal(emitter=EMITTER).to_dict()
    d["spec_version"] = "2.0.0"
    with pytest.raises(ValidationError) as info:
        AUDR.from_dict(d)
    assert (ErrorCode.UNSUPPORTED_VERSION, "/spec_version") in _pairs(info.value)


def test_multiple_structural_issues_reported_together() -> None:
    d = minimal(emitter=EMITTER).to_dict()
    del d["resource"]["provider"]
    d["attribution"]["bogus"] = 1
    d["usage"]["llm"]["input_tokens"] = -1
    with pytest.raises(ValidationError) as info:
        AUDR.from_dict(d)
    found = _pairs(info.value)
    assert (ErrorCode.REQUIRED, "/resource/provider") in found
    assert (ErrorCode.UNKNOWN_PROPERTY, "/attribution/bogus") in found
    assert (ErrorCode.INVALID_COUNTER, "/usage/llm/input_tokens") in found


def test_unknown_extension_name_is_reported_as_unknown_property() -> None:
    d = minimal(emitter=EMITTER).to_dict()
    d["usage"]["llm"]["bogus"] = 1
    with pytest.raises(ValidationError) as info:
        AUDR.from_dict(d)
    assert (ErrorCode.UNKNOWN_PROPERTY, "/usage/llm") in _pairs(info.value)


def test_from_dict_runs_cross_field_rules() -> None:
    d = minimal(emitter=EMITTER).to_dict()
    d["timing"]["received_time"] = d["timing"]["event_time"]
    with pytest.raises(ValidationError) as info:
        AUDR.from_dict(d)
    assert (ErrorCode.FORBIDDEN, "/timing/received_time") in _pairs(info.value)


def test_messages_are_value_free() -> None:
    d = minimal(emitter=EMITTER).to_dict()
    d["attribution"]["user_id"] = "secret@example.com"
    with pytest.raises(ValidationError) as info:
        AUDR.from_dict(d)
    assert "secret" not in str(info.value)
    assert all("secret" not in i.message for i in info.value.issues)


def test_malformed_datetime_is_reported_as_invalid_datetime() -> None:
    d = minimal(emitter=EMITTER).to_dict()
    d["timing"]["event_time"] = "not-a-date"
    with pytest.raises(ValidationError) as info:
        AUDR.from_dict(d)
    assert (ErrorCode.INVALID_DATETIME, "/timing/event_time") in _pairs(info.value)


def test_unparsable_counter_is_reported_as_invalid_type() -> None:
    d = minimal(emitter=EMITTER).to_dict()
    d["usage"]["llm"]["input_tokens"] = "abc"
    with pytest.raises(ValidationError) as info:
        AUDR.from_dict(d)
    assert (ErrorCode.INVALID_TYPE, "/usage/llm/input_tokens") in _pairs(info.value)


def test_negative_extension_counter_is_reported_as_invalid_counter() -> None:
    d = minimal(emitter=EMITTER).to_dict()
    d["usage"]["llm"]["x_acme_widgets"] = -1
    with pytest.raises(ValidationError) as info:
        AUDR.from_dict(d)
    assert (ErrorCode.INVALID_COUNTER, "/usage/llm") in _pairs(info.value)


def test_bad_label_key_is_reported_without_the_key() -> None:
    d = minimal(emitter=EMITTER).to_dict()
    d["attribution"]["labels"] = {"secret@example.com": "x"}
    with pytest.raises(ValidationError) as info:
        AUDR.from_dict(d)
    assert (ErrorCode.INVALID_PROPERTY_NAME, "/attribution/labels/*") in _pairs(info.value)
    assert "secret" not in str(info.value)


def test_bad_label_value_is_reported_without_the_key() -> None:
    d = minimal(emitter=EMITTER).to_dict()
    d["attribution"]["labels"] = {"tenant": "x" * 300}
    with pytest.raises(ValidationError) as info:
        AUDR.from_dict(d)
    assert (ErrorCode.STRING_TOO_LONG, "/attribution/labels/*") in _pairs(info.value)
    assert "tenant" not in str(info.value)


def test_bad_currency_gets_its_own_code() -> None:
    d = minimal(emitter=EMITTER).to_dict()
    d["cost"] = {"total_cost": 1, "currency": "usd"}
    with pytest.raises(ValidationError) as info:
        AUDR.from_dict(d)
    assert (ErrorCode.INVALID_CURRENCY, "/cost/currency") in _pairs(info.value)
