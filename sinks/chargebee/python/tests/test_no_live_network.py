import pytest
from audr import Attribution
from audr.testing import make_record

from audr_sink_chargebee import ChargebeeSink


async def test_default_transport_is_blocked_before_any_live_network_access() -> None:
    sink = ChargebeeSink(ingest_url="https://acme.ingest.chargebee.com", api_key="test_key")
    record = make_record(attribution=Attribution(environment="test", subscription_id="sub_123"))

    with pytest.raises(pytest.fail.Exception, match="unexpected real HTTP request"):
        await sink.deliver([record])

    await sink.close()
