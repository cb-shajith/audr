"""Immutable usage-event value objects."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from types import MappingProxyType
from typing import Any

from audr.ids import uuid7

from audr_sink_chargebee._event_validation import (
    InvalidUsageEventError,
    _validate_event_envelope,
    _validate_properties,
)


@dataclass(frozen=True, slots=True)
class UsageEvent:
    """An immutable event accepted by Chargebee's usage-ingest batch endpoint."""

    subscription_id: str
    usage_timestamp: int
    properties: Mapping[str, Any]
    deduplication_id: str = field(default_factory=uuid7)

    def __post_init__(self) -> None:
        _validate_event_envelope(
            subscription_id=self.subscription_id,
            usage_timestamp=self.usage_timestamp,
            deduplication_id=self.deduplication_id,
        )
        if not isinstance(self.properties, Mapping):
            raise InvalidUsageEventError("properties must be a JSON object")
        if not self.properties:
            raise InvalidUsageEventError("properties must not be empty")
        _validate_properties(self.properties)
        object.__setattr__(self, "properties", MappingProxyType(dict(self.properties)))

    def to_payload(self) -> dict[str, object]:
        """Return the destination's four-field event representation."""
        return {
            "subscription_id": self.subscription_id,
            "usage_timestamp": self.usage_timestamp,
            "deduplication_id": self.deduplication_id,
            "properties": dict(self.properties),
        }
