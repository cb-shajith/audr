from __future__ import annotations

import asyncio

from audr._pipeline import Pipeline
from audr.results import SubmitOutcome
from audr.testing import MemorySink, make_record


async def test_batch_closes_on_count() -> None:
    sink = MemorySink()
    p = Pipeline(
        sink,
        max_queue_size=100,
        batch_max_size=3,
        linger_seconds=60,
        owns_sink=True,
        on_failure=None,
    )
    p.start()
    for _ in range(3):
        assert p.submit(make_record()).outcome is SubmitOutcome.QUEUED
    assert await p.flush(timeout=2) and sink.batches == 1 and len(sink.records) == 3
    await p.stop(timeout=1)


async def test_batch_closes_on_linger() -> None:
    sink = MemorySink()
    p = Pipeline(
        sink,
        max_queue_size=100,
        batch_max_size=50,
        linger_seconds=0.05,
        owns_sink=True,
        on_failure=None,
    )
    p.start()
    p.submit(make_record())
    await asyncio.sleep(0.2)
    assert sink.batches == 1
    await p.stop(timeout=1)


async def test_queue_full_drops_newest() -> None:
    sink = MemorySink()
    p = Pipeline(
        sink,
        max_queue_size=2,
        batch_max_size=50,
        linger_seconds=60,
        owns_sink=True,
        on_failure=None,
    )
    p.start()
    outcomes = [p.submit(make_record()).outcome for _ in range(3)]
    assert outcomes == [
        SubmitOutcome.QUEUED,
        SubmitOutcome.QUEUED,
        SubmitOutcome.DROPPED_QUEUE_FULL,
    ]
    assert p.stats.dropped == 1 and p.stats.submitted == 3
    await p.stop(timeout=1)


async def test_batch_collects_items_that_arrive_while_worker_is_lingering() -> None:
    # A yield point between submissions lets the worker start collecting the first
    # record and begin waiting on the linger window before the rest are submitted,
    # exercising the real (non-draining) wait-for-more-or-linger path.
    sink = MemorySink()
    p = Pipeline(
        sink,
        max_queue_size=100,
        batch_max_size=5,
        linger_seconds=5,
        owns_sink=True,
        on_failure=None,
    )
    p.start()
    p.submit(make_record())
    await asyncio.sleep(0)
    p.submit(make_record())
    p.submit(make_record())
    assert await p.flush(timeout=2)
    assert sink.batches == 1 and len(sink.records) == 3
    await p.stop(timeout=1)


async def test_submit_before_start_and_after_stop() -> None:
    sink = MemorySink()
    p = Pipeline(
        sink,
        max_queue_size=2,
        batch_max_size=50,
        linger_seconds=60,
        owns_sink=True,
        on_failure=None,
    )
    assert p.submit(make_record()).outcome is SubmitOutcome.DROPPED_NOT_RUNNING
    p.start()
    await p.stop(timeout=1)
    assert p.submit(make_record()).outcome is SubmitOutcome.DROPPED_NOT_RUNNING
