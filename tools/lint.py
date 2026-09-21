#!/usr/bin/env python3
"""Cross-reference checks the schema and the prose cannot make about themselves.

A schema's $id names the URL the schema is published at, and implementations
resolve it at runtime. Checks that the two agree.

    python3 tools/lint.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def check_schema_id() -> list[str]:
    """$id must match where the schema is actually published.

    openaudr.dev serves the schema verbatim at this path, so the two cannot
    be allowed to drift.
    """
    schema = json.loads((ROOT / "spec/audr.schema.json").read_text())
    version = schema["properties"]["spec_version"]["examples"][0]
    expected = f"https://openaudr.dev/spec/v{version}/audr.schema.json"
    if schema["$id"] != expected:
        return [f"$id is {schema['$id']!r}, but the site publishes it at {expected!r}"]
    return []


def main() -> int:
    problems = check_schema_id()
    if problems:
        print(f"{len(problems)} cross-reference problem(s):")
        for p in problems:
            print(f"  {p}")
        return 1
    print("  $id cross-references resolve")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
