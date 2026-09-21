"""Component configuration and public diagnostics for the NeMo Relay integration.

Validation has one source of truth: :class:`NeMoRelayConfig`. Relay supplies
arbitrary JSON, so :func:`validate_config` runs that model and translates
Pydantic's errors into Relay diagnostics rather than re-deriving the same rules
by hand. Per-scope attribution resolution lives in
:mod:`audr_adapter_nemo_relay._attribution`.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Final, TypeAlias, cast

from audr import Attribution, ConfigurationError
from pydantic import BaseModel, ConfigDict, Field, JsonValue, ValidationError, field_validator
from pydantic_core import ErrorDetails, PydanticCustomError

from audr_adapter_nemo_relay._attribution import attribution_shape_issue
from audr_adapter_nemo_relay._errors import NeMoRelayDiagnosticCode

ComponentDiagnostic: TypeAlias = dict[str, str]

PLUGIN_KIND = "audr-ingestion"

_DEFAULT_MAX_PENDING_HANDOFFS = 1000
_DEFAULT_MAX_TRACKED_SCOPES = 10_000
_MAX_PENDING_HANDOFFS_LIMIT = 100_000
_MAX_TRACKED_SCOPES_LIMIT = 1_000_000
_ATTRIBUTION_VALUE_ERROR: Final = "audr_attribution_value"


class NeMoRelayConfig(BaseModel):
    """JSON-compatible settings for one Relay plugin component.

    Constructing this directly raises :class:`pydantic.ValidationError`. Config
    arriving from Relay is reported as diagnostics by
    :func:`validate_config` and as
    :class:`~audr.ConfigurationError` by
    :func:`parse_config`.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    attribution_defaults: Attribution = Field(default_factory=Attribution)
    max_pending_handoffs: int = Field(
        default=_DEFAULT_MAX_PENDING_HANDOFFS,
        ge=1,
        le=_MAX_PENDING_HANDOFFS_LIMIT,
        strict=True,
    )
    max_tracked_scopes: int = Field(
        default=_DEFAULT_MAX_TRACKED_SCOPES,
        ge=1,
        le=_MAX_TRACKED_SCOPES_LIMIT,
        strict=True,
    )

    @field_validator("attribution_defaults")
    @classmethod
    def _reject_unbillable_defaults(cls, value: Attribution) -> Attribution:
        field_name = attribution_shape_issue(value)
        if field_name is not None:
            raise PydanticCustomError(
                _ATTRIBUTION_VALUE_ERROR,
                "attribution default cannot be billed on",
                {"field": field_name},
            )
        return value

    def to_dict(self) -> dict[str, JsonValue]:
        """Return component configuration accepted by NeMo Relay."""
        return cast("dict[str, JsonValue]", self.model_dump(mode="json", exclude_none=True))


def validate_config(config: Mapping[str, object]) -> list[ComponentDiagnostic]:
    """Return deterministic diagnostics without changing runtime state."""
    try:
        NeMoRelayConfig.model_validate(dict(config))
    except ValidationError as error:
        return _diagnostics_from(error)
    return []


def parse_config(config: Mapping[str, object]) -> NeMoRelayConfig:
    """Parse configuration, reporting the first problem as a configuration error."""
    try:
        return NeMoRelayConfig.model_validate(dict(config))
    except ValidationError as error:
        first = _diagnostics_from(error)[0]
        raise ConfigurationError(f"{first['code']} at {first['field']}") from error


def unsupported_relay_version_diagnostic() -> ComponentDiagnostic:
    """Return the diagnostic reported when the installed Relay is out of range."""
    return _diagnostic(NeMoRelayDiagnosticCode.UNSUPPORTED_RELAY_VERSION, "/")


def _diagnostics_from(error: ValidationError) -> list[ComponentDiagnostic]:
    diagnostics = [
        _diagnostic_from(detail) for detail in error.errors(include_url=False, include_input=False)
    ]
    return sorted(diagnostics, key=lambda item: (item["field"], item["code"]))


def _diagnostic_from(detail: ErrorDetails) -> ComponentDiagnostic:
    error_type = str(detail["type"])
    loc = tuple(str(part) for part in detail["loc"])

    if error_type == _ATTRIBUTION_VALUE_ERROR:
        context = detail.get("ctx") or {}
        field_name = str(context.get("field", ""))
        return _diagnostic(
            NeMoRelayDiagnosticCode.INVALID_ATTRIBUTION_VALUE,
            f"attribution_defaults.{field_name}" if field_name else "attribution_defaults",
        )
    if not loc:
        return _diagnostic(NeMoRelayDiagnosticCode.UNKNOWN_FIELD, "/")

    head = loc[0]
    if head not in NeMoRelayConfig.model_fields:
        return _diagnostic(NeMoRelayDiagnosticCode.UNKNOWN_FIELD, head)
    if head != "attribution_defaults":
        return _diagnostic(NeMoRelayDiagnosticCode.INVALID_BOUND, head)
    if len(loc) == 1:
        return _diagnostic(NeMoRelayDiagnosticCode.INVALID_ATTRIBUTION, head)
    if error_type == "extra_forbidden":
        return _diagnostic(NeMoRelayDiagnosticCode.INVALID_ATTRIBUTION_FIELD, head)
    # Deeper than `attribution_defaults.<field>` only happens inside a dict-shaped field
    # such as `labels`, where the rest of `loc` is the caller's own key or index; never
    # echo that back in a diagnostic.
    return _diagnostic(NeMoRelayDiagnosticCode.INVALID_ATTRIBUTION_VALUE, ".".join(loc[:2]))


def _diagnostic(code: NeMoRelayDiagnosticCode, field_name: str) -> ComponentDiagnostic:
    return {
        "level": "error",
        "code": code,
        "component": PLUGIN_KIND,
        "field": field_name,
        "message": code.message,
    }


__all__ = [
    "PLUGIN_KIND",
    "ComponentDiagnostic",
    "NeMoRelayConfig",
    "parse_config",
    "unsupported_relay_version_diagnostic",
    "validate_config",
]
