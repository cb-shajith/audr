import subprocess
import sys

import audr
import audr.record
import audr.sinks
import audr.testing

EXPECTED_ROOT = {
    "Client",
    "AUDR",
    "Emitter",
    "Timing",
    "Resource",
    "Run",
    "Attribution",
    "Usage",
    "LlmUsage",
    "ToolUsage",
    "Cost",
    "LlmCost",
    "ToolCost",
    "SPEC_VERSION",
    "EmitterComponent",
    "ResourceType",
    "Operation",
    "Modality",
    "RunType",
    "RunOutcome",
    "Environment",
    "ValidationIssue",
    "ValidationError",
    "ErrorCode",
    "AudrError",
    "ConfigurationError",
    "LifecycleError",
    "SubmitOutcome",
    "SubmitResult",
    "FailureReason",
    "Disposition",
    "FailedRecord",
    "FailureCallback",
    "DeliveredCallback",
    "DeliveryStats",
    "Sink",
    "BatchOutcome",
    "BatchResult",
    "RejectedRecord",
    "FileFormat",
    "FileSink",
    "__version__",
}


def test_root_all_is_pinned() -> None:
    assert set(audr.__all__) == EXPECTED_ROOT


def test_sinks_all() -> None:
    assert set(audr.sinks.__all__) == {
        "Sink",
        "BatchOutcome",
        "BatchResult",
        "RejectedRecord",
        "FileFormat",
        "FileSink",
    }


def test_testing_all() -> None:
    assert set(audr.testing.__all__) == {"MemorySink", "assert_sink_contract", "make_record"}


def test_import_graph_is_minimal() -> None:
    code = (
        "import sys, audr; "
        "bad = [m for m in sys.modules if m.split('.')[0] in "
        "{'httpx','jsonschema','anyio','requests'}]; print(bad)"
    )
    out = subprocess.run(
        [sys.executable, "-c", code], capture_output=True, text=True, check=True
    ).stdout.strip()
    assert out == "[]"
