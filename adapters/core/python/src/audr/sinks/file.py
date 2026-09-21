"""A `Sink` that appends records to a JSON Lines file or stream."""

from __future__ import annotations

import os
from collections.abc import Sequence
from typing import Literal, TextIO

from audr.errors import ConfigurationError
from audr.record import AgentUsageRecord
from audr.sinks.base import BatchResult

FileFormat = Literal["jsonl"]

_SUPPORTED_FORMATS: frozenset[str] = frozenset({"jsonl"})


class FileSink:
    """Write records as newline-delimited JSON to a path or an open text stream.

    A path target is opened lazily on the first `deliver()` call (mode `"a"` if
    `append` else `"w"`, `encoding="utf-8"`) and closed by `close()`. A stream target
    (anything else, such as an already-open file object or `io.StringIO`) is written
    to as given and is never closed by this sink.

    Retry caveat: `deliver()` writes records one line at a time and flushes once per
    batch; if an `OSError` occurs part-way through a batch, lines already written stay
    in the file while the whole batch is reported `RETRYABLE_FAILURE`, so an
    application that replays failed records from the `on_failure` callback may write
    duplicate lines. Consumers of the file should de-duplicate on `record_id`. The
    pipeline itself never retries.
    """

    def __init__(
        self,
        target: str | os.PathLike[str] | TextIO,
        *,
        format: FileFormat = "jsonl",
        append: bool = True,
    ) -> None:
        if format not in _SUPPORTED_FORMATS:
            raise ConfigurationError(f"unsupported file format: {format!r}")
        self._format = format
        self._append = append
        self._closed = False
        self._path: str | os.PathLike[str] | None
        self._stream: TextIO | None
        if isinstance(target, (str, os.PathLike)):
            self._path = target
            self._stream = None
            self._owns_stream = True
        else:
            self._path = None
            self._stream = target
            self._owns_stream = False

    async def deliver(self, batch: Sequence[AgentUsageRecord]) -> BatchResult:
        if self._closed:
            return BatchResult.closed()
        try:
            stream = self._ensure_stream()
            for record in batch:
                stream.write(record.to_json() + "\n")
            stream.flush()
        except OSError as exc:
            return BatchResult.failed(retryable=True, detail=type(exc).__name__)
        return BatchResult.accepted()

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        if self._owns_stream and self._stream is not None:
            self._stream.close()

    def _ensure_stream(self) -> TextIO:
        stream = self._stream
        if stream is None:
            mode: Literal["a", "w"] = "a" if self._append else "w"
            assert self._path is not None
            stream = open(self._path, mode, encoding="utf-8")
            self._stream = stream
        return stream


__all__ = ["FileFormat", "FileSink"]
