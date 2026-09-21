from datetime import UTC, datetime, timedelta
from email.utils import format_datetime

import pytest
from audr import ConfigurationError

from audr_sink_chargebee import FailureClass, RetryPolicy


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (400, FailureClass.PERMANENT),
        (401, FailureClass.CREDENTIAL),
        (403, FailureClass.PERMANENT),
        (408, FailureClass.TRANSIENT),
        (429, FailureClass.TRANSIENT),
        (500, FailureClass.TRANSIENT),
        (503, FailureClass.TRANSIENT),
    ],
)
def test_retry_policy_classifies_failures(value: int, expected: FailureClass) -> None:
    assert RetryPolicy().classify(value) is expected


@pytest.mark.parametrize("attempt", [1, 10])
def test_retry_delay_is_jittered_and_capped(attempt: int) -> None:
    policy = RetryPolicy(initial_backoff=1.0, max_backoff=3.0, multiplier=2.0)

    delay = policy.delay_for(attempt)

    assert 0.0 <= delay <= min(3.0, 2.0 ** (attempt - 1))


def test_retry_after_seconds_is_honored() -> None:
    policy = RetryPolicy(max_backoff=30.0)

    assert policy.delay_for(1, "2") >= 2.0


def test_retry_after_http_date_is_honored() -> None:
    policy = RetryPolicy(max_backoff=30.0)
    value = format_datetime(datetime.now(UTC) + timedelta(seconds=10), usegmt=True)

    assert policy.delay_for(1, value) >= 8.0


def test_unparseable_retry_after_uses_jitter() -> None:
    policy = RetryPolicy(initial_backoff=1.0)

    assert 0.0 <= policy.delay_for(1, "not a date") <= 1.0


@pytest.mark.parametrize(
    ("kwargs", "field"),
    [
        ({"max_attempts": 0}, "max_attempts"),
        ({"max_attempts": True}, "max_attempts"),
        ({"max_attempts": 1.5}, "max_attempts"),
        ({"initial_backoff": -1.0}, "initial_backoff"),
        ({"initial_backoff": float("nan")}, "initial_backoff"),
        ({"initial_backoff": float("inf")}, "initial_backoff"),
        ({"max_backoff": -1.0}, "max_backoff"),
        ({"max_backoff": True}, "max_backoff"),
        ({"multiplier": 0.5}, "multiplier"),
        ({"multiplier": float("nan")}, "multiplier"),
    ],
)
def test_retry_policy_rejects_invalid_configuration(kwargs: dict[str, object], field: str) -> None:
    with pytest.raises(ConfigurationError, match=field):
        RetryPolicy(**kwargs)  # type: ignore[arg-type]


def test_retry_after_without_a_timezone_is_read_as_utc() -> None:
    """RFC 9110 allows `-0000`, which `email.utils` reports as a naive datetime.

    Reading it in local time would make the backoff hours long, or zero, depending on
    where the process happens to run.
    """
    policy = RetryPolicy(max_backoff=300.0)
    value = format_datetime(datetime.now(UTC) + timedelta(seconds=120)).replace("+0000", "-0000")

    assert 100.0 <= policy.delay_for(1, value) <= 130.0


def test_a_stale_retry_after_cannot_shorten_the_backoff() -> None:
    """A `Retry-After` already in the past parses to zero. It must not be honoured
    literally: retrying immediately is how a struggling destination gets hammered."""
    policy = RetryPolicy(initial_backoff=1.0, max_backoff=30.0)
    value = format_datetime(datetime.now(UTC) - timedelta(seconds=60), usegmt=True)

    delay = policy.delay_for(1, value)

    assert 0.0 <= delay <= 1.0  # the jittered floor, not the stale hint
