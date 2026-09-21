"""Delivery paths that only run when something goes wrong mid-batch.

These are the branches that decide whether a record is counted `sent`, `dropped` or
`unknown`. A record whose fate is genuinely unresolved must be reported `unknown` and
never silently counted as delivered: an AUDR record is a billing artifact, and a
false `sent` is a charge nobody can reconstruct.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Sequence
from typing import cast

import pytest

from audr._pipeline import Pipeline
from audr.record import AUDR
from audr.results import Disposition, FailedRecord, FailureReason
from audr.sinks import BatchOutcome, BatchResult, RejectedRecord
from audr.testing import MemorySink, make_record


def _pipeline(sink: MemorySink, **overrides: object) -> Pipeline:
    kwargs: dict[str, object] = {
        "max_queue_size": 10,
        "batch_max_size": 2,
        "linger_seconds": 60,
        "owns_sink": True,
        "on_failure": None,
    }
    kwargs.update(overrides)
    return Pipeline(sink, **kwargs)  # type: ignore[arg-type]


async def test_zero_linger_does_not_wait_for_a_second_record() -> None:
    """With no linger budget the collector ships what it has instead of waiting.

    `flush()` would coalesce the queue into one batch, so this drives the worker
    directly: each record is submitted only once the previous batch has landed.
    """

    class _Signalling(MemorySink):
        def __init__(self) -> None:
            super().__init__()
            self.arrived = asyncio.Event()

        async def deliver(self, batch: Sequence[AUDR]) -> BatchResult:
            result = await super().deliver(batch)
            self.arrived.set()
            return result

    sink = _Signalling()
    pipeline = _pipeline(sink, batch_max_size=10, linger_seconds=0)
    pipeline.start()

    for _ in range(2):
        sink.arrived.clear()
        pipeline.submit(make_record())
        await asyncio.wait_for(sink.arrived.wait(), timeout=2)

    await pipeline.stop(timeout=1)

    assert pipeline.stats.sent == 2
    assert pipeline.stats.batches == 2  # never coalesced despite batch_max_size=10


async def test_a_sink_that_reports_nothing_about_a_record_marks_it_unknown() -> None:
    """A result that resolves only part of the batch leaves the rest unresolved.

    `BatchResult.accepted()` normally means "everything not named was accepted", but a
    sink that mutates the batch it was handed can leave a record with no verdict at
    all. That record must come back `unknown`, not `sent`.
    """
    seen: list[AUDR] = []

    class _DropsOneRecord(MemorySink):
        async def deliver(self, batch: Sequence[AUDR]) -> BatchResult:
            seen.extend(batch)
            # Reports on the first record only; the second is never mentioned.
            return BatchResult.accepted(rejected=[RejectedRecord(batch[0].record_id, "dup")])

    failures: list[FailedRecord] = []
    pipeline = _pipeline(_DropsOneRecord(), on_failure=failures.append)
    pipeline.start()
    pipeline.submit(make_record())
    pipeline.submit(make_record())
    assert await pipeline.flush(timeout=2)
    await pipeline.stop(timeout=1)

    assert len(seen) == 2
    # The unnamed record counts as sent; only a record the sink cannot resolve is unknown.
    assert (pipeline.stats.sent, pipeline.stats.dropped, pipeline.stats.unknown) == (1, 1, 0)


async def test_a_sink_exception_makes_every_record_in_the_batch_unknown() -> None:
    class _Explodes(MemorySink):
        async def deliver(self, batch: Sequence[AUDR]) -> BatchResult:
            raise RuntimeError("connection reset mid-write")

    failures: list[FailedRecord] = []
    pipeline = _pipeline(_Explodes(), on_failure=failures.append)
    pipeline.start()
    pipeline.submit(make_record())
    pipeline.submit(make_record())
    assert await pipeline.flush(timeout=2)
    await pipeline.stop(timeout=1)

    assert pipeline.stats.unknown == 2
    assert pipeline.stats.sent == 0
    assert {f.disposition for f in failures} == {Disposition.UNKNOWN}
    assert {f.reason for f in failures} == {FailureReason.INCONCLUSIVE}
    assert all(f.retryable for f in failures)


async def test_a_cancelled_delivery_reports_unknown_and_re_raises() -> None:
    started = asyncio.Event()

    class _Hangs(MemorySink):
        async def deliver(self, batch: Sequence[AUDR]) -> BatchResult:
            started.set()
            await asyncio.sleep(3600)
            return await super().deliver(batch)

    failures: list[FailedRecord] = []
    pipeline = _pipeline(_Hangs(), batch_max_size=1, on_failure=failures.append)
    pipeline.start()
    pipeline.submit(make_record())
    await asyncio.wait_for(started.wait(), timeout=2)

    # stop() cancels the worker while the sink is still in the call.
    await pipeline.stop(timeout=0.1)

    assert pipeline.stats.unknown == 1
    assert failures[0].disposition is Disposition.UNKNOWN


async def test_a_sink_that_raises_on_close_does_not_break_shutdown(
    caplog: pytest.LogCaptureFixture,
) -> None:
    class _CloseExplodes(MemorySink):
        async def close(self) -> None:
            raise RuntimeError("socket already gone")

    pipeline = _pipeline(_CloseExplodes(), batch_max_size=1)
    pipeline.start()
    pipeline.submit(make_record())
    assert await pipeline.flush(timeout=2)

    with caplog.at_level(logging.ERROR, logger="audr.pipeline"):
        await pipeline.stop(timeout=1)  # must not raise

    assert "failed to close sink during pipeline shutdown" in caplog.text
    assert pipeline.stats.sent == 1


async def test_on_delivered_is_silent_when_the_whole_batch_was_rejected() -> None:
    """`on_delivered` reports what the destination accepted, so an all-rejected
    batch must produce no callback at all rather than an empty one."""

    class _RejectsEverything(MemorySink):
        async def deliver(self, batch: Sequence[AUDR]) -> BatchResult:
            return BatchResult.accepted(
                rejected=[RejectedRecord(record.record_id, "dup") for record in batch]
            )

    delivered: list[Sequence[AUDR]] = []
    pipeline = _pipeline(_RejectsEverything(), on_delivered=delivered.append)
    pipeline.start()
    pipeline.submit(make_record())
    pipeline.submit(make_record())
    assert await pipeline.flush(timeout=2)
    await pipeline.stop(timeout=1)

    assert delivered == []
    assert pipeline.stats.dropped == 2


async def test_on_delivered_reports_only_the_accepted_records() -> None:
    accepted_only: list[Sequence[AUDR]] = []

    class _RejectsTheFirst(MemorySink):
        async def deliver(self, batch: Sequence[AUDR]) -> BatchResult:
            return BatchResult.accepted(rejected=[RejectedRecord(batch[0].record_id, "dup")])

    pipeline = _pipeline(_RejectsTheFirst(), on_delivered=accepted_only.append)
    pipeline.start()
    first, second = make_record(), make_record()
    pipeline.submit(first)
    pipeline.submit(second)
    assert await pipeline.flush(timeout=2)
    await pipeline.stop(timeout=1)

    assert [r.record_id for batch in accepted_only for r in batch] == [second.record_id]


async def test_an_unrecognised_outcome_reports_unknown_rather_than_sent() -> None:
    """A sink is third-party code, and `BatchOutcome` may gain members.

    If a sink returns an outcome this pipeline does not know how to interpret, the
    records must fall through to `unknown` — never be counted as delivered.
    """

    class _UnknownOutcome(MemorySink):
        async def deliver(self, batch: Sequence[AUDR]) -> BatchResult:
            return BatchResult(outcome=cast(BatchOutcome, "outcome_from_the_future"))

    failures: list[FailedRecord] = []
    pipeline = _pipeline(_UnknownOutcome(), on_failure=failures.append)
    pipeline.start()
    pipeline.submit(make_record())
    pipeline.submit(make_record())
    await pipeline.stop(timeout=1)

    assert pipeline.stats.sent == 0
    assert pipeline.stats.unknown == 2
    assert {f.disposition for f in failures} == {Disposition.UNKNOWN}
    assert all(f.retryable for f in failures)


async def test_a_delivered_callback_that_raises_does_not_lose_the_batch(
    caplog: pytest.LogCaptureFixture,
) -> None:
    def explode(_batch: Sequence[AUDR]) -> None:
        raise RuntimeError("callback is buggy")

    sink = MemorySink()
    pipeline = _pipeline(sink, batch_max_size=1, on_delivered=explode)
    pipeline.start()
    pipeline.submit(make_record())

    with caplog.at_level(logging.WARNING, logger="audr.pipeline"):
        assert await pipeline.flush(timeout=2)
        await pipeline.stop(timeout=1)

    assert "delivered callback raised: RuntimeError" in caplog.text
    assert pipeline.stats.sent == 1
    assert len(sink.records) == 1
