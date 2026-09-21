from __future__ import annotations

import asyncio
from collections.abc import Sequence

from audr._pipeline import Pipeline
from audr.record import AUDR
from audr.results import FailedRecord, FailureReason
from audr.sinks import BatchResult
from audr.testing import MemorySink, make_record


class SlowSink(MemorySink):
    async def deliver(self, batch: Sequence[AUDR]) -> BatchResult:
        await asyncio.sleep(0.5)
        return await super().deliver(batch)


async def test_flush_timeout_returns_false_and_drops_nothing() -> None:
    sink = SlowSink()
    p = Pipeline(
        sink,
        max_queue_size=10,
        batch_max_size=1,
        linger_seconds=60,
        owns_sink=True,
        on_failure=None,
    )
    p.start()
    p.submit(make_record())
    assert await p.flush(timeout=0.05) is False and p.stats.dropped == 0
    assert await p.flush(timeout=2) is True and p.stats.sent == 1
    await p.stop(timeout=1)


async def test_stop_drains_then_drops_rest_as_shutdown() -> None:
    failed: list[FailedRecord] = []
    sink = SlowSink()
    p = Pipeline(
        sink,
        max_queue_size=10,
        batch_max_size=1,
        linger_seconds=60,
        owns_sink=True,
        on_failure=failed.append,
    )
    p.start()
    for _ in range(3):
        p.submit(make_record())
    await p.stop(timeout=0.6)  # one batch completes, others dropped
    assert p.stats.sent >= 1 and any(
        f.reason is FailureReason.SHUTDOWN and f.retryable for f in failed
    )
    assert sink.closed


async def test_stop_does_not_close_unowned_sink() -> None:
    sink = MemorySink()
    p = Pipeline(
        sink,
        max_queue_size=10,
        batch_max_size=1,
        linger_seconds=60,
        owns_sink=False,
        on_failure=None,
    )
    p.start()
    await p.stop(timeout=1)
    assert not sink.closed


async def test_start_and_stop_are_idempotent() -> None:
    sink = MemorySink()
    p = Pipeline(
        sink,
        max_queue_size=10,
        batch_max_size=1,
        linger_seconds=60,
        owns_sink=True,
        on_failure=None,
    )
    p.start()
    p.start()  # second call is a no-op; must not create a second worker
    assert p.running
    await p.stop(timeout=1)
    await p.stop(timeout=1)  # second call is a no-op; must not re-run shutdown
    assert not p.running and sink.closed


async def test_flush_before_start_is_a_noop_success() -> None:
    p = Pipeline(
        MemorySink(),
        max_queue_size=10,
        batch_max_size=1,
        linger_seconds=60,
        owns_sink=True,
        on_failure=None,
    )
    assert await p.flush(timeout=1) is True
