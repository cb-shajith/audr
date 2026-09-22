"""Thread-safe handoff from Relay's subscriber worker to the SDK event loop."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from enum import StrEnum
from threading import Lock

from audr import AUDR, Client, SubmitOutcome


class HandoffOutcome(StrEnum):
    """The immediate outcome of handing one record to the client's event loop."""

    SCHEDULED = "scheduled"
    DROPPED_HANDOFF_FULL = "dropped_handoff_full"
    DROPPED_LOOP_UNAVAILABLE = "dropped_loop_unavailable"


class EventLoopBridge:
    """Move records from Relay's worker thread onto the client's event loop.

    Relay dispatches subscriber callbacks on its own threads, and
    ``Client.record`` must run on the loop that owns the delivery
    pipeline. Handoffs are bounded and non-blocking: a full bridge drops rather
    than back-pressuring Relay's dispatcher.
    """

    def __init__(
        self,
        *,
        client: Client,
        loop: asyncio.AbstractEventLoop,
        max_pending: int,
        on_result: Callable[[SubmitOutcome | None, str], None],
    ) -> None:
        self._client = client
        self._loop = loop
        self._max_pending = max_pending
        self._on_result = on_result
        self._lock = Lock()
        self._pending = 0
        self._drained: asyncio.Future[None] | None = None

    def submit(self, record: AUDR, event_id: str) -> HandoffOutcome:
        """Schedule one record for the client's loop and return immediately."""
        with self._lock:
            if self._pending >= self._max_pending:
                return HandoffOutcome.DROPPED_HANDOFF_FULL
            self._pending += 1
        try:
            self._loop.call_soon_threadsafe(self._submit_to_client, record, event_id)
        except RuntimeError:
            # The loop is closed, so no drain can be awaited on it either.
            with self._lock:
                self._pending -= 1
            return HandoffOutcome.DROPPED_LOOP_UNAVAILABLE
        return HandoffOutcome.SCHEDULED

    async def drain(self, timeout: float | None) -> None:
        """Wait until every accepted handoff has called the client.

        Must be awaited on the client's loop. Concurrent callers share one
        waiter, and cancelling the await leaves the bridge usable.
        """
        with self._lock:
            if self._pending == 0:
                return
            waiter = self._drained
            if waiter is None or waiter.done():
                waiter = self._loop.create_future()
                self._drained = waiter
        try:
            await asyncio.wait_for(asyncio.shield(waiter), timeout)
        except TimeoutError:
            raise TimeoutError("NeMo Relay integration drain timed out") from None

    def _submit_to_client(self, record: AUDR, event_id: str) -> None:
        try:
            result = self._client.record(record)
        except Exception:
            self._on_result(None, event_id)
        else:
            self._on_result(result.outcome, event_id)
        finally:
            self._release_pending()

    def _release_pending(self) -> None:
        with self._lock:
            self._pending -= 1
            waiter = self._drained if self._pending == 0 else None
            if waiter is not None:
                self._drained = None
        if waiter is not None and not waiter.done():
            waiter.set_result(None)
