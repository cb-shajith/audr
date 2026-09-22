"""Base classes for the generated record model.

`scripts/gen_models.py` points every generated class at one of these, so the model config lives
here rather than being repeated in generated code.
"""

from __future__ import annotations

import math
import re

from pydantic import BaseModel, ConfigDict, model_validator

_EXTENSION = re.compile(r"^x_[a-z0-9_]+$")


class FrozenBase(BaseModel):
    """A closed schema block: immutable, and unknown properties are rejected."""

    model_config = ConfigDict(frozen=True, extra="forbid")


class ExtensibleBase(BaseModel):
    """A schema block that admits ``x_*`` provider counters (non-negative numbers)."""

    model_config = ConfigDict(frozen=True, extra="allow")

    @model_validator(mode="after")
    def _check_extensions(self) -> ExtensibleBase:
        for key, value in (self.model_extra or {}).items():
            if not _EXTENSION.match(key):
                raise ValueError(f"unknown property {key!r}")
            if (
                isinstance(value, bool)
                or not isinstance(value, int | float)
                or (isinstance(value, float) and not math.isfinite(value))
                or value < 0
            ):
                raise ValueError(f"extension {key!r} must be a non-negative finite number")
        return self

    @property
    def extensions(self) -> dict[str, int | float]:
        """The ``x_*`` provider counters carried by this block."""
        return dict(self.model_extra or {})
