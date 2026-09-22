from __future__ import annotations

from datetime import UTC, datetime


def now_utc() -> datetime:
    """Current time, tz-aware UTC, truncated to millisecond precision."""
    now = datetime.now(UTC)
    return now.replace(microsecond=now.microsecond - now.microsecond % 1000)


def to_rfc3339_ms(value: datetime) -> str:
    if value.tzinfo is None:
        raise ValueError("datetime must be timezone-aware")
    utc = value.astimezone(UTC)
    return utc.strftime("%Y-%m-%dT%H:%M:%S.") + f"{utc.microsecond // 1000:03d}Z"


def parse_rfc3339(text: str) -> datetime:
    return datetime.fromisoformat(text.replace("Z", "+00:00"))
