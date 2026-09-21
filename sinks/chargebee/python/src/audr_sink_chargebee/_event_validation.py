"""Chargebee ingest-envelope validation.

These are the destination's rules, not AUDR's: the identifier length limits, the
13-digit millisecond timestamp, the property-name pattern and its reserved
names, and the scalar-only property values the batch endpoint accepts.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from math import isfinite
from typing import Any


class InvalidUsageEventError(ValueError):
    """A Chargebee usage event violates the destination's envelope or property rules."""


_MAX_SUBSCRIPTION_ID_LENGTH = 50
_MAX_DEDUPLICATION_ID_LENGTH = 36
_MILLISECOND_TIMESTAMP_DIGITS = 13
_PROPERTY_NAME_PATTERN = re.compile(r"[a-zA-Z][a-zA-Z0-9_]*")
_RESERVED_PROPERTY_NAMES = frozenset(
    {
        "deduplication_id",
        "error_codes",
        "event_meta",
        "ingestion_timestamp",
        "properties",
        "subscription_id",
        "usage_timestamp",
    }
)


def _validate_event_envelope(
    *,
    subscription_id: str,
    usage_timestamp: int,
    deduplication_id: str,
) -> None:
    """Validate fields shared by flat and AUDR delivery events."""
    if not isinstance(subscription_id, str):
        raise InvalidUsageEventError("subscription_id must be a string")
    if not subscription_id.strip():
        raise InvalidUsageEventError("subscription_id must not be empty")
    if len(subscription_id) > _MAX_SUBSCRIPTION_ID_LENGTH:
        raise InvalidUsageEventError(
            f"subscription_id must be at most {_MAX_SUBSCRIPTION_ID_LENGTH} characters"
        )
    if not isinstance(deduplication_id, str):
        raise InvalidUsageEventError("deduplication_id must be a string")
    if not deduplication_id.strip():
        raise InvalidUsageEventError("deduplication_id must not be empty")
    if len(deduplication_id) > _MAX_DEDUPLICATION_ID_LENGTH:
        raise InvalidUsageEventError(
            f"deduplication_id must be at most {_MAX_DEDUPLICATION_ID_LENGTH} characters"
        )
    if isinstance(usage_timestamp, bool) or not isinstance(usage_timestamp, int):
        raise InvalidUsageEventError("usage_timestamp must be an integer")
    if len(str(usage_timestamp)) != _MILLISECOND_TIMESTAMP_DIGITS:
        raise InvalidUsageEventError(
            "usage_timestamp must be a 13-digit epoch-millisecond value; a 10-digit "
            "value is epoch seconds and the destination rejects it"
        )


def _validate_properties(properties: Mapping[Any, Any]) -> None:
    """Apply the destination's scalar property rules without logging values."""
    for key, value in properties.items():
        if not isinstance(key, str):
            raise InvalidUsageEventError("properties names must be strings")
        if not _PROPERTY_NAME_PATTERN.fullmatch(key):
            raise InvalidUsageEventError(
                f"properties name {key!r} must start with a letter and contain only "
                "letters, digits, and underscores"
            )
        if key in _RESERVED_PROPERTY_NAMES:
            raise InvalidUsageEventError(f"properties name {key!r} is reserved")
        if value is not None and not isinstance(value, str | int | float):
            raise InvalidUsageEventError(
                f"properties value for {key!r} must be a scalar; the destination fails on "
                f"nested objects and arrays, got {type(value).__name__}"
            )
        if isinstance(value, float) and not isfinite(value):
            raise InvalidUsageEventError(
                f"properties value for {key!r} must be a finite JSON number"
            )
