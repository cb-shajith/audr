"""Stable AUDR error codes and value-free messages.

Validation, mapping, and the client reference this catalog instead of embedding
code strings. Messages must never include record values.
"""

from __future__ import annotations

from enum import StrEnum


class ErrorCode(StrEnum):
    """Machine-stable AUDR failure codes. Members are added, never removed."""

    REQUIRED = "REQUIRED"
    FORBIDDEN = "FORBIDDEN"
    UNKNOWN_PROPERTY = "UNKNOWN_PROPERTY"
    INVALID_TYPE = "INVALID_TYPE"
    INVALID_ENUM = "INVALID_ENUM"
    INVALID_STRING = "INVALID_STRING"
    STRING_TOO_LONG = "STRING_TOO_LONG"
    INVALID_IDENTIFIER = "INVALID_IDENTIFIER"
    INVALID_DATETIME = "INVALID_DATETIME"
    MILLISECOND_PRECISION = "MILLISECOND_PRECISION"
    FUTURE_EVENT_TIME = "FUTURE_EVENT_TIME"
    INVALID_COUNTER = "INVALID_COUNTER"
    INVALID_COST = "INVALID_COST"
    INVALID_CURRENCY = "INVALID_CURRENCY"
    INVALID_PROPERTY_NAME = "INVALID_PROPERTY_NAME"
    TOO_MANY_PROPERTIES = "TOO_MANY_PROPERTIES"
    NON_PSEUDONYMOUS_ID = "NON_PSEUDONYMOUS_ID"
    EMPTY_USAGE = "EMPTY_USAGE"
    INVALID_STRUCTURE = "INVALID_STRUCTURE"
    UNSUPPORTED_VERSION = "UNSUPPORTED_VERSION"
    NOT_JSON = "NOT_JSON"


MESSAGES: dict[ErrorCode, str] = {
    ErrorCode.REQUIRED: "required property is missing",
    ErrorCode.FORBIDDEN: "property is not allowed in this context",
    ErrorCode.UNKNOWN_PROPERTY: "property is not defined by the schema",
    ErrorCode.INVALID_TYPE: "value has the wrong type",
    ErrorCode.INVALID_ENUM: "value is not one of the allowed enumerants",
    ErrorCode.INVALID_STRING: "string is missing or empty",
    ErrorCode.STRING_TOO_LONG: "string exceeds the maximum allowed length",
    ErrorCode.INVALID_IDENTIFIER: "identifier is not a ULID or UUIDv7",
    ErrorCode.INVALID_DATETIME: "value is not a valid RFC 3339 datetime",
    ErrorCode.MILLISECOND_PRECISION: "timestamp must have millisecond precision",
    ErrorCode.FUTURE_EVENT_TIME: "event_time must not be in the future",
    ErrorCode.INVALID_COUNTER: "counter must be a finite number greater than or equal to zero",
    ErrorCode.INVALID_COST: "cost amount must be a finite number greater than or equal to zero",
    ErrorCode.INVALID_CURRENCY: "currency must be a three-letter ISO 4217 code",
    ErrorCode.INVALID_PROPERTY_NAME: "property name is not a valid AUDR key",
    ErrorCode.TOO_MANY_PROPERTIES: "too many properties were provided",
    ErrorCode.NON_PSEUDONYMOUS_ID: (
        "user_id must be a pseudonymous identifier, not a raw personal value"
    ),
    ErrorCode.EMPTY_USAGE: "usage block must contain at least one counter",
    ErrorCode.INVALID_STRUCTURE: "record shape violates a cross-field rule",
    ErrorCode.UNSUPPORTED_VERSION: "spec_version is not a supported AUDR release",
    ErrorCode.NOT_JSON: "input is not valid JSON",
}

# Pydantic's own failure kinds, mapped onto the AUDR catalog. Anything absent is resolved by
# `audr.record._validate._code_for`, which handles the `datetime_*` family and the ValueError
# raised by extension checks before falling back to `INVALID_TYPE`.
PYDANTIC_TYPE_TO_CODE: dict[str, ErrorCode] = {
    "missing": ErrorCode.REQUIRED,
    "extra_forbidden": ErrorCode.UNKNOWN_PROPERTY,
    "literal_error": ErrorCode.INVALID_ENUM,
    "string_pattern_mismatch": ErrorCode.INVALID_STRING,
    "string_too_long": ErrorCode.STRING_TOO_LONG,
    "string_too_short": ErrorCode.INVALID_STRING,
    "greater_than_equal": ErrorCode.INVALID_COUNTER,
    "less_than_equal": ErrorCode.INVALID_COST,
    "too_long": ErrorCode.TOO_MANY_PROPERTIES,
    "timezone_aware": ErrorCode.INVALID_DATETIME,
    "int_type": ErrorCode.INVALID_TYPE,
    "float_type": ErrorCode.INVALID_TYPE,
    "string_type": ErrorCode.INVALID_TYPE,
    "dict_type": ErrorCode.INVALID_TYPE,
    "model_type": ErrorCode.INVALID_TYPE,
    "bool_type": ErrorCode.INVALID_TYPE,
}

__all__ = ["MESSAGES", "PYDANTIC_TYPE_TO_CODE", "ErrorCode"]
