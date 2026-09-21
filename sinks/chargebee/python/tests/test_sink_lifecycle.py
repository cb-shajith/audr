import logging

import httpx
import pytest
from audr import AUDR, Attribution, BatchOutcome
from audr.testing import make_record

from audr_sink_chargebee import ChargebeeSink


class FailingCloseTransport(httpx.AsyncBaseTransport):
    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        return httpx.Response(202, request=request)

    async def aclose(self) -> None:
        raise RuntimeError("close failed")


def _record() -> AUDR:
    return make_record(attribution=Attribution(environment="test", subscription_id="sub_1"))


def test_sender_construction_needs_no_event_loop_and_repr_is_safe() -> None:
    sink = ChargebeeSink(ingest_url="https://acme.ingest.chargebee.com", api_key="sk_live_secret")

    assert "acme" in repr(sink)
    assert "sk_live_secret" not in repr(sink)


async def test_close_is_terminal_and_idempotent() -> None:
    requests = 0

    async def handler(_: httpx.Request) -> httpx.Response:
        nonlocal requests
        requests += 1
        return httpx.Response(202)

    sink = ChargebeeSink(
        ingest_url="https://acme.ingest.chargebee.com",
        api_key="test_key",
        transport=httpx.MockTransport(handler),
    )
    await sink.deliver([_record()])
    await sink.close()
    await sink.close()

    result = await sink.deliver([_record()])

    assert requests == 1
    assert result.outcome is BatchOutcome.CLOSED


async def test_close_failure_is_logged_and_swallowed(caplog: pytest.LogCaptureFixture) -> None:
    sink = ChargebeeSink(
        ingest_url="https://acme.ingest.chargebee.com",
        api_key="test_key",
        transport=FailingCloseTransport(),
    )
    await sink.deliver([_record()])

    with caplog.at_level(logging.ERROR):
        await sink.close()

    assert "Failed to close Chargebee usage sink" in caplog.text
