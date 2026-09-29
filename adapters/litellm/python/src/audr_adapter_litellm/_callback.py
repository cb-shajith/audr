"""LiteLLM ``CustomLogger`` implementation."""

from __future__ import annotations

import asyncio
import logging
from typing import assert_never

from audr import AUDR, Client, SubmitOutcome
from litellm.integrations.custom_logger import CustomLogger

from audr_adapter_litellm._bridge import EventLoopBridge, HandoffOutcome
from audr_adapter_litellm._config import LiteLLMConfig
from audr_adapter_litellm._errors import LiteLLMActivationError
from audr_adapter_litellm._mapping import (
    RecordMalformed,
    RecordReady,
    RecordSkipped,
    map_callback,
)

_LOGGER = logging.getLogger(__name__)


class LiteLLMAudrCallback(CustomLogger):
    """Emit metered LiteLLM calls through a host-owned AUDR client.

    Construct this callback on the running event loop that owns ``client``.
    LiteLLM may invoke synchronous callbacks on worker threads; the bounded
    bridge returns those records to the owning loop without blocking LiteLLM.
    """

    def __init__(
        self,
        *,
        client: Client,
        config: LiteLLMConfig | None = None,
        loop: asyncio.AbstractEventLoop | None = None,
    ) -> None:
        super().__init__()
        if loop is None:
            try:
                loop = asyncio.get_running_loop()
            except RuntimeError as error:
                raise LiteLLMActivationError(
                    "construct LiteLLMAudrCallback on the running event loop that owns "
                    "the AUDR client, or pass loop= explicitly"
                ) from error
        if loop.is_closed() or not loop.is_running():
            raise LiteLLMActivationError("the LiteLLM callback event loop must be running")
        self._config = config or LiteLLMConfig()
        self._bridge = EventLoopBridge(
            client=client,
            loop=loop,
            max_pending=self._config.max_pending_handoffs,
            on_result=self._on_submit_result,
        )
        self._closed = False

    def log_success_event(
        self,
        kwargs: object,
        response_obj: object,
        start_time: object,
        end_time: object,
    ) -> None:
        """Handle a successful synchronous LiteLLM request."""
        self._handle(
            kwargs=kwargs,
            response=response_obj,
            start_time=start_time,
            end_time=end_time,
            failed=False,
        )

    def log_failure_event(
        self,
        kwargs: object,
        response_obj: object,
        start_time: object,
        end_time: object,
    ) -> None:
        """Handle a failed synchronous request when usage is available."""
        self._handle(
            kwargs=kwargs,
            response=response_obj,
            start_time=start_time,
            end_time=end_time,
            failed=True,
        )

    async def async_log_success_event(
        self,
        kwargs: object,
        response_obj: object,
        start_time: object,
        end_time: object,
    ) -> None:
        """Handle a successful asynchronous LiteLLM request."""
        self.log_success_event(kwargs, response_obj, start_time, end_time)

    async def async_log_failure_event(
        self,
        kwargs: object,
        response_obj: object,
        start_time: object,
        end_time: object,
    ) -> None:
        """Handle a failed asynchronous request when usage is available."""
        self.log_failure_event(kwargs, response_obj, start_time, end_time)

    async def drain(self, timeout: float | None = None) -> None:
        """Wait until all callback records accepted by the bridge reach the client."""
        if self._closed:
            raise LiteLLMActivationError("drain() must be awaited before close()")
        await self._bridge.drain(timeout)

    def close(self) -> None:
        """Stop accepting callback events after LiteLLM has been unregistered."""
        self._closed = True

    def _handle(
        self,
        *,
        kwargs: object,
        response: object,
        start_time: object,
        end_time: object,
        failed: bool,
    ) -> None:
        if self._closed:
            _LOGGER.warning("LiteLLM callback ignored: adapter is closed")
            return
        try:
            result = map_callback(
                kwargs=kwargs,
                response=response,
                start_time=start_time,
                end_time=end_time,
                attribution_defaults=self._config.attribution_defaults,
                failed=failed,
            )
        except Exception:
            _LOGGER.warning("LiteLLM callback mapping failed internally")
            return

        match result:
            case RecordReady(record=record):
                self._submit(record)
            case RecordSkipped(path=path):
                if path not in {"/usage", "/call_type", "/cache_hit"}:
                    _LOGGER.warning("LiteLLM callback skipped (path=%s)", path)
            case RecordMalformed(path=path):
                _LOGGER.warning("LiteLLM callback malformed (path=%s)", path)
            case unreachable:
                assert_never(unreachable)

    def _submit(self, record: AUDR) -> None:
        outcome = self._bridge.submit(record)
        match outcome:
            case HandoffOutcome.SCHEDULED:
                return
            case HandoffOutcome.DROPPED_HANDOFF_FULL:
                _LOGGER.warning("LiteLLM callback record dropped: handoff full")
            case HandoffOutcome.DROPPED_LOOP_UNAVAILABLE:
                _LOGGER.warning("LiteLLM callback record dropped: event loop unavailable")
            case unreachable:
                assert_never(unreachable)

    def _on_submit_result(self, outcome: SubmitOutcome | None) -> None:
        if outcome is SubmitOutcome.QUEUED:
            return
        if outcome is None:
            _LOGGER.warning("LiteLLM callback submission failed")
        else:
            _LOGGER.warning("LiteLLM callback submission dropped (outcome=%s)", outcome)


__all__ = ["LiteLLMAudrCallback"]
