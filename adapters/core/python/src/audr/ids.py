"""UUIDv7 identifiers for record_id (spec: ULID or UUIDv7, 8-64 chars)."""

from __future__ import annotations

import sys
import uuid

if sys.version_info >= (3, 14):  # pragma: no cover

    def uuid7() -> str:
        return str(uuid.uuid7())
else:  # pragma: no cover
    import uuid6

    def uuid7() -> str:
        return str(uuid6.uuid7())


__all__ = ["uuid7"]
