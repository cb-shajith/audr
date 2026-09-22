#!/usr/bin/env python3
"""Validate every example embedded in the specification against the schema.

The specification's JSON examples are real files under spec/examples/,
referenced by outline.yaml and spliced into the rendered document. This script
validates each one against the schema node the outline says it illustrates, so an
example can never drift from the schema it is demonstrating.

Fragment examples (`mode: fragment`) illustrate part of a record. Their property
constraints are still checked; only presence rules are relaxed.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import yaml
from jsonschema import Draft202012Validator, FormatChecker

sys.path.insert(0, str(Path(__file__).parent))
import schema_model as sm  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent


def relax(node: dict) -> dict:
    """Drop presence rules so a fragment validates on its property constraints."""
    out = {k: v for k, v in node.items() if k not in ("required", "allOf")}
    return out


def collect(outline: dict) -> list[tuple[str, str, str]]:
    """(example path, schema pointer, mode) for every example in the document."""
    found = []
    for sec in outline["sections"]:
        if sec.get("example"):
            found.append((sec["example"], sec["pointer"], sec.get("mode", "full")))
        for ex in sec.get("examples", []):
            found.append((ex["path"], ex["pointer"], ex.get("mode", "full")))
        for sub in sec.get("subtables", []):
            if sub.get("example"):
                # a subtable's example usually shows the enclosing object, so it
                # may name a pointer different from the table's own
                found.append(
                    (sub["example"], sub.get("example_pointer", sub["pointer"]), "full")
                )
    return found


def main() -> int:
    base = ROOT / "spec"
    outline = yaml.safe_load((base / "outline.yaml").read_text())
    schema = sm.load(base / outline["schema"])

    failures = 0
    checked = 0
    for rel, pointer, mode in collect(outline):
        node = sm.resolve(schema, pointer)
        target = relax(node) if mode == "fragment" else node
        if pointer != "#":
            # a subschema still needs the root's $schema to pick a dialect
            target = {"$schema": schema["$schema"], **target}

        document = json.loads((base / rel).read_text())
        errors = list(
            Draft202012Validator(target, format_checker=FormatChecker()).iter_errors(
                document
            )
        )
        checked += 1
        if errors:
            failures += 1
            print(f"  FAIL {rel}  (against {pointer}, mode={mode})")
            for e in errors[:3]:
                where = "/".join(str(p) for p in e.path) or "<root>"
                print(f"         {where}: {e.message[:120]}")

    # The end-to-end scenarios under spec/examples/ are whole records.
    root_validator = Draft202012Validator(schema, format_checker=FormatChecker())
    scenarios = sorted((ROOT / "spec" / "examples" / "multi-emitter-run").rglob("*.json"))
    for path in scenarios:
        errors = list(root_validator.iter_errors(json.loads(path.read_text())))
        checked += 1
        if errors:
            failures += 1
            print(f"  FAIL {path.relative_to(ROOT)}")
            for e in errors[:3]:
                where = "/".join(str(p) for p in e.path) or "<root>"
                print(f"         {where}: {e.message[:120]}")

    if failures:
        print(f"\n{failures} of {checked} examples are invalid.")
        return 1
    print(f"  {checked} examples validate against the schema "
          f"({len(scenarios)} end-to-end, {checked - len(scenarios)} in the specification)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
