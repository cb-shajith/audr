import httpx
import pytest
from audr import AgentUsageRecord, Attribution, BatchOutcome, RejectedRecord
from audr.testing import make_record

from audr_sink_chargebee import ChargebeeSink


def _record(**overrides: object) -> AgentUsageRecord:
    overrides.setdefault("attribution", Attribution(environment="test", subscription_id="sub_test"))
    return make_record(**overrides)


def _build_sink(response: httpx.Response) -> ChargebeeSink:
    async def handler(_: httpx.Request) -> httpx.Response:
        return response

    return ChargebeeSink(
        ingest_url="https://acme.ingest.chargebee.com",
        api_key="test_key",
        transport=httpx.MockTransport(handler),
    )


async def test_sender_correlates_per_record_rejections_by_record_id() -> None:
    first, second = _record(), _record()
    sink = _build_sink(
        httpx.Response(
            207,
            json={
                "failed_events": [{"deduplication_id": second.record_id, "api_error_code": "bad"}]
            },
        )
    )

    result = await sink.deliver([first, second])

    assert result.outcome is BatchOutcome.ACCEPTED
    assert result.rejected == (RejectedRecord(second.record_id, "bad"),)
    assert result.unknown == ()
    await sink.close()


async def test_202_is_full_acceptance_without_parsing_response_body() -> None:
    record = _record()
    for response in (
        httpx.Response(202, content=b"not json"),
        httpx.Response(202, content=b"\xff"),
        httpx.Response(202, json={"failed_events": [{"deduplication_id": "unknown"}]}),
    ):
        sink = _build_sink(response)

        result = await sink.deliver([record])

        assert result.outcome is BatchOutcome.ACCEPTED
        assert result.rejected == ()
        assert result.unknown == ()
        await sink.close()


async def test_207_with_unattributable_rejection_marks_unresolved_records_unknown(
    caplog: pytest.LogCaptureFixture,
) -> None:
    first, second = _record(), _record()
    sink = _build_sink(
        httpx.Response(207, json={"failed_events": [{"deduplication_id": "unknown"}]})
    )

    with caplog.at_level("WARNING"):
        result = await sink.deliver([first, second])

    assert result.outcome is BatchOutcome.ACCEPTED
    assert result.rejected == ()
    assert set(result.unknown) == {first.record_id, second.record_id}
    assert "1 unattributable failed_events rejection(s)" in caplog.text
    await sink.close()


async def test_207_with_known_and_unattributable_rejections_preserves_both_dispositions() -> None:
    first, second = _record(), _record()
    sink = _build_sink(
        httpx.Response(
            207,
            json={
                "failed_events": [
                    {"deduplication_id": second.record_id, "api_error_code": "bad"},
                    {"deduplication_id": "unknown"},
                ]
            },
        )
    )

    result = await sink.deliver([first, second])

    assert result.rejected == (RejectedRecord(second.record_id, "bad"),)
    assert result.unknown == (first.record_id,)
    await sink.close()


async def test_sender_treats_unparseable_or_incomplete_207_as_unknown(
    caplog: pytest.LogCaptureFixture,
) -> None:
    record = _record()
    for response in (
        httpx.Response(207, content=b"not json"),
        httpx.Response(207, content=b"\xff"),
        httpx.Response(207, json={"ok": True}),
    ):
        sink = _build_sink(response)

        with caplog.at_level("WARNING"):
            result = await sink.deliver([record])

        assert result.outcome is BatchOutcome.ACCEPTED
        assert result.rejected == ()
        assert result.unknown == (record.record_id,)
        assert "partial response was unparseable" in caplog.text
        await sink.close()


async def test_sender_reports_permanent_failure_for_other_4xx_status(
    caplog: pytest.LogCaptureFixture,
) -> None:
    sink = _build_sink(httpx.Response(400, json={"error_code": "invalid_request"}))

    with caplog.at_level("WARNING"):
        result = await sink.deliver([_record()])

    assert result.outcome is BatchOutcome.PERMANENT_FAILURE
    assert result.detail == "http_400"
    assert "rejected permanently (status=400)" in caplog.text
    await sink.close()


async def test_sender_reports_auth_failure_without_key_material(
    caplog: pytest.LogCaptureFixture,
) -> None:
    sink = _build_sink(httpx.Response(401, json={"code": "unauthorized"}))

    with caplog.at_level("ERROR"):
        result = await sink.deliver([_record()])

    assert result.outcome is BatchOutcome.PERMANENT_FAILURE
    assert result.detail == "auth"
    assert "test_key" not in str(result)
    assert "test_key" not in caplog.text
    await sink.close()


async def test_sink_attributes_every_batch_record_sharing_a_failed_id() -> None:
    shared_id = "shared-dedup-id"
    first = _record(record_id=shared_id)
    second = _record(record_id=shared_id)
    sink = _build_sink(
        httpx.Response(
            207, json={"failed_events": [{"deduplication_id": shared_id, "api_error_code": "bad"}]}
        )
    )

    result = await sink.deliver([first, second])

    assert result.outcome is BatchOutcome.ACCEPTED
    assert [rejection.record_id for rejection in result.rejected] == [shared_id, shared_id]
    await sink.close()


@pytest.mark.parametrize("status", [200, 204])
async def test_sink_treats_other_2xx_as_permanent_failure(status: int) -> None:
    sink = _build_sink(httpx.Response(status, json={"failed_events": []}))

    result = await sink.deliver([_record()])

    assert result.outcome is BatchOutcome.PERMANENT_FAILURE
    assert result.detail == f"http_{status}"
    await sink.close()
