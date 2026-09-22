"""Public errors and stable record error codes."""

from enum import StrEnum

from audr import LifecycleError


class LiteLLMActivationError(LifecycleError):
    """The callback was constructed or used with an invalid lifecycle."""


class LiteLLMRunErrorCode(StrEnum):
    """Machine-stable LiteLLM failures written to ``run.error_code``."""

    AUTHENTICATION = "LITELLM_AUTHENTICATION"
    CONTENT_POLICY = "LITELLM_CONTENT_POLICY"
    CONTEXT_WINDOW = "LITELLM_CONTEXT_WINDOW"
    PROVIDER_ERROR = "LITELLM_PROVIDER_ERROR"
    RATE_LIMIT = "LITELLM_RATE_LIMIT"
    TIMEOUT = "LITELLM_TIMEOUT"


__all__ = ["LiteLLMActivationError", "LiteLLMRunErrorCode"]
