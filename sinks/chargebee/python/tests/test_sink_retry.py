from collections.abc import Callable, Coroutine
from typing import Any

import httpx
import pytest
from audr import AgentUsageRecord, Attribution, BatchOutcome
from audr.testing import make_record

from audr_sink_chargebee import ChargebeeSink, RetryPolicy


def _record() -> AgentUsageRecord:
    return make_record(attribution=Attribution(environment="test", subscription_id="sub_123"))


def _build_sink(
    handler: Callable[[httpx.Request], Coroutine[Any, Any, httpx.Response]],
    sleeps: list[float],
    *,
    max_attempts: int = 3,
) -> ChargebeeSink:
    async def record_sleep(delay: float) -> None:
        sleeps.append(delay)

    return ChargebeeSink(
        ingest_url="https://acme.ingest.chargebee.com",
        api_key="test_key",
        retry=RetryPolicy(max_attempts=max_attempts),
        transport=httpx.MockTransport(handler),
        sleep=record_sleep,
    )


@pytest.mark.parametrize("first_status", [408, 503])
async def test_sender_retries_transient_responses(first_status: int) -> None:
    requests = 0

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal requests
        requests += 1
        if requests == 1:
            return httpx.Response(first_status)
        return httpx.Response(202)

    sleeps: list[float] = []
    sink = _build_sink(handler, sleeps)

    result = await sink.deliver([_record()])

    assert result.outcome is BatchOutcome.ACCEPTED
    assert requests == 2
    assert len(sleeps) == 1
    await sink.close()


@pytest.mark.parametrize("error_type", [httpx.ConnectError, httpx.ReadError])
async def test_sender_retries_network_error_then_succeeds(
    error_type: type[httpx.RequestError],
) -> None:
    requests = 0

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal requests
        requests += 1
        if requests == 1:
            raise error_type("offline", request=request)
        return httpx.Response(202)

    sleeps: list[float] = []
    sink = _build_sink(handler, sleeps)

    result = await sink.deliver([_record()])

    assert result.outcome is BatchOutcome.ACCEPTED
    assert requests == 2
    await sink.close()


async def test_sender_stops_after_transient_attempt_budget() -> None:
    requests = 0

    async def handler(_: httpx.Request) -> httpx.Response:
        nonlocal requests
        requests += 1
        return httpx.Response(503)

    sleeps: list[float] = []
    sink = _build_sink(handler, sleeps)

    result = await sink.deliver([_record()])

    assert result.outcome is BatchOutcome.RETRYABLE_FAILURE
    assert result.detail == "http_503"
    assert requests == 3
    assert len(sleeps) == 2
    await sink.close()


async def test_sender_reports_network_error_type_after_exhausting_retries() -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("offline", request=request)

    sleeps: list[float] = []
    sink = _build_sink(handler, sleeps, max_attempts=2)

    result = await sink.deliver([_record()])

    assert result.outcome is BatchOutcome.RETRYABLE_FAILURE
    assert result.detail == "ConnectError"
    await sink.close()
