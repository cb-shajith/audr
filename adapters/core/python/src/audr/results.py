"""Typed outcomes for pipeline submission and terminal delivery accounting."""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from enum import StrEnum

from audr.errors import ValidationIssue
from audr.record import AUDR


class SubmitOutcome(StrEnum):
    """The closed set of values `SubmitResult.outcome` can take."""

    QUEUED = "queued"
    REJECTED_INVALID = "rejected_invalid"
    DROPPED_QUEUE_FULL = "dropped_queue_full"
    DROPPED_NOT_RUNNING = "dropped_not_running"
    DROPPED_INTERNAL_ERROR = "dropped_internal_error"


@dataclass(frozen=True, slots=True)
class SubmitResult:
    """The immediate outcome of submitting one record to the pipeline."""

    outcome: SubmitOutcome
    issues: tuple[ValidationIssue, ...] = ()

    @property
    def queued(self) -> bool:
        """Whether the record was accepted onto the pipeline's queue."""
        return self.outcome is SubmitOutcome.QUEUED


class FailureReason(StrEnum):
    """Stable, value-free reasons for unsuccessful delivery."""

    INVALID = "invalid"
    QUEUE_FULL = "queue_full"
    NOT_RUNNING = "not_running"
    SHUTDOWN = "shutdown"
    REJECTED = "rejected"
    SINK_FAILURE = "sink_failure"
    SINK_CLOSED = "sink_closed"
    INCONCLUSIVE = "inconclusive"


class Disposition(StrEnum):
    """A terminal delivery disposition reported to a failure callback."""

    DROPPED = "dropped"
    UNKNOWN = "unknown"


@dataclass(frozen=True, slots=True)
class FailedRecord:
    """One terminal delivery failure passed to the configured failure callback."""

    record: AUDR
    disposition: Disposition
    reason: FailureReason
    retryable: bool
    detail: str | None = None


FailureCallback = Callable[[FailedRecord], None]

DeliveredCallback = Callable[[Sequence[AUDR]], None]


@dataclass(frozen=True, slots=True)
class DeliveryStats:
    """An immutable point-in-time snapshot of background delivery counters.

    Every record admitted through submission ends in exactly one of ``sent``,
    ``dropped``, or ``unknown``. ``unknown`` counts records for which a delivery attempt
    began but sink acceptance could not be determined; it is terminal.
    """

    submitted: int = 0
    sent: int = 0
    dropped: int = 0
    unknown: int = 0
    batches: int = 0
    queue_depth: int = 0
    queue_capacity: int = 0


__all__ = [
    "DeliveredCallback",
    "DeliveryStats",
    "Disposition",
    "FailedRecord",
    "FailureCallback",
    "FailureReason",
    "SubmitOutcome",
    "SubmitResult",
]
