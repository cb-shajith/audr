"""Failure classification and retry-delay policy."""

from __future__ import annotations

import random
from dataclasses import dataclass
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from enum import StrEnum
from math import isfinite

from audr import ConfigurationError


class FailureClass(StrEnum):
    """Classes of batch-level delivery failure."""

    TRANSIENT = "transient"
    CREDENTIAL = "credential"
    PERMANENT = "permanent"


@dataclass(frozen=True, slots=True)
class RetryPolicy:
    """The bounded, full-jitter retry policy used by the SDK's HTTP sinks."""

    max_attempts: int = 3
    initial_backoff: float = 0.5
    max_backoff: float = 30.0
    multiplier: float = 2.0

    def __post_init__(self) -> None:
        if isinstance(self.max_attempts, bool) or not isinstance(self.max_attempts, int):
            raise ConfigurationError("max_attempts must be an integer")
        if self.max_attempts < 1:
            raise ConfigurationError("max_attempts must be at least 1")
        _validate_finite_number(self.initial_backoff, "initial_backoff", minimum=0)
        _validate_finite_number(self.max_backoff, "max_backoff", minimum=0)
        _validate_finite_number(self.multiplier, "multiplier", minimum=1)

    def classify(self, status_code: int) -> FailureClass:
        """Classify a failed HTTP status; transport errors are transient by definition."""
        if status_code in {408, 429, 500, 502, 503, 504}:
            return FailureClass.TRANSIENT
        if status_code == 401:
            return FailureClass.CREDENTIAL
        return FailureClass.PERMANENT

    def delay_for(self, attempt: int, retry_after: str | None = None) -> float:
        """Return a capped full-jitter delay, honoring a valid Retry-After hint."""
        jittered_delay = jittered_backoff(
            attempt=attempt,
            initial_backoff=self.initial_backoff,
            max_backoff=self.max_backoff,
            multiplier=self.multiplier,
        )
        retry_after_delay = _parse_retry_after(retry_after)
        if retry_after_delay is None:
            return jittered_delay
        return min(self.max_backoff, max(jittered_delay, retry_after_delay))


def jittered_backoff(
    *,
    attempt: int,
    initial_backoff: float,
    max_backoff: float,
    multiplier: float = 2.0,
) -> float:
    """Return a full-jitter exponential backoff capped at ``max_backoff``."""
    ceiling = min(max_backoff, initial_backoff * multiplier ** (attempt - 1))
    return random.uniform(0.0, ceiling)


def _parse_retry_after(value: str | None) -> float | None:
    if value is None:
        return None
    try:
        seconds = float(int(value))
    except ValueError:
        try:
            retry_at = parsedate_to_datetime(value)
        except (TypeError, ValueError, IndexError, OverflowError):
            return None
        if retry_at.tzinfo is None:
            retry_at = retry_at.replace(tzinfo=UTC)
        seconds = (retry_at - datetime.now(UTC)).total_seconds()
    return max(0.0, float(seconds))


def _validate_finite_number(value: object, name: str, *, minimum: float) -> None:
    if isinstance(value, bool) or not isinstance(value, int | float) or not isfinite(value):
        raise ConfigurationError(f"{name} must be a finite number")
    if value < minimum:
        raise ConfigurationError(f"{name} must be at least {minimum:g}")
