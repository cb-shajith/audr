"""Parse a JSON-encoded AUDR record, handling validation errors.

The read path: `AUDR.from_json` raises `ValidationError` carrying every
issue found, rather than failing on the first one. This payload is deliberately
missing `resource.provider` to exercise that path.
"""

from __future__ import annotations

import json

import audr

BROKEN_PAYLOAD = json.dumps(
    {
        "spec_version": audr.SPEC_VERSION,
        "record_id": "01J8ZQ8Y2K3M4N5P6Q7R8S9T0V",
        "emitter": {"component": "harness", "name": "example", "version": "1"},
        "timing": {"event_time": "2024-01-01T00:00:00Z"},
        "resource": {
            # "provider" is omitted here to exercise the validation path.
            "type": "model",
            "name": "claude-sonnet-5",
            "operation": "generation",
            "modality": "text",
        },
        "usage": {"llm": {"input_tokens": 10, "output_tokens": 5, "requests": 1}},
        "run": {"run_id": "01J8ZQ8Y2K3M4N5P6Q7R8S9T0V", "span_id": "turn-3"},
        "attribution": {"environment": "test"},
    }
)


def main() -> None:
    try:
        record = audr.AUDR.from_json(BROKEN_PAYLOAD)
    except audr.ValidationError as err:
        for issue in err.issues:
            print(f"bad AUDR record: code={issue.code} path={issue.path}")
        return
    print("parsed record:", record.record_id)  # pragma: no cover - unreachable here


if __name__ == "__main__":
    main()
