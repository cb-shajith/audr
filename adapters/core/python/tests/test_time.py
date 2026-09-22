from datetime import UTC, datetime, timedelta, timezone

import pytest

from audr._time import now_utc, parse_rfc3339, to_rfc3339_ms


def test_now_utc_is_aware_and_millisecond_truncated() -> None:
    value = now_utc()
    assert value.tzinfo is not None
    assert value.utcoffset() == timedelta(0)
    assert value.microsecond % 1000 == 0


def test_to_rfc3339_ms_uses_z_and_three_fractional_digits() -> None:
    value = datetime(2026, 9, 20, 10, 0, 0, 123456, tzinfo=UTC)
    assert to_rfc3339_ms(value) == "2026-09-20T10:00:00.123Z"


def test_to_rfc3339_ms_rejects_naive_datetimes() -> None:
    with pytest.raises(ValueError, match="timezone-aware"):
        to_rfc3339_ms(datetime(2026, 9, 20, 10, 0, 0))


def test_to_rfc3339_ms_converts_other_offsets_to_utc() -> None:
    value = datetime(2026, 9, 20, 12, 0, 0, tzinfo=timezone(timedelta(hours=2)))
    assert to_rfc3339_ms(value) == "2026-09-20T10:00:00.000Z"


def test_parse_rfc3339_round_trips() -> None:
    text = "2026-09-20T10:00:00.123Z"
    parsed = parse_rfc3339(text)
    assert parsed == datetime(2026, 9, 20, 10, 0, 0, 123000, tzinfo=UTC)
    assert to_rfc3339_ms(parsed) == text
