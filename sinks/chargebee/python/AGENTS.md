# AGENTS.md

Directives for working inside this package. Tier-wide directives are in
[`sinks/AGENTS.md`](../../AGENTS.md); repository setup, the shared Python toolchain and
the contribution process are in the top-level [`CONTRIBUTING.md`](../../../CONTRIBUTING.md).

## What this is

`sinks/chargebee/python` is the `audr-sink-chargebee` distribution: an HTTP sink that
delivers `audr.AUDR` record batches to a Chargebee site's usage-ingest batch endpoint
for Usage-Based Billing. It implements the sink contract defined in
[`adapters/core/README.md`](../../../adapters/core/README.md#the-sink-contract).

## Layout

| Path | Owns |
| --- | --- |
| `src/audr_sink_chargebee/_sink.py` | `ChargebeeSink`: `deliver()`, `close()`, and the HTTP-response-to-`BatchResult` mapping |
| `src/audr_sink_chargebee/_transport.py` | `HttpTransportConfig` and the lazily created `httpx` client |
| `src/audr_sink_chargebee/_retry.py` | `RetryPolicy`: failure classification and retry delays, applied inside `deliver()` |
| `src/audr_sink_chargebee/_flatten.py` | `flatten_audr`: reversible flattening of a nested record into scalar Chargebee properties |
| `src/audr_sink_chargebee/_event.py`, `_event_validation.py` | `UsageEvent` value objects and ingest-envelope validation |
| `src/audr_sink_chargebee/_credentials.py` | `site` / `api_key` / ingest URL resolution from arguments and environment, with safe rendering |
| `scripts/verify_distribution.py` | The isolation check `make isolation` runs against the built wheel |
| `tests/` | The suite, including `test_sink_contract.py` (`assert_sink_contract`) and `test_no_live_network.py` |
| `tests/integration/test_live_ingestion.py` | Opt-in `live`-marked test against a real site; never runs in CI |

## Working rules

1. Credentials are held by the sink and never appear in logs, errors or `repr()`.
   `api_key` is always required; explicit arguments take precedence over
   `CHARGEBEE_SITE`, `CHARGEBEE_API_KEY`, `CHARGEBEE_INGEST_DOMAIN`, `CHARGEBEE_INGEST_URL`.
2. Chargebee routes on `attribution.subscription_id`. A record without one is returned as
   `RejectedRecord(record_id, "missing_subscription_id")`, never sent.
3. `record_id` is Chargebee's `deduplication_id`; `timing.event_time` in milliseconds is
   `usage_timestamp`. A replay keyed on `record_id` is idempotent.
4. Every field of the record is flattened and forwarded, including `attribution.labels`
   and `x_*` extensions. The sink adds nothing, removes nothing, and re-checks nothing;
   property names are reversible, and the separator is one or more underscores.
5. HTTP outcomes map onto `BatchResult` as the README documents: `202`/`207` accepted with
   `rejected`/`unknown` named individually; `401` permanent `auth`; `413` permanent
   `payload_too_large`; other `4xx` permanent `http_<status>`; `429`/`5xx`/network
   retryable once the `RetryPolicy` budget is spent. A `207` failure that cannot be matched
   to a record marks every non-rejected record in the batch `unknown`.
6. Retries happen inside `deliver()`, bounded by `RetryPolicy`. `deliver()` and `close()`
   never raise for a delivery failure; `close()` is idempotent.
7. No record field value reaches a log or an error message.

## Toolchain

The shared toolchain is defined in the top-level
[`CONTRIBUTING.md`](../../../CONTRIBUTING.md#shared-python-toolchain). Specific to this
package:

- **Runtime deps:** `audr`, `httpx`.
- **Version:** `src/audr_sink_chargebee/_version.py`.
- **Tests:** the default run makes no network call; `test_no_live_network.py` enforces it.
  The `live` marker requires `CHARGEBEE_INGEST_URL`, `CHARGEBEE_API_KEY` and
  `CHARGEBEE_TEST_SUBSCRIPTION_ID` and is run deliberately with `uv run pytest -m live`.

`make verify` is `lint test isolation`.

## What not to do

- Do not add a code path that talks to Chargebee in the default test run.
- Do not alter, drop or re-validate record content on the way to the destination; the
  data-handling rules in [`SECURITY.md`](../../../SECURITY.md) are enforced where the
  record is built.
- Do not let the pipeline retry: report `RETRYABLE_FAILURE` only after the sink's own
  budget is exhausted.
- Do not include a credential, a site name from a real deployment, or a record value in a
  test fixture, a log line or an exception.
