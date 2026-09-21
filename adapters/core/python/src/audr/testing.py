"""Record builders and a sink-contract harness shared by the test suite.

These helpers support testing `audr` and third-party sinks. They sit outside the stable
delivery pipeline, so their shapes may change independently of the spec-backed record and
sink contracts they exercise.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from typing import Any, Literal

from audr.ids import uuid7
from audr.record import (
    AgentUsageRecord,
    Attribution,
    Emitter,
    LlmUsage,
    Resource,
    Run,
    Timing,
    Usage,
)
from audr.sinks import BatchOutcome, BatchResult, RejectedRecord, Sink

__all__ = ["MemorySink", "assert_sink_contract", "make_record"]


def make_record(**overrides: Any) -> AgentUsageRecord:
    """A valid, minimal generation record, with `overrides` applied."""
    base: dict[str, Any] = {
        "emitter": Emitter(component="harness", name="audr-testing", version="0"),
        "timing": Timing(),
        "resource": Resource(
            provider="anthropic",
            type="model",
            name="test-model",
            operation="generation",
            modality="text",
        ),
        "usage": Usage(llm=LlmUsage(input_tokens=10, output_tokens=5, requests=1)),
        "run": Run(run_id=uuid7(), span_id="span-1"),
        "attribution": Attribution(environment="test"),
    }
    base.update(overrides)
    return AgentUsageRecord(**base)


class MemorySink:
    """An in-memory :class:`~audr.sinks.Sink` for tests.

    Every accepted record is appended to `records`; `batches` counts `deliver()`
    calls that were not short-circuited by `fail_with` or a prior `close()`. Pass
    `reject` to reject individual records by returning a reason string (`None`
    accepts), or `fail_with` to fail every batch with a fixed, non-accepting outcome
    (`RETRYABLE_FAILURE`, `PERMANENT_FAILURE`, or `CLOSED`); `ACCEPTED` is not a
    meaningful failure mode and raises `ValueError`.
    """

    def __init__(
        self,
        *,
        reject: Callable[[AgentUsageRecord], str | None] | None = None,
        fail_with: Literal[
            BatchOutcome.RETRYABLE_FAILURE, BatchOutcome.PERMANENT_FAILURE, BatchOutcome.CLOSED
        ]
        | None = None,
    ) -> None:
        if fail_with is BatchOutcome.ACCEPTED:  # type: ignore[comparison-overlap]
            raise ValueError("fail_with=BatchOutcome.ACCEPTED is not a failure; omit fail_with")
        self._reject = reject
        self._fail_with = fail_with
        self.records: list[AgentUsageRecord] = []
        self.batches = 0
        self.closed = False

    async def deliver(self, batch: Sequence[AgentUsageRecord]) -> BatchResult:
        if self.closed:
            return BatchResult.closed()
        if self._fail_with is not None:
            if self._fail_with is BatchOutcome.RETRYABLE_FAILURE:
                return BatchResult.failed(retryable=True)
            if self._fail_with is BatchOutcome.PERMANENT_FAILURE:
                return BatchResult.failed(retryable=False)
            return BatchResult.closed()

        rejected: list[RejectedRecord] = []
        accepted: list[AgentUsageRecord] = []
        for record in batch:
            reason = self._reject(record) if self._reject is not None else None
            if reason is not None:
                rejected.append(RejectedRecord(record.record_id, reason))
            else:
                accepted.append(record)

        self.records.extend(accepted)
        self.batches += 1
        return BatchResult.accepted(rejected=rejected)

    async def close(self) -> None:
        self.closed = True


async def assert_sink_contract(
    sink: Sink,
    *,
    records: Sequence[AgentUsageRecord] | None = None,
) -> None:
    """Assert that `sink` honours the :class:`~audr.sinks.Sink` contract.

    The check closes `sink` as part of its work, so pass a disposable instance
    rather than one an application still delivers through. `records` defaults to
    three records built by :func:`make_record`. The first breach raises
    `AssertionError` naming the rule that was violated.
    """
    batch = tuple(records) if records is not None else tuple(make_record() for _ in range(3))

    if not isinstance(sink, Sink):
        raise AssertionError("sink must satisfy the Sink protocol: it needs deliver() and close()")

    result = await sink.deliver(batch)
    if not isinstance(result, BatchResult):
        raise AssertionError(f"deliver() must return a BatchResult, got {type(result).__name__}")

    _assert_ids_in_batch(batch, result)

    await _assert_close_is_idempotent(sink)

    closed_result = await sink.deliver(batch)
    if closed_result.outcome not in (BatchOutcome.CLOSED, BatchOutcome.ACCEPTED):
        raise AssertionError(
            "deliver() after close() must return BatchOutcome.CLOSED, or ACCEPTED if the "
            f"sink legitimately keeps working after close(); got {closed_result.outcome}"
        )


def _assert_ids_in_batch(batch: Sequence[AgentUsageRecord], result: BatchResult) -> None:
    """Assert every reported id belongs to the batch and to at most one bucket."""
    batch_ids = {record.record_id for record in batch}
    rejected_ids = [rejection.record_id for rejection in result.rejected]
    unknown_ids = list(result.unknown)

    foreign = sorted(
        {identifier for identifier in (*rejected_ids, *unknown_ids) if identifier not in batch_ids}
    )
    if foreign:
        raise AssertionError(
            f"a result must not report a record_id absent from the batch: {foreign}"
        )

    overlap = sorted(set(rejected_ids) & set(unknown_ids))
    if overlap:
        raise AssertionError(f"a record_id must not appear in both rejected and unknown: {overlap}")


async def _assert_close_is_idempotent(sink: Sink) -> None:
    """Assert close() can be awaited twice without raising."""
    for attempt in (1, 2):
        try:
            await sink.close()
        except Exception as error:
            raise AssertionError(
                f"close() must be idempotent and must not raise; call {attempt} raised "
                f"{type(error).__name__}: {error}"
            ) from error
