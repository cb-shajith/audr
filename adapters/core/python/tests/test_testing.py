"""`audr.testing` is public API: third-party sink authors run it to prove conformance.

Every rule `assert_sink_contract` enforces is tested here against a sink that breaks
exactly that rule, because a harness that silently stopped detecting a breach would
pass every other test in this suite while certifying broken sinks.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import cast

import pytest

from audr.record import AgentUsageRecord
from audr.sinks import BatchOutcome, BatchResult, RejectedRecord, Sink
from audr.testing import MemorySink, assert_sink_contract, make_record


class _Conforming:
    """A minimal sink that honours the contract; subclasses break one rule each."""

    def __init__(self) -> None:
        self.closed = False
        self.close_calls = 0
        self.delivered: list[Sequence[AgentUsageRecord]] = []

    async def deliver(self, batch: Sequence[AgentUsageRecord]) -> BatchResult:
        self.delivered.append(batch)
        if self.closed:
            return BatchResult.closed()
        return BatchResult.accepted()

    async def close(self) -> None:
        self.close_calls += 1
        self.closed = True


def test_make_record_is_valid() -> None:
    assert make_record().validate() == []


def test_make_record_overrides() -> None:
    assert make_record(corrects="01J8ZQ8Y2K3M4N5P6Q7R8S9T0V").corrects is not None


def test_memory_sink_rejects_accepted_as_fail_with() -> None:
    with pytest.raises(ValueError):
        MemorySink(fail_with=BatchOutcome.ACCEPTED)  # type: ignore[arg-type]


# --- sinks that satisfy the contract ------------------------------------------------


async def test_memory_sink_passes_contract() -> None:
    await assert_sink_contract(MemorySink())


async def test_a_conforming_sink_passes_and_is_closed_by_the_harness() -> None:
    sink = _Conforming()

    await assert_sink_contract(sink)

    assert sink.closed
    assert sink.close_calls == 2  # idempotence is checked, not assumed


async def test_the_harness_delivers_the_caller_supplied_records() -> None:
    sink = _Conforming()
    records = (make_record(), make_record())

    await assert_sink_contract(sink, records=records)

    assert [tuple(batch) for batch in sink.delivered] == [records, records]


async def test_a_sink_that_keeps_working_after_close_is_allowed() -> None:
    """`deliver()` after `close()` may return ACCEPTED, not only CLOSED."""

    class _StillWorks(_Conforming):
        async def deliver(self, batch: Sequence[AgentUsageRecord]) -> BatchResult:
            return BatchResult.accepted()

    await assert_sink_contract(_StillWorks())


# --- one rule broken per sink -------------------------------------------------------


async def test_an_object_that_is_not_a_sink_is_rejected() -> None:
    with pytest.raises(AssertionError, match="must satisfy the Sink protocol"):
        await assert_sink_contract(cast(Sink, object()))


async def test_a_deliver_that_does_not_return_a_batch_result_is_rejected() -> None:
    class _WrongType(_Conforming):
        async def deliver(self, batch: Sequence[AgentUsageRecord]) -> BatchResult:
            return cast(BatchResult, {"outcome": "accepted"})

    with pytest.raises(AssertionError, match=r"must return a BatchResult, got dict"):
        await assert_sink_contract(_WrongType())


async def test_an_unknown_id_absent_from_the_batch_is_rejected() -> None:
    class _ForeignUnknown(_Conforming):
        async def deliver(self, batch: Sequence[AgentUsageRecord]) -> BatchResult:
            return BatchResult.accepted(unknown=["never-in-batch"])

    with pytest.raises(AssertionError, match=r"absent from the batch.*never-in-batch"):
        await assert_sink_contract(_ForeignUnknown())


async def test_a_rejected_id_absent_from_the_batch_is_rejected() -> None:
    class _ForeignRejection(_Conforming):
        async def deliver(self, batch: Sequence[AgentUsageRecord]) -> BatchResult:
            return BatchResult.accepted(rejected=[RejectedRecord("never-in-batch", "nope")])

    with pytest.raises(AssertionError, match=r"absent from the batch.*never-in-batch"):
        await assert_sink_contract(_ForeignRejection())


async def test_an_id_in_both_rejected_and_unknown_is_rejected() -> None:
    class _DoubleReported(_Conforming):
        async def deliver(self, batch: Sequence[AgentUsageRecord]) -> BatchResult:
            identifier = batch[0].record_id
            return BatchResult.accepted(
                rejected=[RejectedRecord(identifier, "dup")],
                unknown=[identifier],
            )

    with pytest.raises(AssertionError, match="both rejected and unknown"):
        await assert_sink_contract(_DoubleReported())


async def test_a_close_that_raises_on_the_first_call_is_rejected() -> None:
    class _CloseRaises(_Conforming):
        async def close(self) -> None:
            raise RuntimeError("connection reset")

    with pytest.raises(AssertionError, match=r"idempotent.*call 1 raised RuntimeError"):
        await assert_sink_contract(_CloseRaises())


async def test_a_close_that_raises_only_on_the_second_call_is_rejected() -> None:
    """The common bug: `close()` works once, then trips over its own torn-down state."""

    class _NotIdempotent(_Conforming):
        async def close(self) -> None:
            if self.closed:
                raise RuntimeError("already closed")
            self.closed = True

    with pytest.raises(AssertionError, match=r"idempotent.*call 2 raised RuntimeError"):
        await assert_sink_contract(_NotIdempotent())


async def test_a_sink_that_fails_instead_of_reporting_closed_is_rejected() -> None:
    class _FailsAfterClose(_Conforming):
        async def deliver(self, batch: Sequence[AgentUsageRecord]) -> BatchResult:
            if self.closed:
                return BatchResult.failed(retryable=True)
            return BatchResult.accepted()

    with pytest.raises(AssertionError, match=r"after close\(\) must return BatchOutcome.CLOSED"):
        await assert_sink_contract(_FailsAfterClose())


# --- MemorySink itself --------------------------------------------------------------


async def test_memory_sink_records_accepted_and_reports_rejected() -> None:
    kept, dropped = make_record(), make_record()
    sink = MemorySink(reject=lambda r: "nope" if r.record_id == dropped.record_id else None)

    result = await sink.deliver([kept, dropped])

    assert result.outcome is BatchOutcome.ACCEPTED
    assert [r.record_id for r in sink.records] == [kept.record_id]
    assert [r.record_id for r in result.rejected] == [dropped.record_id]
    assert sink.batches == 1


@pytest.mark.parametrize(
    ("fail_with", "expected"),
    [
        (BatchOutcome.RETRYABLE_FAILURE, BatchOutcome.RETRYABLE_FAILURE),
        (BatchOutcome.PERMANENT_FAILURE, BatchOutcome.PERMANENT_FAILURE),
        (BatchOutcome.CLOSED, BatchOutcome.CLOSED),
    ],
)
async def test_memory_sink_fail_with_short_circuits_before_recording(
    fail_with: BatchOutcome, expected: BatchOutcome
) -> None:
    sink = MemorySink(fail_with=fail_with)  # type: ignore[arg-type]

    result = await sink.deliver([make_record()])

    assert result.outcome is expected
    assert sink.records == []
    assert sink.batches == 0


async def test_memory_sink_reports_closed_after_close() -> None:
    sink = MemorySink()
    await sink.close()

    result = await sink.deliver([make_record()])

    assert result.outcome is BatchOutcome.CLOSED
    assert sink.records == []
