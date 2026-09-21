import httpx
from audr import Attribution
from audr.testing import assert_sink_contract, make_record

from audr_sink_chargebee import ChargebeeSink


async def test_chargebee_sink_satisfies_the_sink_contract() -> None:
    async def accept_everything(_: httpx.Request) -> httpx.Response:
        # 202 is full acceptance and the sink never parses its body.
        return httpx.Response(202)

    sink = ChargebeeSink(
        ingest_url="https://ingest.example.test",
        api_key="test_key",
        transport=httpx.MockTransport(accept_everything),
    )

    # Records need a subscription_id so they are actually sent, exercising the
    # mocked 202 path rather than being rejected before any request is made.
    records = [
        make_record(attribution=Attribution(environment="test", subscription_id="sub_1"))
        for _ in range(3)
    ]
    await assert_sink_contract(sink, records=records)
