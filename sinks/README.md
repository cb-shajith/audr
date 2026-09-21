# Sinks

A sink receives [AUDR](../spec/SPEC.md) records from a `Client` built on the
[core SDK](../adapters/core/) and delivers them to a destination: a file, a warehouse,
Chargebee. It owns encoding, transport, credentials, retries, and any destination-specific
byte limits. The core never talks to a destination directly.

## The sink contract

A sink implements two async methods:

```python
class Sink(Protocol):
    async def deliver(self, batch: Sequence[AgentUsageRecord]) -> BatchResult: ...
    async def close(self) -> None: ...        # idempotent; never raises
```

The pipeline guarantees a sink that batches are never empty, never exceed the client's
`batch_max_size`, arrive one at a time, and an answered batch is never re-sent. The sink
answers with a `BatchResult`:

```python
class BatchOutcome(StrEnum):
    ACCEPTED, RETRYABLE_FAILURE, PERMANENT_FAILURE, CLOSED

class BatchResult:
    outcome: BatchOutcome
    rejected: Sequence[RejectedRecord] = ()   # meaningful with ACCEPTED
    unknown: Sequence[str] = ()               # record_ids; meaningful with ACCEPTED
    detail: str | None = None
```

| Outcome | Meaning | Effect on each record in the batch |
| --- | --- | --- |
| `ACCEPTED` | The sink took the batch. `rejected` and `unknown` name any records inside it that were not actually delivered. | Everything not named in `rejected`/`unknown` is `sent`. A named `rejected` record is `dropped` (not retryable). A named `unknown` record is `unknown` — the sink could not confirm delivery, so a replay keyed on `record_id` is safe. |
| `RETRYABLE_FAILURE` | The whole batch failed for a reason that may succeed later (a timeout, a `5xx`, a rate limit). | Every record in the batch is `dropped`; the pipeline never retries itself, so retrying is the sink's own responsibility inside `deliver()`. |
| `PERMANENT_FAILURE` | The whole batch failed for a reason that will not change on retry (bad credentials, a malformed request). | Every record in the batch is `dropped`. |
| `CLOSED` | The sink is closed and cannot accept the batch. | Every record in the batch is `dropped`. |

A sink never retries at the pipeline level and never raises out of `deliver()` or `close()`
for an ordinary delivery failure — it reports the outcome instead. `audr.testing.assert_sink_contract()`
checks a sink against these rules; every sink here uses it in its own test suite.

## Sinks

| Sink | Directory | Distribution | Status |
| --- | --- | --- | --- |
| Chargebee | [`chargebee/`](chargebee/) | `audr-sink-chargebee` | Pre-release `0.1.0a1` |

See [`adapters/`](../adapters/) for where records come from, and
[CONTRIBUTING.md](../CONTRIBUTING.md) for how to propose a new sink.
