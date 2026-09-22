from __future__ import annotations

from audr.sinks import BatchOutcome, BatchResult, RejectedRecord, Sink
from audr.testing import MemorySink, make_record


def test_batch_result_constructors() -> None:
    assert BatchResult.accepted().outcome is BatchOutcome.ACCEPTED
    assert BatchResult.failed(retryable=True).outcome is BatchOutcome.RETRYABLE_FAILURE
    assert BatchResult.failed(retryable=False, detail="auth").detail == "auth"
    assert BatchResult.closed().outcome is BatchOutcome.CLOSED
    r = BatchResult.accepted(rejected=[RejectedRecord("id1", "bad")], unknown=["id2"])
    assert r.rejected[0].record_id == "id1" and r.unknown == ("id2",)


def test_memory_sink_is_a_sink() -> None:
    assert isinstance(MemorySink(), Sink)


async def test_memory_sink_records_and_rejects() -> None:
    sink = MemorySink(reject=lambda r: "nope" if r.run.span_id == "bad" else None)
    bad_run = make_record().run.model_copy(update={"span_id": "bad"})
    good, bad = make_record(), make_record(run=bad_run)
    result = await sink.deliver([good, bad])
    assert result.outcome is BatchOutcome.ACCEPTED and [x.record_id for x in result.rejected] == [
        bad.record_id
    ]
    assert sink.records == [good] and sink.batches == 1


async def test_memory_sink_fail_with_and_close() -> None:
    sink = MemorySink(fail_with=BatchOutcome.PERMANENT_FAILURE)
    assert (await sink.deliver([make_record()])).outcome is BatchOutcome.PERMANENT_FAILURE
    await sink.close()
    await sink.close()
    assert sink.closed and (await sink.deliver([make_record()])).outcome is BatchOutcome.CLOSED
