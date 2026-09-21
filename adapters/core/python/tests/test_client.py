import inspect
from collections.abc import Sequence

import pytest

from audr import Client, ConfigurationError, Emitter, FailedRecord, LifecycleError, SubmitOutcome
from audr.record import AUDR
from audr.record.codes import ErrorCode
from audr.testing import MemorySink, make_record


def test_record_outside_loop_raises() -> None:
    c = Client(MemorySink())
    with pytest.raises(LifecycleError):
        c.record(make_record())


def test_bad_config() -> None:
    with pytest.raises(ConfigurationError):
        Client(MemorySink(), batch_max_size=0)
    with pytest.raises(ConfigurationError):
        Client(object())  # type: ignore[arg-type]


def test_bad_config_queue_size_and_linger() -> None:
    with pytest.raises(ConfigurationError):
        Client(MemorySink(), max_queue_size=0)
    with pytest.raises(ConfigurationError):
        Client(MemorySink(), linger_seconds=-1)


def test_default_arguments_are_pinned() -> None:
    defaults = {
        name: param.default
        for name, param in inspect.signature(Client.__init__).parameters.items()
        if param.default is not inspect.Parameter.empty
    }
    assert defaults == {
        "emitter": None,
        "owns_sink": True,
        "max_queue_size": 1000,
        "batch_max_size": 50,
        "linger_seconds": 5.0,
        "on_failure": None,
        "on_delivered": None,
        "clock": None,
    }


async def test_lazy_start_and_context_manager() -> None:
    sink = MemorySink()
    emitter = Emitter(component="harness", name="t", version="1")
    async with Client(sink, emitter=emitter, batch_max_size=1) as c:
        r = make_record(emitter=None)
        assert c.record(r).queued
        assert await c.flush(timeout=2)
    assert sink.records[0].emitter == emitter and sink.closed


async def test_invalid_record_is_rejected_not_raised() -> None:
    failed: list[FailedRecord] = []
    async with Client(MemorySink(), on_failure=failed.append) as c:
        # No client emitter either, so this fails validation with REQUIRED /emitter.
        res = c.record(make_record(emitter=None))
        assert res.outcome is SubmitOutcome.REJECTED_INVALID
        assert res.issues[0].code is ErrorCode.REQUIRED
        assert failed and not failed[0].retryable


async def test_mapping_input() -> None:
    async with Client(MemorySink(), batch_max_size=1) as c:
        assert c.record(make_record().to_dict()).queued
        assert c.record({"spec_version": "9.0.0"}).outcome is SubmitOutcome.REJECTED_INVALID


async def test_record_after_shutdown() -> None:
    c = Client(MemorySink())
    await c.start()
    await c.shutdown(timeout=1)
    assert c.record(make_record()).outcome is SubmitOutcome.DROPPED_NOT_RUNNING
    assert c.stats.queue_capacity == 1000


async def test_on_delivered_fires_per_accepted_batch() -> None:
    delivered: list[Sequence[AUDR]] = []
    async with Client(MemorySink(), batch_max_size=2, on_delivered=delivered.append) as c:
        for _ in range(4):
            assert c.record(make_record()).queued
        assert await c.flush(timeout=2)
    assert len(delivered) == 2
    assert sum(len(batch) for batch in delivered) == 4
