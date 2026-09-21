import json
from datetime import UTC, datetime

import pytest

from audr.record import LlmUsage, Timing, Usage
from tests.helpers import EMITTER, minimal


def test_to_dict_shape() -> None:
    r = minimal(
        emitter=EMITTER,
        timing=Timing(event_time=datetime(2026, 9, 20, 10, 0, 0, 123000, tzinfo=UTC)),
        usage=Usage(llm=LlmUsage(input_tokens=1, x_acme_widgets=2)),
    )
    d = r.to_dict()
    assert d["timing"] == {"event_time": "2026-09-20T10:00:00.123Z"}
    assert d["usage"]["llm"] == {"input_tokens": 1, "x_acme_widgets": 2}
    assert "cost" not in d
    assert "corrects" not in d


def test_to_json_compact_sorted() -> None:
    text = minimal(emitter=EMITTER).to_json()
    assert text.startswith('{"attribution":')
    assert "\n" not in text
    assert ", " not in text


def test_to_json_indented() -> None:
    record = minimal(emitter=EMITTER)
    text = record.to_json(indent=2)
    assert text.startswith('{\n  "attribution": {')
    assert json.loads(text) == record.to_dict()


def test_to_dict_refuses_non_finite_numbers() -> None:
    # `ge=0` lets infinity through the model, but JSON has no way to spell it.
    usage = Usage(llm=LlmUsage(input_tokens=1, audio_input_seconds=float("inf")))
    with pytest.raises(ValueError, match="non-finite"):
        minimal(emitter=EMITTER, usage=usage).to_dict()
