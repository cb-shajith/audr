# audr-sink-chargebee

[![PyPI](https://img.shields.io/pypi/v/audr-sink-chargebee?include_prereleases)](https://pypi.org/project/audr-sink-chargebee/)

The Chargebee sink for [AUDR](https://openaudr.dev). Delivers `audr.AUDR` record
batches to a site's usage-ingest batch endpoint.

```bash
pip install audr-sink-chargebee
```

```python
import asyncio
import audr
from audr_sink_chargebee import ChargebeeSink

# A full record; construction is documented in the core SDK README:
# https://github.com/openaudr/audr/blob/main/adapters/core/python/README.md
# Chargebee additionally requires attribution.subscription_id.
record = audr.AUDR(...)


async def main() -> None:
    sink = ChargebeeSink(site="acme", api_key="cb_live_...")
    async with audr.Client(
        sink,
        emitter=audr.Emitter(component="harness", name="my-harness", version="1.4.0"),
    ) as client:
        result = client.record(record)
        assert result.queued, result.issues


asyncio.run(main())
```

Every record requires an emitter. Pass `emitter=` to the `Client` as above and it is
stamped onto any record that arrives without one; a record that reaches validation
with no emitter is rejected with a `/emitter` issue and never sent.

The primary configuration is `site` and `api_key`. Each may be passed
explicitly or read from `CHARGEBEE_SITE` and `CHARGEBEE_API_KEY`; explicit
values take precedence over the environment, and `api_key` is always required. `site` is
combined with the ingest domain into
`https://{site}.{ingest_domain}/api/v2/batch/usage_events`, where the domain
defaults to `ingest.chargebee.com` (the official Chargebee batch ingest
domain; the endpoint URL does not vary by site geography). Override the domain with
`CHARGEBEE_INGEST_DOMAIN` or `ingest_domain=` (for example, a test
environment). For hosts other than a `{site}` subdomain of the ingest
domain, `ingest_url=` (or `CHARGEBEE_INGEST_URL`) is a direct override
that sets the full origin; it is mutually exclusive with
`site`/`ingest_domain`. Credentials belong to the sink and never appear in
logs, errors, or `repr()`.

## Routing and delivery

- Chargebee routes on `attribution.subscription_id`. A record with no
  `subscription_id` is never sent; `deliver()` returns it as a
  `RejectedRecord(record_id, "missing_subscription_id")`.
- `record_id` is used as Chargebee's `deduplication_id` and
  `timing.event_time` (as milliseconds) becomes `usage_timestamp`.
- AUDR records are nested; Chargebee's ingest API accepts scalar properties
  only, so the sink flattens every field to reversible names such as
  `usage_llm_input_tokens`. The default separator is `_`; it is
  configurable via `separator=` and must be one or more underscores, since
  Chargebee property names may only contain letters, digits, and
  underscores.
- A batch is sent as one request. If Chargebee refuses it as too large it
  answers `413` and `deliver()` fails the whole batch with
  `detail="payload_too_large"`, dropping every record in it; send fewer
  records per request with `Client(batch_max_size=...)`. That bounds the
  record count, not the byte size — a single record too large on its own
  cannot be delivered.
- When a `207` response body contains a failed event that cannot be matched
  back to a record in the batch (an unrecognized or duplicated
  `deduplication_id`), every non-rejected record in that batch is
  conservatively reported as `unknown` rather than assumed accepted; `record_id`
  makes a replay idempotent.
- HTTP outcomes map onto `audr.BatchResult`: `202`/`207` responses become
  `accepted` (with any `rejected`/`unknown` records named individually), `401`
  fails the batch as `retryable=False, detail="auth"`, `413` fails it as
  `retryable=False, detail="payload_too_large"`, other `4xx` responses
  fail as `retryable=False, detail="http_<status>"`, and `429`/`5xx`/network
  errors fail as `retryable=True` once the retry budget (`RetryPolicy`) is
  exhausted.
- `close()` is idempotent.

## Data handling

This sink flattens and forwards **every field of the record**, including
`attribution.labels` and any `x_*` extension, to your Chargebee site. Delivery is
verbatim, and no downstream component re-checks the record. `attribution.labels`
MUST NOT contain PII and `resource.key_name` is a label, never key material — see
the [security policy](https://github.com/openaudr/audr/blob/main/SECURITY.md) for
the full rules. Enforce them where the record is built — that is the last point at
which they can be enforced.

## Configuration

```python
from audr_sink_chargebee import ChargebeeSink, HttpTransportConfig, RetryPolicy

sink = ChargebeeSink(
    site="acme",
    api_key="...",
    ingest_domain="ingest.chargebee.com",  # optional; this is the default
    retry=RetryPolicy(max_attempts=3),
    http=HttpTransportConfig(read_timeout=10.0),
    separator="_",
)
```

An `ingest_url=` (or `CHARGEBEE_INGEST_URL`) direct override is also available in
place of `site`/`ingest_domain`:

```python
sink = ChargebeeSink(ingest_url="https://acme.ingest.chargebee.com", api_key="...")
```

## Contributing

[`AGENTS.md`](https://github.com/openaudr/audr/blob/main/sinks/chargebee/python/AGENTS.md)
records how to work inside this package — its layout, its invariants, and its commands.
[`sinks/CONTRIBUTING.md`](https://github.com/openaudr/audr/blob/main/sinks/CONTRIBUTING.md)
describes how to contribute a sink, and the top-level
[`CONTRIBUTING.md`](https://github.com/openaudr/audr/blob/main/CONTRIBUTING.md) covers
repository setup and process.

Licensed under Apache-2.0.
