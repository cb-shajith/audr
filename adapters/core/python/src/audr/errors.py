from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from audr.record.codes import ErrorCode


class AudrError(Exception):
    """Base class for all audr errors."""


class ConfigurationError(AudrError):
    """Invalid constructor arguments."""


class LifecycleError(AudrError):
    """Operation not allowed in the client's current state."""


@dataclass(frozen=True, slots=True)
class ValidationIssue:
    code: ErrorCode
    path: str

    @property
    def message(self) -> str:
        # Deferred: `audr.record` re-exports the model, which is built on these errors, so the
        # catalog cannot be imported while this module is still being defined.
        from audr.record.codes import MESSAGES

        return MESSAGES[self.code]

    def __str__(self) -> str:
        return f"{self.code.value} at {self.path}"


class ValidationError(AudrError):
    issues: tuple[ValidationIssue, ...]

    def __init__(self, issues: Iterable[ValidationIssue]) -> None:
        self.issues = tuple(issues)
        if not self.issues:
            raise ValueError("ValidationError requires at least one issue")
        super().__init__(f"{len(self.issues)} issues: " + "; ".join(str(i) for i in self.issues))


__all__ = [
    "AudrError",
    "ConfigurationError",
    "LifecycleError",
    "ValidationError",
    "ValidationIssue",
]
