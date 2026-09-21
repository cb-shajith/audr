"""Client lifecycle edges: re-entry, double shutdown, and failures during exit.

`__aexit__` runs while an exception may already be unwinding. Losing that exception
to a shutdown problem would hide the application's real error behind a delivery one,
so which exception escapes is part of the contract.
"""

from __future__ import annotations

import asyncio
import logging

import pytest

from audr import Client, FailedRecord, LifecycleError, SubmitOutcome
from audr.testing import MemorySink, make_record


async def test_shutdown_is_idempotent() -> None:
    sink = MemorySink()
    client = Client(sink)
    await client.start()

    await client.shutdown(timeout=1)
    await client.shutdown(timeout=1)  # must not re-close or raise

    assert sink.closed


async def test_context_manager_does_not_nest() -> None:
    client = Client(MemorySink())
    async with client:
        with pytest.raises(LifecycleError, match="nesting or re-entry"):
            async with client:
                pass


async def test_context_manager_cannot_be_entered_after_shutdown() -> None:
    client = Client(MemorySink())
    await client.start()
    await client.shutdown(timeout=1)

    with pytest.raises(LifecycleError, match="cannot be entered after shutdown"):
        async with client:
            pass


async def test_a_second_entry_after_a_clean_exit_is_refused() -> None:
    """Exiting the block shuts the client down; it is not a reusable resource."""
    client = Client(MemorySink())
    async with client:
        pass

    with pytest.raises(LifecycleError, match="cannot be entered after shutdown"):
        async with client:
            pass


async def test_cancellation_during_exit_propagates(monkeypatch: pytest.MonkeyPatch) -> None:
    client = Client(MemorySink())

    async def cancelled(_timeout: float | None = None) -> None:
        raise asyncio.CancelledError

    with pytest.raises(asyncio.CancelledError):
        async with client:
            monkeypatch.setattr(client._pipeline, "stop", cancelled)


async def test_shutdown_failure_during_a_clean_exit_propagates(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = Client(MemorySink())

    async def explode(_timeout: float | None = None) -> None:
        raise RuntimeError("sink teardown failed")

    with pytest.raises(RuntimeError, match="sink teardown failed"):
        async with client:
            monkeypatch.setattr(client._pipeline, "stop", explode)


async def test_the_body_exception_wins_over_a_shutdown_failure(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    client = Client(MemorySink())

    async def explode(_timeout: float | None = None) -> None:
        raise RuntimeError("sink teardown failed")

    with caplog.at_level(logging.ERROR, logger="audr.client"):
        with pytest.raises(ValueError, match="what the application got wrong"):
            async with client:
                monkeypatch.setattr(client._pipeline, "stop", explode)
                raise ValueError("what the application got wrong")

    assert "failed to shut down Client during context exit" in caplog.text
    assert "sink teardown failed" in caplog.text


async def test_a_failure_callback_that_raises_does_not_break_record() -> None:
    def explode(_failure: FailedRecord) -> None:
        raise RuntimeError("callback is buggy")

    async with Client(MemorySink(), on_failure=explode, batch_max_size=1) as client:
        # No emitter anywhere, so this is rejected and the callback fires.
        rejected = client.record(make_record(emitter=None))
        assert rejected.outcome is SubmitOutcome.REJECTED_INVALID

        # The client is still usable afterwards.
        assert client.record(make_record()).queued


async def test_an_invalid_record_without_a_failure_callback_is_reported_by_return_value() -> None:
    async with Client(MemorySink()) as client:
        result = client.record(make_record(emitter=None))

    assert result.outcome is SubmitOutcome.REJECTED_INVALID
    assert [issue.path for issue in result.issues] == ["/emitter"]
