"""The AUDR record: its model, its vocabularies, and its error catalog.

Everything a caller needs to build, parse, validate and serialize a record is re-exported
here; the generated schema and the rule engine behind it are private.
"""

from audr.record.codes import ErrorCode
from audr.record.models import (
    SPEC_VERSION,
    AgentUsageRecord,
    Attribution,
    Cost,
    Emitter,
    EmitterComponent,
    Environment,
    LlmCost,
    LlmUsage,
    Modality,
    Operation,
    Resource,
    ResourceType,
    Run,
    RunOutcome,
    RunType,
    Timing,
    ToolCost,
    ToolUsage,
    Usage,
)

__all__ = [
    "SPEC_VERSION",
    "AgentUsageRecord",
    "Attribution",
    "Cost",
    "Emitter",
    "EmitterComponent",
    "Environment",
    "ErrorCode",
    "LlmCost",
    "LlmUsage",
    "Modality",
    "Operation",
    "Resource",
    "ResourceType",
    "Run",
    "RunOutcome",
    "RunType",
    "Timing",
    "ToolCost",
    "ToolUsage",
    "Usage",
]
