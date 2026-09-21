"""Read audr.schema.json and expose it as the document model the renderers use.

The schema is the single source of truth. Everything the specification says
about a field -- its type expression, whether it is required, and the one-line
table summary -- is derived from or stored on the schema node itself.

Two annotation keywords carry documentation that JSON Schema has no keyword for.
Both are ignored by validators and are namespaced so they can never collide with
a future JSON Schema keyword:

    x_summary       one-line description used in the field tables. The schema's
                    own `description` stays normative and long-form.
    x_requirement   overrides the derived Required/Optional when a field is
                    required by a rule the `required` array cannot express
                    (a conditional in allOf, or an invariant the sink enforces).
"""

from __future__ import annotations

import json
from pathlib import Path

EN_DASH = "–"
GE = "≥"
LE = "≤"


def load(path: Path) -> dict:
    return json.loads(path.read_text())


def type_expression(node: dict) -> str:
    """Render a schema node as the Type column of a field table."""
    if "x_title" in node:
        return node["x_title"]

    if "enum" in node:
        return "enum (" + ", ".join(f"`{v}`" for v in node["enum"]) + ")"

    types = node.get("type")
    if isinstance(types, list):
        return " | ".join(types)

    if types == "string":
        if "pattern" in node:
            return "string (pattern)"
        if "format" in node:
            return f"string ({node['format']})"
        lo, hi = node.get("minLength"), node.get("maxLength")
        if lo is not None and hi is not None:
            return f"string ({lo}{EN_DASH}{hi} chars)"
        if lo is not None:
            return f"string (min {lo} chars)"
        if hi is not None:
            return f"string (max {hi} chars)"
        return "string"

    if types in ("integer", "number"):
        lo, hi = node.get("minimum"), node.get("maximum")
        out = types
        if lo is not None:
            out += f" {GE} {lo}"
        if hi is not None:
            out += f" {LE} {hi}"
        return out

    if types == "object":
        cap = node.get("maxProperties")
        if cap is not None:
            return f"object ({LE} {cap} key-value pairs)"
        return "object"

    return types or "any"


def requirement(name: str, node: dict, parent: dict) -> str:
    """Required / Optional / Conditional for one field."""
    override = node.get("x_requirement")
    if override:
        return override.capitalize()
    return "Required" if name in parent.get("required", []) else "Optional"


def summary(node: dict) -> str:
    """The one-line table description."""
    text = node.get("x_summary") or node.get("description", "")
    return " ".join(text.split("\n\n")[0].split())


def fields(root: dict, pointer: str, prefix: str = "") -> list[dict]:
    """Every documented field of the object at `pointer`, in schema order.

    Patterned extension properties (x_*) are emitted last, as the tables do,
    with their pattern shown as a literal field name.
    """
    node = resolve(root, pointer)
    out = []
    for name, child in node.get("properties", {}).items():
        out.append(
            {
                "name": f"{prefix}{name}",
                "type": type_expression(child),
                "requirement": requirement(name, child, node),
                "summary": summary(child),
            }
        )
    for pattern, child in node.get("patternProperties", {}).items():
        out.append(
            {
                "name": f"{prefix}{pattern_label(pattern)}",
                "type": type_expression(child),
                "requirement": requirement("", child, node),
                "summary": summary(child),
            }
        )
    return out


def pattern_label(pattern: str) -> str:
    """`^x_[a-z0-9_]+$` reads as `x_*` in a field table."""
    return pattern.strip("^$").replace("[a-z0-9_]+", "*")


def resolve(root: dict, pointer: str) -> dict:
    """Resolve a JSON pointer ('#', '#/properties/emitter') against the schema."""
    if pointer in ("#", "", "/"):
        return root
    node = root
    for token in pointer.lstrip("#/").split("/"):
        if not token:
            continue
        node = node[token.replace("~1", "/").replace("~0", "~")]
    return node
