"""The entry point callers use to record AUDR usage events."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable, Mapping
from datetime import datetime
from types import TracebackType
from typing import Any

from audr._pipeline import Pipeline
from audr.errors import ConfigurationError, LifecycleError, ValidationError
from audr.record import AUDR, Emitter
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
from audr.sinks import Sink

_LOGGER = logging.getLogger("audr.client")

_DEFAULT_MAX_QUEUE_SIZE = 1000
_DEFAULT_BATCH_MAX_SIZE = 50
_DEFAULT_LINGER_SECONDS = 5.0
_MAX_BATCH_MAX_SIZE = 500


class Client:
    """Record AUDR usage events onto a background delivery pipeline.

    The common path is ``async with Client(sink) as client: client.record(...)``.
    ``record()`` lazily starts the pipeline on first use and must be called on the
    thread that runs the event loop.

    ``sink`` is required: this package implements the AUDR standard and has no
    destination of its own. Credentials, transport and retry policy belong to the
    sink, never to the client.

    ``shutdown()`` closes the sink, including one you supplied. Pass
    ``owns_sink=False`` if the sink outlives this client. Closing is idempotent.

    ``on_delivered`` fires once per accepted batch, synchronously, with the records
    the sink actually accepted in that batch; records the sink rejected or reported
    unknown are excluded from ``on_delivered`` and reported to ``on_failure`` instead.
    """

    def __init__(
        self,
        sink: Sink,
        *,
        emitter: Emitter | None = None,
        owns_sink: bool = True,
        max_queue_size: int = _DEFAULT_MAX_QUEUE_SIZE,
        batch_max_size: int = _DEFAULT_BATCH_MAX_SIZE,
        linger_seconds: float = _DEFAULT_LINGER_SECONDS,
        on_failure: FailureCallback | None = None,
        on_delivered: DeliveredCallback | None = None,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        if not isinstance(sink, Sink):
            raise ConfigurationError("sink must satisfy the Sink protocol (deliver, close)")
        if max_queue_size < 1:
            raise ConfigurationError("max_queue_size must be >= 1")
        if not (1 <= batch_max_size <= _MAX_BATCH_MAX_SIZE):
            raise ConfigurationError(f"batch_max_size must be between 1 and {_MAX_BATCH_MAX_SIZE}")
        if linger_seconds < 0:
            raise ConfigurationError("linger_seconds must be >= 0")

        self._emitter = emitter
        self._clock = clock
        self._on_failure = on_failure
        self._pipeline = Pipeline(
            sink,
            max_queue_size=max_queue_size,
            batch_max_size=batch_max_size,
            linger_seconds=linger_seconds,
            owns_sink=owns_sink,
            on_failure=on_failure,
            on_delivered=on_delivered,
        )
        self._shutdown_done = False
        self._in_context = False

    @property
    def stats(self) -> DeliveryStats:
        """Return an immutable snapshot of background delivery counters."""
        return self._pipeline.stats

    async def start(self) -> None:
        """Start the delivery worker. Idempotent; also done lazily by `record()`."""
        self._ensure_started()

    def record(self, record: AUDR | Mapping[str, Any]) -> SubmitResult:
        """Queue one record and return immediately; the worker performs all I/O.

        Delivery problems are reported through the returned :class:`SubmitResult`,
        the failure callback, and :attr:`stats`; they never raise. The one
        exception is a wiring error: calling ``record()`` with no running event
        loop on the current thread raises :class:`LifecycleError`, because the
        record could never be delivered.

        A mapping that fails to parse into an :class:`~audr.record.AUDR`
        has no record object to hand the failure callback, so `on_failure` is only
        called when a record instance exists.
        """
        if self._shutdown_done:
            return SubmitResult(SubmitOutcome.DROPPED_NOT_RUNNING)

        self._ensure_started()

        if isinstance(record, AUDR):
            model = record
        else:
            try:
                model = AUDR.from_dict(record)
            except ValidationError as error:
                _LOGGER.warning("record rejected: invalid mapping")
                return SubmitResult(SubmitOutcome.REJECTED_INVALID, issues=error.issues)

        if model.emitter is None and self._emitter is not None:
            model = model.with_emitter(self._emitter)

        now = self._clock() if self._clock is not None else None
        issues = model.validate(now=now)
        if issues:
            _LOGGER.warning("record rejected: failed validation")
            self._notify_failure(model)
            return SubmitResult(SubmitOutcome.REJECTED_INVALID, issues=tuple(issues))

        return self._pipeline.submit(model)

    def _notify_failure(self, record: AUDR) -> None:
        if self._on_failure is None:
            return
        failure = FailedRecord(
            record=record,
            disposition=Disposition.DROPPED,
            reason=FailureReason.INVALID,
            retryable=False,
        )
        try:
            self._on_failure(failure)
        except Exception:
            _LOGGER.warning("failure callback raised")

    def _ensure_started(self) -> None:
        if self._shutdown_done or self._pipeline.running:
            return
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            raise LifecycleError(
                "Client.record() must be called on the thread running the event loop"
            ) from None
        self._pipeline.start()

    async def flush(self, timeout: float | None = None) -> bool:
        """Deliver queued work now, waiting up to `timeout` seconds (default 30).

        Returns True when every record queued before the call reached a terminal
        state, False when the bound expired first. Records still queued when the
        bound expires remain queued, and the client remains usable.
        """
        return await self._pipeline.flush(timeout)

    async def shutdown(self, timeout: float | None = None) -> None:
        """Stop accepting records, drain bounded work, then close the sink.

        Work still queued when `timeout` expires is dropped and reported to the
        failure callback. The sink is closed even when the caller supplied it: an
        open connection pool leaks silently, while a second close is idempotent.
        Opt out with `owns_sink=False`.
        """
        if self._shutdown_done:
            return
        self._shutdown_done = True
        await self._pipeline.stop(timeout)

    async def __aenter__(self) -> Client:
        if self._in_context:
            raise LifecycleError("Client context manager does not support nesting or re-entry")
        if self._shutdown_done:
            raise LifecycleError("Client cannot be entered after shutdown")
        self._ensure_started()
        self._in_context = True
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        self._in_context = False
        try:
            await self.shutdown()
        except asyncio.CancelledError:
            raise
        except BaseException:
            if exc_type is None:
                raise
            _LOGGER.exception("failed to shut down Client during context exit")
        return None


__all__ = ["Client"]
