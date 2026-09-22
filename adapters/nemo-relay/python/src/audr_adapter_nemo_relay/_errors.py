"""Exceptions, stable codes, and value-free messages for the NeMo Relay plugin."""

from enum import StrEnum

from audr import ConfigurationError, LifecycleError


class NeMoRelayCompatibilityError(ConfigurationError):
    """The installed NeMo Relay package is unavailable or unsupported."""


class NeMoRelayActivationError(LifecycleError):
    """Relay activation cannot proceed with this integration instance."""


class NeMoRelayDiagnosticCode(StrEnum):
    """Machine-stable codes returned from Relay component validation.

    These use Relay's dotted lowercase diagnostic vocabulary, not the SDK's
    ``AUDR_`` prefix, because Relay reports them alongside its own codes.
    """

    INVALID_ATTRIBUTION = "audr.invalid_attribution"
    INVALID_ATTRIBUTION_FIELD = "audr.invalid_attribution_field"
    INVALID_ATTRIBUTION_VALUE = "audr.invalid_attribution_value"
    INVALID_BOUND = "audr.invalid_bound"
    UNKNOWN_FIELD = "audr.unknown_field"
    UNSUPPORTED_RELAY_VERSION = "audr.unsupported_relay_version"

    @property
    def message(self) -> str:
        """Human-readable explanation that contains no configuration values."""
        return _MESSAGES[self]


class NeMoRelayRunErrorCode(StrEnum):
    """Machine-stable operation errors written to AUDR ``run.error_code``.

    These follow the SDK's :class:`AudrErrorCode` casing, not Relay's, because
    they travel on the emitted record rather than through Relay diagnostics.
    """

    TOOL_ERROR = "NEMO_RELAY_TOOL_ERROR"


_MESSAGES: dict[NeMoRelayDiagnosticCode, str] = {
    NeMoRelayDiagnosticCode.INVALID_ATTRIBUTION: "attribution_defaults must be an object.",
    NeMoRelayDiagnosticCode.INVALID_ATTRIBUTION_FIELD: (
        "attribution contains a field this integration cannot bill on."
    ),
    NeMoRelayDiagnosticCode.INVALID_ATTRIBUTION_VALUE: (
        "An attribution value is missing, empty, or not of the required type."
    ),
    NeMoRelayDiagnosticCode.INVALID_BOUND: "The bound is not an integer within its allowed range.",
    NeMoRelayDiagnosticCode.UNKNOWN_FIELD: "The component config field is not supported.",
    NeMoRelayDiagnosticCode.UNSUPPORTED_RELAY_VERSION: (
        "The installed NeMo Relay release is outside the supported range."
    ),
}
