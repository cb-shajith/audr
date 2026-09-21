"""The sink contract: what a destination must implement to receive records."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from enum import StrEnum
from typing import Protocol, runtime_checkable

from audr.record import AgentUsageRecord


class BatchOutcome(StrEnum):
    """The outcome of attempting to deliver a batch of records."""

    ACCEPTED = "accepted"
    RETRYABLE_FAILURE = "retryable_failure"
    PERMANENT_FAILURE = "permanent_failure"
    CLOSED = "closed"


@dataclass(frozen=True, slots=True)
class RejectedRecord:
    """A record the destination rejected, identified by its `record_id`."""

    record_id: str
    detail: str | None = None


@dataclass(frozen=True, slots=True)
class BatchResult:
    """A sink's outcome for one batch delivery attempt.

    For ``ACCEPTED`` outcomes, a sink reports any record it did not accept in
    exactly one of ``rejected`` or ``unknown``; a record absent from both was
    accepted. ``unknown`` holds bare `record_id`s the sink could not resolve
    authoritatively.
    """

    outcome: BatchOutcome
    rejected: tuple[RejectedRecord, ...] = ()
    unknown: tuple[str, ...] = ()
    detail: str | None = None

    @classmethod
    def accepted(
        cls,
        *,
        rejected: Sequence[RejectedRecord] = (),
        unknown: Sequence[str] = (),
    ) -> BatchResult:
        """An accepted batch, optionally naming records it did not accept."""
        return cls(outcome=BatchOutcome.ACCEPTED, rejected=tuple(rejected), unknown=tuple(unknown))

    @classmethod
    def failed(cls, *, retryable: bool, detail: str | None = None) -> BatchResult:
        """A whole-batch failure, retryable or permanent."""
        outcome = BatchOutcome.RETRYABLE_FAILURE if retryable else BatchOutcome.PERMANENT_FAILURE
        return cls(outcome=outcome, detail=detail)

    @classmethod
    def closed(cls) -> BatchResult:
        """The sink is closed and cannot accept the batch."""
        return cls(outcome=BatchOutcome.CLOSED)


@runtime_checkable
class Sink(Protocol):
    """A destination able to deliver batches of AUDR records."""

    async def deliver(self, batch: Sequence[AgentUsageRecord]) -> BatchResult:
        """Deliver one record batch and return its typed outcome."""
        ...

    async def close(self) -> None:
        """Release any resources held by the destination."""
        ...


__all__ = ["BatchOutcome", "BatchResult", "RejectedRecord", "Sink"]
