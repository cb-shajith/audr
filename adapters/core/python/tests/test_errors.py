import pytest

from audr.errors import (
    AudrError,
    ConfigurationError,
    LifecycleError,
    ValidationError,
    ValidationIssue,
)
from audr.record.codes import ErrorCode


def test_hierarchy() -> None:
    assert issubclass(ConfigurationError, AudrError)
    assert issubclass(LifecycleError, AudrError)
    assert issubclass(ValidationError, AudrError)


def test_issue_message_is_value_free() -> None:
    issue = ValidationIssue(code=ErrorCode.REQUIRED, path="/attribution/environment")
    assert issue.message == "required property is missing"
    assert str(issue) == "REQUIRED at /attribution/environment"


def test_validation_error_lists_issues() -> None:
    err = ValidationError(
        [ValidationIssue(ErrorCode.REQUIRED, "/a"), ValidationIssue(ErrorCode.INVALID_TYPE, "/b")]
    )
    assert len(err.issues) == 2
    assert str(err) == "2 issues: REQUIRED at /a; INVALID_TYPE at /b"
    with pytest.raises(ValueError):
        ValidationError([])
