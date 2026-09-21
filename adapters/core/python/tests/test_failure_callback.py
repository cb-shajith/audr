"""Failure-callback behaviour, folded alongside the accounting tests per the brief."""

from __future__ import annotations

from collections.abc import Sequence

from audr._pipeline import Pipeline
from audr.record import AgentUsageRecord
from audr.results import Disposition, FailedRecord, FailureReason
from audr.sinks import BatchOutcome, BatchResult, RejectedRecord
from audr.testing import MemorySink, make_record


async def test_notify_failure_carries_record_and_detail() -> None:
    record = make_record()
    failed: list[FailedRecord] = []

    class S(MemorySink):
        async def deliver(self, batch: Sequence[AgentUsageRecord]) -> BatchResult:
            return BatchResult.accepted(
                rejected=[RejectedRecord(batch[0].record_id, "not allowed")]
            )

    p = Pipeline(
        S(),
        max_queue_size=10,
        batch_max_size=1,
        linger_seconds=60,
        owns_sink=True,
        on_failure=failed.append,
    )
    p.start()
    p.submit(record)
    await p.flush(timeout=2)
    await p.stop(timeout=1)

    assert len(failed) == 1
    failure = failed[0]
    assert failure.record.record_id == record.record_id
    assert failure.disposition is Disposition.DROPPED
    assert failure.reason is FailureReason.REJECTED
    assert failure.retryable is False
    assert failure.detail == "not allowed"


async def test_no_callback_configured_does_not_raise() -> None:
    p = Pipeline(
        MemorySink(fail_with=BatchOutcome.PERMANENT_FAILURE),
        max_queue_size=10,
        batch_max_size=1,
        linger_seconds=60,
        owns_sink=True,
        on_failure=None,
    )
    p.start()
    p.submit(make_record())
    assert await p.flush(timeout=2)
    await p.stop(timeout=1)
