"""Delivery paths where the destination's answer is partial, hostile or absent.

The rule these all serve: a record may be reported `sent` only when Chargebee said so.
Anything else is `rejected` (definitively refused) or `unknown` (replay is safe because
`record_id` is the deduplication key). Guessing in either direction produces a billing
discrepancy nobody can reconstruct later.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Coroutine

import httpx
import pytest
from audr import AgentUsageRecord, Attribution, BatchOutcome
from audr.testing import make_record

from audr_sink_chargebee import ChargebeeSink


def _record(**overrides: object) -> AgentUsageRecord:
    overrides.setdefault("attribution", Attribution(environment="test", subscription_id="sub_test"))
    return make_record(**overrides)


def _sink(
    handler: Callable[[httpx.Request], Coroutine[None, None, httpx.Response]],
) -> ChargebeeSink:
    return ChargebeeSink(
        ingest_url="https://acme.ingest.chargebee.com",
        api_key="test_key",
        transport=httpx.MockTransport(handler),
    )


def _responding(response: httpx.Response) -> ChargebeeSink:
    async def handler(_: httpx.Request) -> httpx.Response:
        return response

    return _sink(handler)


# --- records the sink refuses before any request ------------------------------------


async def test_a_record_that_cannot_be_encoded_is_rejected_without_losing_the_batch() -> None:
    """One bad record must not cost the batch; it comes back named."""
    requests: list[httpx.Request] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(202)

    good = _record()
    # Chargebee bounds `subscription_id`; an over-long one fails envelope validation.
    bad = _record(
        attribution=Attribution(environment="test", subscription_id="s" * 500),
    )
    sink = _sink(handler)

    result = await sink.deliver([good, bad])
    await sink.close()

    assert result.outcome is BatchOutcome.ACCEPTED
    assert [r.record_id for r in result.rejected] == [bad.record_id]
    assert "subscription_id" in str(result.rejected[0].detail)
    assert len(requests) == 1  # the good record still went


async def test_a_batch_of_only_unencodable_records_makes_no_request() -> None:
    async def handler(_: httpx.Request) -> httpx.Response:
        pytest.fail("no request should be made when nothing is encodable")

    bad = _record(attribution=Attribution(environment="test", subscription_id="s" * 500))
    sink = _sink(handler)

    result = await sink.deliver([bad])
    await sink.close()

    assert result.outcome is BatchOutcome.ACCEPTED
    assert [r.record_id for r in result.rejected] == [bad.record_id]


async def test_delivering_to_a_closed_sink_reports_closed() -> None:
    sink = _responding(httpx.Response(202))
    await sink.close()

    result = await sink.deliver([_record()])

    assert result.outcome is BatchOutcome.CLOSED


async def test_a_sink_closed_mid_flight_reports_closed_not_a_transport_failure(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Closing during shutdown races an in-flight POST; that is a closed sink,
    not a delivery failure the caller should retry against a dead client."""
    sink: ChargebeeSink | None = None

    async def handler(_: httpx.Request) -> httpx.Response:
        assert sink is not None
        await sink.close()
        raise RuntimeError("cannot send a request, as the client has been closed")

    sink = _sink(handler)

    with caplog.at_level(logging.WARNING):
        result = await sink.deliver([_record()])

    assert result.outcome is BatchOutcome.CLOSED
    assert "sink is closed" in caplog.text


# --- 413 -----------------------------------------------------------------------------


async def test_413_fails_the_batch_permanently_and_says_how_to_fix_it(
    caplog: pytest.LogCaptureFixture,
) -> None:
    sink = _responding(httpx.Response(413))

    with caplog.at_level(logging.WARNING):
        result = await sink.deliver([_record(), _record()])
    await sink.close()

    assert result.outcome is BatchOutcome.PERMANENT_FAILURE
    assert result.detail == "payload_too_large"
    assert "batch_max_size" in caplog.text  # the caller's actual lever


async def test_413_is_not_retried() -> None:
    attempts = 0

    async def handler(_: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        return httpx.Response(413)

    sink = _sink(handler)

    await sink.deliver([_record()])
    await sink.close()

    assert attempts == 1


# --- 207 bodies the destination should not send, but might ---------------------------


async def test_a_failed_event_that_is_not_an_object_makes_the_batch_unknown(
    caplog: pytest.LogCaptureFixture,
) -> None:
    record = _record()
    sink = _responding(httpx.Response(207, json={"failed_events": ["not-an-object"]}))

    with caplog.at_level(logging.WARNING):
        result = await sink.deliver([record])
    await sink.close()

    assert result.rejected == ()
    assert result.unknown == (record.record_id,)
    assert "unattributable" in caplog.text


async def test_a_failed_event_with_a_non_string_id_makes_the_batch_unknown() -> None:
    record = _record()
    sink = _responding(httpx.Response(207, json={"failed_events": [{"deduplication_id": 42}]}))

    result = await sink.deliver([record])
    await sink.close()

    assert result.rejected == ()
    assert result.unknown == (record.record_id,)


async def test_the_same_id_rejected_twice_is_counted_once_and_flags_the_rest() -> None:
    """A duplicated rejection cannot be matched to a second record, so the
    remaining records lose their verdict and must be reported unknown."""
    first, second = _record(), _record()
    sink = _responding(
        httpx.Response(
            207,
            json={
                "failed_events": [
                    {"deduplication_id": first.record_id, "api_error_code": "bad"},
                    {"deduplication_id": first.record_id, "api_error_code": "bad"},
                ]
            },
        )
    )

    result = await sink.deliver([first, second])
    await sink.close()

    assert [r.record_id for r in result.rejected] == [first.record_id]
    assert result.unknown == (second.record_id,)


async def test_a_rejection_with_no_recognised_code_field_still_rejects_the_record() -> None:
    record = _record()
    sink = _responding(
        httpx.Response(
            207,
            json={"failed_events": [{"deduplication_id": record.record_id, "note": "nope"}]},
        )
    )

    result = await sink.deliver([record])
    await sink.close()

    assert [(r.record_id, r.detail) for r in result.rejected] == [(record.record_id, None)]


@pytest.mark.parametrize(
    ("field", "value"),
    [("api_error_code", "a"), ("error_code", "b"), ("code", "c")],
)
async def test_the_first_recognised_error_code_field_becomes_the_detail(
    field: str, value: str
) -> None:
    record = _record()
    sink = _responding(
        httpx.Response(
            207,
            json={"failed_events": [{"deduplication_id": record.record_id, field: value}]},
        )
    )

    result = await sink.deliver([record])
    await sink.close()

    assert result.rejected[0].detail == value


async def test_an_unexpected_runtime_error_is_not_disguised_as_a_closed_sink() -> None:
    """Only a RuntimeError raised *because* the client was closed means `closed`.

    Swallowing any other RuntimeError as `closed` would tell the pipeline to stop
    rather than report the records unresolved.
    """

    async def handler(_: httpx.Request) -> httpx.Response:
        raise RuntimeError("something else entirely")

    sink = _sink(handler)

    with pytest.raises(RuntimeError, match="something else entirely"):
        await sink.deliver([_record()])

    await sink.close()
