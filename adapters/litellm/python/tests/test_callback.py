"""CustomLogger lifecycle and bridge tests."""

from __future__ import annotations

import asyncio
import logging
import threading
from typing import cast

import pytest
from audr import AgentUsageRecord, Attribution, Client, SubmitOutcome, SubmitResult

from audr_adapter_litellm import (
    LiteLLMActivationError,
    LiteLLMAudrCallback,
    LiteLLMConfig,
    _callback,
)
from tests.helpers import END, START, callback_kwargs, response


class _Client:
    def __init__(
        self,
        *,
        outcome: SubmitOutcome = SubmitOutcome.QUEUED,
        error: Exception | None = None,
    ) -> None:
        self.outcome = outcome
        self.error = error
        self.records: list[AgentUsageRecord] = []
        self.thread_ids: list[int] = []

    def record(self, record: AgentUsageRecord) -> SubmitResult:
        self.records.append(record)
        self.thread_ids.append(threading.get_ident())
        if self.error is not None:
            raise self.error
        return SubmitResult(self.outcome)


def _new_callback(
    client: _Client,
    *,
    max_pending: int = 1000,
) -> LiteLLMAudrCallback:
    return LiteLLMAudrCallback(
        client=cast(Client, client),
        config=LiteLLMConfig(
            attribution_defaults=Attribution(environment="test"),
            max_pending_handoffs=max_pending,
        ),
    )


async def test_async_success_hands_one_record_to_the_owning_loop() -> None:
    client = _Client()
    callback = _new_callback(client)
    owning_thread = threading.get_ident()

    await callback.async_log_success_event(callback_kwargs(), response(), START, END)
    await callback.drain()

    assert len(client.records) == 1
    assert client.thread_ids == [owning_thread]


async def test_sync_callback_can_arrive_from_a_worker_thread() -> None:
    client = _Client()
    callback = _new_callback(client)
    owning_thread = threading.get_ident()

    await asyncio.to_thread(
        callback.log_success_event,
        callback_kwargs(),
        response(),
        START,
        END,
    )
    await callback.drain()

    assert len(client.records) == 1
    assert client.thread_ids == [owning_thread]


async def test_unmetered_failure_does_not_emit() -> None:
    client = _Client()
    callback = _new_callback(client)

    await callback.async_log_failure_event(
        callback_kwargs(exception=TimeoutError("private")),
        {"model": "model"},
        START,
        END,
    )
    await callback.drain()

    assert client.records == []


async def test_handoff_bound_drops_without_blocking_litellm(
    caplog: pytest.LogCaptureFixture,
) -> None:
    client = _Client()
    callback = _new_callback(client, max_pending=1)
    caplog.set_level(logging.WARNING)

    callback.log_success_event(callback_kwargs(), response(), START, END)
    callback.log_success_event(callback_kwargs(), response(), START, END)
    await callback.drain()

    assert len(client.records) == 1
    assert "handoff full" in caplog.text


async def test_non_queued_client_outcome_is_reported(
    caplog: pytest.LogCaptureFixture,
) -> None:
    client = _Client(outcome=SubmitOutcome.DROPPED_QUEUE_FULL)
    callback = _new_callback(client)
    caplog.set_level(logging.WARNING)

    callback.log_success_event(callback_kwargs(), response(), START, END)
    await callback.drain()

    assert "outcome=dropped_queue_full" in caplog.text


async def test_client_exception_is_isolated_and_not_logged(
    caplog: pytest.LogCaptureFixture,
) -> None:
    secret = "client-error-secret"
    client = _Client(error=RuntimeError(secret))
    callback = _new_callback(client)
    caplog.set_level(logging.WARNING)

    callback.log_success_event(callback_kwargs(), response(), START, END)
    await callback.drain()

    assert "submission failed" in caplog.text
    assert secret not in caplog.text


async def test_mapping_exception_is_isolated_and_not_logged(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    secret = "mapping-error-secret"
    client = _Client()
    callback = _new_callback(client)
    caplog.set_level(logging.WARNING)

    def explode(**_: object) -> object:
        raise RuntimeError(secret)

    monkeypatch.setattr(_callback, "map_callback", explode)
    callback.log_success_event(callback_kwargs(), response(), START, END)
    await callback.drain()

    assert "mapping failed internally" in caplog.text
    assert secret not in caplog.text
    assert client.records == []


async def test_malformed_metadata_logs_only_a_stable_path(
    caplog: pytest.LogCaptureFixture,
) -> None:
    secret = "private@example.com"
    client = _Client()
    callback = _new_callback(client)
    caplog.set_level(logging.WARNING)
    kwargs = callback_kwargs(litellm_params={"metadata": {"audr": {secret: "private-value"}}})

    callback.log_success_event(kwargs, response(), START, END)
    await callback.drain()

    assert "callback malformed" in caplog.text
    assert "/litellm_params/metadata/audr" in caplog.text
    assert secret not in caplog.text
    assert client.records == []


async def test_close_rejects_late_events_and_drain_after_close(
    caplog: pytest.LogCaptureFixture,
) -> None:
    client = _Client()
    callback = _new_callback(client)
    callback.close()
    caplog.set_level(logging.WARNING)

    callback.log_success_event(callback_kwargs(), response(), START, END)

    assert "adapter is closed" in caplog.text
    assert client.records == []
    with pytest.raises(LiteLLMActivationError, match="before close"):
        await callback.drain()


async def test_closed_handoff_loop_drops_without_raising(
    caplog: pytest.LogCaptureFixture,
) -> None:
    client = _Client()
    callback = _new_callback(client)
    closed_loop = asyncio.new_event_loop()
    closed_loop.close()
    callback._bridge._loop = closed_loop
    caplog.set_level(logging.WARNING)

    callback.log_success_event(callback_kwargs(), response(), START, END)

    assert "event loop unavailable" in caplog.text
    assert client.records == []


def test_constructor_requires_a_running_event_loop() -> None:
    with pytest.raises(LiteLLMActivationError, match="running event loop"):
        LiteLLMAudrCallback(client=cast(Client, _Client()))


def test_constructor_rejects_an_explicit_closed_loop() -> None:
    loop = asyncio.new_event_loop()
    loop.close()

    with pytest.raises(LiteLLMActivationError, match="must be running"):
        LiteLLMAudrCallback(client=cast(Client, _Client()), loop=loop)
