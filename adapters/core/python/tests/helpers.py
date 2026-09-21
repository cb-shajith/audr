"""Record builders shared by the test-suite."""

from __future__ import annotations

from typing import Any

from audr.record import (
    AgentUsageRecord,
    Attribution,
    Emitter,
    LlmUsage,
    Resource,
    Run,
    Timing,
    Usage,
)

EMITTER = Emitter(component="harness", name="h", version="1")


def minimal(**overrides: Any) -> AgentUsageRecord:
    """The smallest record the model accepts, with `overrides` applied."""
    base: dict[str, Any] = {
        "timing": Timing(duration_ms=10),
        "resource": Resource(
            provider="anthropic",
            type="model",
            name="claude-sonnet-5",
            operation="generation",
            modality="text",
        ),
        "usage": Usage(llm=LlmUsage(input_tokens=1, output_tokens=1)),
        "run": Run(run_id="01J8ZQ8Y2K3M4N5P6Q7R8S9T0V", span_id="s1"),
        "attribution": Attribution(environment="test"),
    }
    base.update(overrides)
    return AgentUsageRecord(**base)
