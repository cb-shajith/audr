"""Ingestion tests that talk to a real Chargebee site.

Run with credentials for a non-production site:

    CHARGEBEE_INGEST_URL=https://acme-test.ingest.chargebee.com \
    CHARGEBEE_API_KEY=... \
    CHARGEBEE_TEST_SUBSCRIPTION_ID=sub_123 \
    uv run pytest -m live

The batch endpoint answers 202 when it accepted everything, 207 when it accepted
some, and 400 when it accepted nothing. It does not say *why* it rejected a
record, so these tests assert on the rejected identifiers and leave the
reasoning to the client-side validation this sink already applies.
"""

import time
from uuid import uuid4

import httpx
import pytest
from audr import (
    AgentUsageRecord,
    Attribution,
    BatchOutcome,
    Client,
    Cost,
    Emitter,
    LlmCost,
    LlmUsage,
    Resource,
    Run,
    Timing,
    ToolCost,
    ToolUsage,
    Usage,
)
from audr.testing import make_record

from audr_sink_chargebee import ChargebeeSink

pytestmark = pytest.mark.live


def _record(subscription_id: str) -> AgentUsageRecord:
    return make_record(
        attribution=Attribution(environment="test", subscription_id=subscription_id),
        run=Run(run_id=str(uuid4()), span_id=uuid4().hex),
    )


async def test_sender_delivers_a_batch_to_the_live_site(
    live_ingest_url: str, live_api_key: str, live_subscription_id: str
) -> None:
    sink = ChargebeeSink(ingest_url=live_ingest_url, api_key=live_api_key)
    batch = [_record(live_subscription_id) for _ in range(3)]

    try:
        result = await sink.deliver(batch)
    finally:
        await sink.close()

    assert result.outcome is BatchOutcome.ACCEPTED, result.detail
    assert result.rejected == ()
    assert result.unknown == ()


async def test_client_records_and_flushes_to_the_live_site(
    live_ingest_url: str, live_api_key: str, live_subscription_id: str
) -> None:
    async with Client(
        ChargebeeSink(ingest_url=live_ingest_url, api_key=live_api_key),
        emitter=Emitter(component="harness", name="audr-live-test", version="0.1.0"),
        linger_seconds=0.1,
    ) as client:
        results = [client.record(_record(live_subscription_id)) for _ in range(5)]
        assert all(result.queued for result in results)
        await client.flush(timeout=30.0)

    stats = client.stats
    assert stats.sent == 5, f"dropped={stats.dropped} batches={stats.batches}"
    assert stats.dropped == 0


async def test_client_ingests_full_audr_field_matrix(
    live_ingest_url: str,
    live_api_key: str,
    live_subscription_id: str,
) -> None:
    async with Client(
        ChargebeeSink(ingest_url=live_ingest_url, api_key=live_api_key),
        emitter=Emitter(component="harness", name="audr-live-test", version="0.1.0"),
        linger_seconds=0.1,
    ) as client:
        records = _build_full_audr_records(live_subscription_id)
        results = [client.record(record) for record in records]
        assert all(result.queued for result in results)
        await client.flush(timeout=30.0)

    assert client.stats.sent == len(records)
    assert client.stats.dropped == 0


def _build_full_audr_records(subscription_id: str) -> list[AgentUsageRecord]:
    inference = AgentUsageRecord(
        emitter=Emitter(component="harness", name="audr-live-test", version="0.1.0"),
        timing=Timing(duration_ms=321),
        resource=Resource(
            provider="openai",
            type="model",
            name="gpt-5",
            operation="generation",
            modality="text",
            key_name="live-test-key-label",
            region="us-east-1",
            deployment="AWS",
        ),
        usage=Usage(
            llm=LlmUsage(  # type: ignore[call-arg]  # x_* extension kwarg; extra="allow" without the pydantic mypy plugin
                input_tokens=120,
                output_tokens=34,
                cache_read_tokens=10,
                cache_write_tokens=5,
                reasoning_tokens=7,
                requests=1,
                images_processed=2,
                audio_input_seconds=1.5,
                audio_output_seconds=2.5,
                x_openai_batches=1,
            )
        ),
        run=Run(
            run_id=str(uuid4()),
            name="AUDR live model run",
            span_id=uuid4().hex,
            parent_span_id=uuid4().hex,
            step=2,
            trace_id=uuid4().hex,
            run_type="agent_run",
            error_code="PROVIDER_5XX",
            error_reason="provider unavailable",
            outcome="failed",
        ),
        attribution=Attribution(
            environment="test",
            account_id="account-live-test",
            subscription_id=subscription_id,
            user_id="usr-live-test",
            labels={"suite": "audr"},
        ),
        cost=Cost(
            total_cost=0.12,
            currency="USD",
            llm=LlmCost(
                total_token_cost=0.15,
                input_token_cost=0.05,
                output_token_cost=0.06,
                cache_read_cost=0.01,
                cache_write_cost=0.02,
                reasoning_cost=0.01,
            ),
            original_cost=0.15,
            discount_amount=0.03,
            discount_percent=20,
        ),
    )
    tool = AgentUsageRecord(
        emitter=Emitter(component="harness", name="audr-live-test", version="0.1.0"),
        timing=Timing(duration_ms=654),
        resource=Resource(
            provider="self-hosted",
            type="tool",
            name="search_tickets",
            operation="retrieval",
            key_name="live-test-tool-label",
            region="eu-central-1",
            deployment="self-hosted",
        ),
        usage=Usage(
            tool=ToolUsage(  # type: ignore[call-arg]  # x_* extension kwarg; extra="allow" without the pydantic mypy plugin
                type="retrieval",
                call_count=2,
                sandbox_time=7500,
                x_cache_hits=11,
            )
        ),
        run=Run(run_id=str(uuid4()), span_id=uuid4().hex, run_type="workflow"),
        attribution=Attribution(
            environment="test",
            subscription_id=subscription_id,
            labels={"suite": "audr"},
        ),
        cost=Cost(
            total_cost=0.7,
            currency="USD",
            tool=ToolCost(
                type="retrieval",
                call_cost=0.2,
                sandbox_cost=0.5,
            ),
            original_cost=0.7,
            discount_amount=0,
            discount_percent=0,
        ),
    )
    return [inference, tool]


@pytest.mark.parametrize(
    ("label", "properties"),
    [
        ("reserved name", {"subscription_id": "reserved-name"}),
        ("nested object", {"nested": {"inner_key": 1}}),
        ("array value", {"tags": ["a", "b"]}),
    ],
)
async def test_live_site_still_refuses_what_this_sink_refuses_to_build(
    live_ingest_url: str,
    live_api_key: str,
    live_subscription_id: str,
    label: str,
    properties: dict[str, object],
) -> None:
    """Guard against our client-side rules drifting looser than the destination.

    This sink will not build any of these event bodies, so they are posted
    directly. A 2xx here means the destination started accepting a shape we
    reject, and the sink's validation should be relaxed to match.
    """
    body = {
        "events": [
            {
                "subscription_id": live_subscription_id,
                "usage_timestamp": int(time.time() * 1000),
                "deduplication_id": str(uuid4()),
                "properties": properties,
            }
        ]
    }

    async with httpx.AsyncClient(timeout=30.0) as http:
        response = await http.post(
            f"{live_ingest_url.rstrip('/')}/api/v2/batch/usage_events",
            json=body,
            auth=(live_api_key, ""),
        )

    assert response.status_code >= 400, label
