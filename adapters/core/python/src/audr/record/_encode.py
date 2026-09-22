"""Wire encoding for records: the JSON an AUDR sink accepts.

The schema is closed, so the encoder emits only schema-defined keys: it drops absent
optionals, renders timestamps as RFC 3339 with millisecond precision, and rejects numbers
outside the range JSON represents.
"""

from __future__ import annotations

import json
import math
from datetime import datetime
from typing import Any

from pydantic import BaseModel

from audr._time import to_rfc3339_ms


def to_plain(model: BaseModel) -> dict[str, Any]:
    """Dump `model` with None dropped, ``x_*`` extras inlined, datetimes as RFC 3339 ms."""
    dumped: dict[str, Any] = model.model_dump(mode="python", exclude_none=True)
    return {key: _clean(value) for key, value in dumped.items() if value is not None}


def to_json(data: dict[str, Any], *, indent: int | None = None) -> str:
    """Serialize `data` deterministically: keys sorted, compact unless `indent` is given."""
    return json.dumps(
        data,
        sort_keys=True,
        ensure_ascii=False,
        indent=indent,
        separators=(",", ":") if indent is None else None,
    )


def _clean(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: _clean(item) for key, item in value.items() if item is not None}
    if isinstance(value, datetime):
        return to_rfc3339_ms(value)
    if isinstance(value, float) and not math.isfinite(value):
        raise ValueError("non-finite number cannot be encoded as JSON")
    return value
