"""Build one AUDR record and deliver it to a local JSON Lines file.

The write path: construct a typed record, open a `Client` backed by a `FileSink`,
and `record()` it onto the background delivery pipeline.
"""

from __future__ import annotations

import asyncio
import tempfile
from pathlib import Path

import audr


async def main() -> None:
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

    path = Path(tempfile.gettempdir()) / "audr-example.jsonl"
    async with audr.Client(
        audr.FileSink(path),
        emitter=audr.Emitter(component="harness", name="my-harness", version="1.4.0"),
    ) as client:
        result = client.record(record)
        assert result.queued, result.issues
        await client.flush(timeout=5)
    print(f"wrote to {path}")
    print(client.stats)


if __name__ == "__main__":
    asyncio.run(main())
