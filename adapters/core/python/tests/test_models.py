import math
import uuid
from datetime import UTC, datetime
from typing import Any, Literal, get_args, get_origin

import pydantic
import pytest
from pydantic import BaseModel

import audr.record as record_module
from audr.record import AUDR, SPEC_VERSION, LlmUsage, Timing
from audr.record import _schema as gen
from tests.helpers import EMITTER, minimal


def test_defaults_are_filled() -> None:
    r = minimal()
    assert r.spec_version == SPEC_VERSION
    assert uuid.UUID(r.record_id).version == 7
    assert r.timing.event_time.tzinfo is not None
    assert r.timing.event_time.microsecond % 1000 == 0
    assert r.emitter is None


def test_supplied_record_id_is_kept() -> None:
    assert minimal(record_id="01J8ZQ8Y2K3M4N5P6Q7R8S9T0V").record_id == "01J8ZQ8Y2K3M4N5P6Q7R8S9T0V"


def test_frozen() -> None:
    with pytest.raises(pydantic.ValidationError):
        minimal().record_id = "x"  # type: ignore[misc]


def test_with_emitter_returns_copy() -> None:
    r = minimal()
    assert r.emitter is None
    assert r.with_emitter(EMITTER).emitter == EMITTER
    assert r.emitter is None


def test_event_time_ms() -> None:
    r = minimal(timing=Timing(event_time=datetime(2026, 1, 1, tzinfo=UTC)))
    assert r.event_time_ms == 1767225600000


def test_from_dict_builds_the_subclassed_blocks() -> None:
    parsed = AUDR.from_dict(minimal(emitter=EMITTER).to_dict())
    assert type(parsed.timing) is Timing
    assert type(parsed.attribution) is record_module.Attribution


def _literal_values(annotation: Any) -> set[Any]:
    if get_origin(annotation) is Literal:
        return set(get_args(annotation))
    values: set[Any] = set()
    for arg in get_args(annotation):
        if arg is not type(None):
            values |= _literal_values(arg)
    return values


@pytest.mark.parametrize(
    ("alias_name", "model", "field"),
    [
        ("EmitterComponent", gen.Emitter, "component"),
        ("ResourceType", gen.Resource, "type"),
        ("Operation", gen.Resource, "operation"),
        ("Modality", gen.Resource, "modality"),
        ("RunType", gen.Run, "run_type"),
        ("RunOutcome", gen.Run, "outcome"),
        ("Environment", gen.Attribution, "environment"),
    ],
)
def test_literal_aliases_track_the_generated_model(
    alias_name: str, model: type[BaseModel], field: str
) -> None:
    alias = getattr(record_module, alias_name)
    assert _literal_values(alias) == _literal_values(model.model_fields[field].annotation)
    assert _literal_values(alias)


def test_extension_counters_reject_non_finite_numbers() -> None:
    with pytest.raises(pydantic.ValidationError):
        LlmUsage(input_tokens=1, x_acme_ratio=math.nan)
    with pytest.raises(pydantic.ValidationError):
        LlmUsage(input_tokens=1, x_acme_ratio=math.inf)


def test_extension_counters_reject_booleans() -> None:
    with pytest.raises(pydantic.ValidationError):
        LlmUsage(input_tokens=1, x_acme_flag=True)
