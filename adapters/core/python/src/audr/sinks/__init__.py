"""The sink contract: what a destination must implement to receive records."""

from audr.sinks.base import BatchOutcome, BatchResult, RejectedRecord, Sink
from audr.sinks.file import FileFormat, FileSink

__all__ = ["BatchOutcome", "BatchResult", "FileFormat", "FileSink", "RejectedRecord", "Sink"]
