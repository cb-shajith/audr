"""Asynchronous, bounded batching pipeline for AUDR record delivery."""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from enum import Enum, auto
from typing import assert_never

from audr.record import AgentUsageRecord
from audr.results import (
    DeliveredCallback,
    DeliveryStats,
    Disposition,
    FailedRecord,
    FailureCallback,
    FailureReason,
    SubmitOutcome,
    SubmitResult,
)
from audr.sinks import BatchOutcome, BatchResult, Sink

_LOGGER = logging.getLogger("audr.pipeline")

_DEFAULT_DRAIN_TIMEOUT_SECONDS = 30.0


class _RecordState(Enum):
    """Terminal accounting state for a record removed from the queue."""

    IN_FLIGHT = auto()
    SENT = auto()
    DROPPED = auto()
    UNKNOWN = auto()


@dataclass(slots=True)
class _QueuedRecord:
    """In-flight wrapper with one monotonic terminal accounting transition."""

    record: AgentUsageRecord
    state: _RecordState = _RecordState.IN_FLIGHT


class Pipeline:
    """Queue single records and deliver them in background micro-batches."""

    def __init__(
        self,
        sink: Sink,
        *,
        max_queue_size: int,
        batch_max_size: int,
        linger_seconds: float,
        owns_sink: bool,
        on_failure: FailureCallback | None,
        on_delivered: DeliveredCallback | None = None,
    ) -> None:
        self._sink = sink
        self._max_queue_size = max_queue_size
        self._batch_max_size = batch_max_size
        self._linger_seconds = linger_seconds
        self._owns_sink = owns_sink
        self._on_failure = on_failure
        self._on_delivered = on_delivered

        self._queue: asyncio.Queue[AgentUsageRecord] = asyncio.Queue()
        self._sink_lock = asyncio.Lock()
        self._worker_task: asyncio.Task[None] | None = None
        self._in_flight_records: dict[int, _QueuedRecord] = {}
        self._in_flight = 0
        self._running = False
        self._draining = asyncio.Event()
        self._stopped = False
        self._submitted = 0
        self._sent = 0
        self._dropped = 0
        self._unknown = 0
        self._batches = 0

    @property
    def stats(self) -> DeliveryStats:
        """Return an immutable snapshot of delivery counters."""
        return DeliveryStats(
            submitted=self._submitted,
            sent=self._sent,
            dropped=self._dropped,
            unknown=self._unknown,
            batches=self._batches,
            queue_depth=self._current_depth(),
            queue_capacity=self._max_queue_size,
        )

    @property
    def running(self) -> bool:
        """Return whether the worker is accepting submissions."""
        return self._running

    def start(self) -> None:
        """Start the delivery worker from inside the host application's event loop."""
        if self._running or self._stopped:
            return
        loop = asyncio.get_running_loop()
        self._running = True
        self._draining.clear()
        self._worker_task = loop.create_task(self._worker(), name="audr-delivery")

    def submit(self, record: AgentUsageRecord) -> SubmitResult:
        """Queue one record and return immediately; the worker performs all I/O."""
        self._submitted += 1
        if not self._running:
            self._dropped += 1
            self._notify_failure(
                record,
                disposition=Disposition.DROPPED,
                reason=FailureReason.NOT_RUNNING,
                retryable=True,
            )
            return SubmitResult(SubmitOutcome.DROPPED_NOT_RUNNING)

        depth = self._current_depth()
        if depth >= self._max_queue_size:
            self._dropped += 1
            _LOGGER.warning("record dropped: queue full (depth=%s)", depth)
            self._notify_failure(
                record,
                disposition=Disposition.DROPPED,
                reason=FailureReason.QUEUE_FULL,
                retryable=True,
            )
            return SubmitResult(SubmitOutcome.DROPPED_QUEUE_FULL)

        self._queue.put_nowait(record)
        return SubmitResult(SubmitOutcome.QUEUED)

    async def flush(self, timeout: float | None = None) -> bool:
        """Deliver queued and in-flight work now, waiting up to `timeout` seconds.

        Returns True when everything queued at the time of the call has reached a
        terminal state. Returns False when the bound expired first; the remaining
        records stay queued and continue to be delivered in the background.
        """
        if not self._running:
            return True
        return await self._drain(
            _DEFAULT_DRAIN_TIMEOUT_SECONDS if timeout is None else timeout,
            abandon_on_timeout=False,
        )

    async def stop(self, timeout: float | None = None) -> None:
        """Stop accepting records, drain bounded work, then close the sink."""
        if self._stopped:
            return
        self._running = False
        self._stopped = True
        try:
            await self._drain(
                _DEFAULT_DRAIN_TIMEOUT_SECONDS if timeout is None else timeout,
                abandon_on_timeout=True,
            )
        finally:
            await self._shutdown()

    async def _worker(self) -> None:
        while True:
            batch = await self._collect_batch()
            try:
                await self._deliver(batch)
            finally:
                for _ in batch:
                    self._queue.task_done()

    async def _collect_batch(self) -> list[_QueuedRecord]:
        """Block for one record, then fill until count, linger, or drain."""
        first_record = await self._queue.get()
        first = self._begin_in_flight(first_record)
        batch = [first]
        deadline = asyncio.get_running_loop().time() + self._linger_seconds
        while len(batch) < self._batch_max_size:
            next_record: AgentUsageRecord | None
            if self._draining.is_set():
                try:
                    next_record = self._queue.get_nowait()
                except asyncio.QueueEmpty:
                    break
            else:
                next_record = await self._next_within_linger(deadline)
                if next_record is None:
                    break
            batch.append(self._begin_in_flight(next_record))
        return batch

    async def _next_within_linger(self, deadline: float) -> AgentUsageRecord | None:
        remaining = deadline - asyncio.get_running_loop().time()
        if remaining <= 0:
            return None
        get_task: asyncio.Task[AgentUsageRecord] = asyncio.ensure_future(self._queue.get())
        drain_task: asyncio.Task[bool] = asyncio.ensure_future(self._draining.wait())
        try:
            done, _ = await asyncio.wait(
                {get_task, drain_task},
                timeout=remaining,
                return_when=asyncio.FIRST_COMPLETED,
            )
            if get_task in done:
                return get_task.result()
            return None
        finally:
            for task in (get_task, drain_task):
                if not task.done():
                    task.cancel()
            await asyncio.gather(get_task, drain_task, return_exceptions=True)

    async def _deliver(self, batch: list[_QueuedRecord]) -> None:
        try:
            records = tuple(queued.record for queued in batch)
            try:
                async with self._sink_lock:
                    result = await self._sink.deliver(records)
            except asyncio.CancelledError:
                for queued in batch:
                    self._mark_unknown(
                        queued,
                        "record outcome unknown: delivery cancelled",
                        reason=FailureReason.INCONCLUSIVE,
                    )
                raise
            except Exception:
                _LOGGER.exception(
                    "batch outcome unknown after unexpected sink exception (size=%s)",
                    len(batch),
                )
                for queued in batch:
                    self._mark_unknown(
                        queued,
                        "record outcome unknown: sink exception",
                        reason=FailureReason.INCONCLUSIVE,
                    )
                return

            self._batches += 1
            match result.outcome:
                case BatchOutcome.ACCEPTED:
                    self._apply_accepted_result(batch, result)
                    self._notify_delivered(batch)
                    return
                case BatchOutcome.RETRYABLE_FAILURE:
                    _LOGGER.warning(
                        "batch dropped after retryable sink failure (size=%s)", len(batch)
                    )
                    drop_reason = FailureReason.SINK_FAILURE
                    retryable = True
                case BatchOutcome.PERMANENT_FAILURE:
                    _LOGGER.warning(
                        "batch dropped after permanent sink failure (size=%s)", len(batch)
                    )
                    drop_reason = FailureReason.SINK_FAILURE
                    retryable = False
                case BatchOutcome.CLOSED:
                    _LOGGER.error("batch dropped because the sink is closed (size=%s)", len(batch))
                    drop_reason = FailureReason.SINK_CLOSED
                    retryable = True
                case unreachable:
                    assert_never(unreachable)
            for queued in batch:
                self._drop(queued, reason=drop_reason, retryable=retryable)
        finally:
            for queued in batch:
                if queued.state is _RecordState.IN_FLIGHT:
                    self._mark_unknown(
                        queued,
                        "record outcome unknown: incomplete delivery result",
                        reason=FailureReason.INCONCLUSIVE,
                    )
                self._release_in_flight(queued)

    def _apply_accepted_result(
        self,
        batch: list[_QueuedRecord],
        result: BatchResult,
    ) -> None:
        rejected_by_id = {rejection.record_id: rejection for rejection in result.rejected}
        unknown_ids = set(result.unknown)
        for queued in batch:
            identifier = queued.record.record_id
            if identifier in rejected_by_id:
                rejection = rejected_by_id[identifier]
                self._drop(
                    queued,
                    reason=FailureReason.REJECTED,
                    retryable=False,
                    detail=rejection.detail,
                )
            elif identifier in unknown_ids:
                self._mark_unknown(
                    queued,
                    "record outcome unknown: destination response was inconclusive",
                    reason=FailureReason.INCONCLUSIVE,
                )
            else:
                self._mark_sent(queued)

    async def _drain(self, timeout: float, *, abandon_on_timeout: bool) -> bool:
        self._draining.set()
        try:
            await asyncio.wait_for(self._queue.join(), timeout=timeout)
        except TimeoutError:
            if abandon_on_timeout:
                self._abandon_outstanding()
            return False
        finally:
            if not self._stopped:
                self._draining.clear()
        return True

    async def _shutdown(self) -> None:
        if self._worker_task is not None:
            self._worker_task.cancel()
            await asyncio.gather(self._worker_task, return_exceptions=True)
            self._worker_task = None
        self._abandon_outstanding()
        if self._owns_sink:
            try:
                await self._sink.close()
            except Exception:
                _LOGGER.exception("failed to close sink during pipeline shutdown")
        _LOGGER.info(
            "delivery stopped: submitted=%s sent=%s dropped=%s unknown=%s batches=%s",
            self._submitted,
            self._sent,
            self._dropped,
            self._unknown,
            self._batches,
        )

    def _abandon_outstanding(self) -> None:
        while True:
            try:
                record = self._queue.get_nowait()
            except asyncio.QueueEmpty:
                break
            self._queue.task_done()
            self._drop_queued(record)
        for queued in list(self._in_flight_records.values()):
            self._mark_unknown(
                queued,
                "record outcome unknown: shutdown",
                reason=FailureReason.SHUTDOWN,
            )

    def _drop_queued(self, record: AgentUsageRecord) -> None:
        self._dropped += 1
        _LOGGER.warning("record dropped: shutdown")
        self._notify_failure(
            record,
            disposition=Disposition.DROPPED,
            reason=FailureReason.SHUTDOWN,
            retryable=True,
        )

    def _begin_in_flight(self, record: AgentUsageRecord) -> _QueuedRecord:
        queued = _QueuedRecord(record=record)
        self._in_flight += 1
        self._in_flight_records[id(queued)] = queued
        return queued

    def _finalize(self, queued: _QueuedRecord, state: _RecordState) -> bool:
        if queued.state is not _RecordState.IN_FLIGHT:
            return False
        queued.state = state
        return True

    def _release_in_flight(self, queued: _QueuedRecord) -> None:
        if self._in_flight_records.pop(id(queued), None) is not None:
            self._in_flight -= 1

    def _mark_sent(self, queued: _QueuedRecord) -> None:
        if self._finalize(queued, _RecordState.SENT):
            self._sent += 1

    def _drop(
        self,
        queued: _QueuedRecord,
        *,
        reason: FailureReason,
        retryable: bool,
        detail: str | None = None,
    ) -> None:
        if self._finalize(queued, _RecordState.DROPPED):
            self._dropped += 1
            _LOGGER.warning("record dropped: reason=%s", reason.value)
            self._notify_failure(
                queued.record,
                disposition=Disposition.DROPPED,
                reason=reason,
                retryable=retryable,
                detail=detail,
            )

    def _mark_unknown(
        self,
        queued: _QueuedRecord,
        message: str,
        *,
        reason: FailureReason,
    ) -> None:
        if self._finalize(queued, _RecordState.UNKNOWN):
            self._unknown += 1
            _LOGGER.warning("%s", message)
            self._notify_failure(
                queued.record,
                disposition=Disposition.UNKNOWN,
                reason=reason,
                retryable=True,
            )

    def _notify_failure(
        self,
        record: AgentUsageRecord,
        *,
        disposition: Disposition,
        reason: FailureReason,
        retryable: bool,
        detail: str | None = None,
    ) -> None:
        if self._on_failure is None:
            return
        failure = FailedRecord(
            record=record,
            disposition=disposition,
            reason=reason,
            retryable=retryable,
            detail=detail,
        )
        try:
            self._on_failure(failure)
        except Exception as error:
            _LOGGER.warning(
                "failure callback raised: %s",
                type(error).__name__,
            )

    def _notify_delivered(self, batch: list[_QueuedRecord]) -> None:
        if self._on_delivered is None:
            return
        sent_records = tuple(queued.record for queued in batch if queued.state is _RecordState.SENT)
        if not sent_records:
            return
        try:
            self._on_delivered(sent_records)
        except Exception as error:
            _LOGGER.warning(
                "delivered callback raised: %s",
                type(error).__name__,
            )

    def _current_depth(self) -> int:
        return self._queue.qsize() + self._in_flight


__all__ = ["Pipeline"]
