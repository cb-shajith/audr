# audr

[![PyPI](https://img.shields.io/pypi/v/audr?include_prereleases)](https://pypi.org/project/audr/)
[![Python versions](https://img.shields.io/pypi/pyversions/audr)](https://pypi.org/project/audr/)

Vendor-neutral Python SDK for emitting [AUDR](https://openaudr.dev/spec/v1.0.0/) (Agent Usage
Detail Record) v1.0.0 records: build records, validate them against the published schema, and
deliver them to any `Sink` (a file, a queue, a metering backend) through a bounded, batching
async pipeline.

## Install

```bash
pip install audr
```

## Quickstart

```python
import asyncio
import audr

record = audr.AgentUsageRecord(
    timing=audr.Timing(duration_ms=812),  # event_time defaults to now
    resource=audr.Resource(
        provider="anthropic",
        type="model",
        name="claude-sonnet-5",
        operation="generation",
        modality="text",
    ),
    usage=audr.Usage(llm=audr.LlmUsage(input_tokens=1200, output_tokens=340, requests=1)),
    run=audr.Run(run_id="01J8ZQ8Y2K3M4N5P6Q7R8S9T0V", span_id="turn-3", run_type="agent_run"),
    attribution=audr.Attribution(environment="production", account_id="acct_42"),
)  # record_id and spec_version defaulted


async def main() -> None:
    async with audr.Client(
        audr.FileSink("audr.jsonl"),
        emitter=audr.Emitter(component="harness", name="my-harness", version="1.4.0"),
    ) as client:
        result = client.record(record)
        assert result.queued, result.issues
    print(client.stats)


asyncio.run(main())
```

`FileSink` flushes once per batch. When a write fails part-way, the batch is reported
retryable and the lines already written remain in the file. Replays from `on_failure` are
therefore idempotent when the consumer de-duplicates on `record_id`.

Pass `on_delivered` to `Client` for a synchronous, per-batch acknowledgement of the
records a sink accepted. It fires once per accepted batch, carrying the records that were
sent; records the sink rejected or reported unknown are reported to `on_failure` instead.
Both callbacks run synchronously on the delivery path, so keep them fast. The client
catches and logs any exception a callback raises.

## Parsing JSON input

Records arriving as JSON are parsed and validated by `from_json()`:

```python
try:
    record = audr.AgentUsageRecord.from_json(payload)
except audr.ValidationError as err:
    for issue in err.issues:
        log.warning("bad AUDR record", code=issue.code, path=issue.path)
```

## Specification

This SDK implements [AUDR v1.0.0](https://openaudr.dev/spec/v1.0.0/). The
[schema, prose rules and conformance fixtures](https://github.com/openaudr/audr/tree/main/spec)
define the standard this package is tested against.

## Contributing

[`AGENTS.md`](https://github.com/openaudr/audr/blob/main/adapters/core/python/AGENTS.md)
records how to work inside this package — its layout, its invariants, and its commands.
[`adapters/CONTRIBUTING.md`](https://github.com/openaudr/audr/blob/main/adapters/CONTRIBUTING.md)
describes how to contribute an adapter, and the top-level
[`CONTRIBUTING.md`](https://github.com/openaudr/audr/blob/main/CONTRIBUTING.md) covers
repository setup and process.
