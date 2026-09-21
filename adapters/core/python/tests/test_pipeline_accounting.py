from __future__ import annotations

from collections.abc import Sequence

from audr._pipeline import Pipeline
from audr.record import AgentUsageRecord
from audr.results import DeliveredCallback, DeliveryStats, Disposition, FailedRecord, FailureReason
from audr.sinks import BatchOutcome, BatchResult, RejectedRecord
from audr.testing import MemorySink, make_record


async def run(
    sink: MemorySink, n: int = 2, *, on_delivered: DeliveredCallback | None = None
) -> tuple[DeliveryStats, list[FailedRecord], list[AgentUsageRecord]]:
    failed: list[FailedRecord] = []
    p = Pipeline(
        sink,
        max_queue_size=10,
        batch_max_size=n,
        linger_seconds=60,
        owns_sink=True,
        on_failure=failed.append,
        on_delivered=on_delivered,
    )
    p.start()
    records = [make_record() for _ in range(n)]
    for r in records:
        p.submit(r)
    await p.flush(timeout=2)
    await p.stop(timeout=1)
    return p.stats, failed, records


async def test_rejected_and_unknown_buckets() -> None:
    class S(MemorySink):
        async def deliver(self, batch: Sequence[AgentUsageRecord]) -> BatchResult:
            return BatchResult.accepted(
                rejected=[RejectedRecord(batch[0].record_id, "dup")],
                unknown=[batch[1].record_id],
            )

    stats, failed, _ = await run(S())
    assert (stats.sent, stats.dropped, stats.unknown) == (0, 1, 1)
    reasons = {(f.reason, f.disposition, f.retryable) for f in failed}
    assert (FailureReason.REJECTED, Disposition.DROPPED, False) in reasons
    assert (FailureReason.INCONCLUSIVE, Disposition.UNKNOWN, True) in reasons


async def test_retryable_failure() -> None:
    stats, failed, _ = await run(MemorySink(fail_with=BatchOutcome.RETRYABLE_FAILURE))
    assert stats.dropped == 2 and all(
        f.reason is FailureReason.SINK_FAILURE and f.retryable for f in failed
    )


async def test_permanent_failure() -> None:
    _, failed, _ = await run(MemorySink(fail_with=BatchOutcome.PERMANENT_FAILURE))
    assert all(f.reason is FailureReason.SINK_FAILURE and not f.retryable for f in failed)


async def test_closed_sink_marks_dropped_sink_closed() -> None:
    stats, failed, _ = await run(MemorySink(fail_with=BatchOutcome.CLOSED))
    assert stats.dropped == 2
    assert all(f.reason is FailureReason.SINK_CLOSED and f.retryable for f in failed)


async def test_raising_sink_marks_unknown_and_worker_survives() -> None:
    class Boom(MemorySink):
        calls = 0

        async def deliver(self, batch: Sequence[AgentUsageRecord]) -> BatchResult:
            Boom.calls += 1
            if Boom.calls == 1:
                raise RuntimeError("x")
            return await super().deliver(batch)

    failed: list[FailedRecord] = []
    sink = Boom()
    p = Pipeline(
        sink,
        max_queue_size=10,
        batch_max_size=1,
        linger_seconds=60,
        owns_sink=True,
        on_failure=failed.append,
    )
    p.start()
    p.submit(make_record())
    await p.flush(timeout=2)
    p.submit(make_record())
    await p.flush(timeout=2)
    await p.stop(timeout=1)
    assert p.stats.unknown == 1 and p.stats.sent == 1
    assert failed[0].reason is FailureReason.INCONCLUSIVE


async def test_callback_exception_is_swallowed() -> None:
    def bad(_: FailedRecord) -> None:
        raise ValueError("cb")

    p = Pipeline(
        MemorySink(fail_with=BatchOutcome.PERMANENT_FAILURE),
        max_queue_size=10,
        batch_max_size=1,
        linger_seconds=60,
        owns_sink=True,
        on_failure=bad,
    )
    p.start()
    p.submit(make_record())
    assert await p.flush(timeout=2)
    await p.stop(timeout=1)


async def test_delivered_callback_receives_accepted_records_once() -> None:
    delivered: list[Sequence[AgentUsageRecord]] = []
    stats, _, records = await run(MemorySink(), n=3, on_delivered=delivered.append)
    assert stats.sent == 3
    assert len(delivered) == 1
    assert delivered[0] == tuple(records)


async def test_delivered_excludes_rejected_and_unknown() -> None:
    class S(MemorySink):
        async def deliver(self, batch: Sequence[AgentUsageRecord]) -> BatchResult:
            return BatchResult.accepted(
                rejected=[RejectedRecord(batch[0].record_id, "dup")],
                unknown=[batch[1].record_id],
            )

    delivered: list[Sequence[AgentUsageRecord]] = []
    stats, failed, records = await run(S(), n=3, on_delivered=delivered.append)
    assert stats.sent == 1
    assert len(delivered) == 1
    assert delivered[0] == (records[2],)
    assert len(failed) == 2


async def test_delivered_not_called_on_retryable_failure() -> None:
    delivered: list[Sequence[AgentUsageRecord]] = []
    await run(MemorySink(fail_with=BatchOutcome.RETRYABLE_FAILURE), on_delivered=delivered.append)
    assert delivered == []


async def test_delivered_callback_exception_is_swallowed_and_worker_continues() -> None:
    def bad(_: Sequence[AgentUsageRecord]) -> None:
        raise ValueError("cb")

    p = Pipeline(
        MemorySink(),
        max_queue_size=10,
        batch_max_size=1,
        linger_seconds=60,
        owns_sink=True,
        on_failure=None,
        on_delivered=bad,
    )
    p.start()
    p.submit(make_record())
    assert await p.flush(timeout=2)
    p.submit(make_record())
    assert await p.flush(timeout=2)
    await p.stop(timeout=1)
    assert p.stats.sent == 2
