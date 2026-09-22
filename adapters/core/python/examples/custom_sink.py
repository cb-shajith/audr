"""A minimal custom `Sink` that prints each record rather than delivering it onward.

Any object with `deliver()` and `close()` satisfies the `Sink` protocol structurally;
`assert_sink_contract` is the same harness the test suite runs against `FileSink` and
`MemorySink`, and any third-party sink should pass it too.
"""

from __future__ import annotations

import asyncio
from collections.abc import Sequence

from audr import AUDR, BatchResult
from audr.testing import assert_sink_contract


class PrintSink:
    """A `Sink` that prints each record's `record_id` and accepts every batch."""

    def __init__(self) -> None:
        self._closed = False

    async def deliver(self, batch: Sequence[AUDR]) -> BatchResult:
        if self._closed:
            return BatchResult.closed()
        for record in batch:
            print(f"delivered {record.record_id}")
        return BatchResult.accepted()

    async def close(self) -> None:
        self._closed = True


if __name__ == "__main__":
    asyncio.run(assert_sink_contract(PrintSink()))
    print("PrintSink satisfies the Sink contract")
