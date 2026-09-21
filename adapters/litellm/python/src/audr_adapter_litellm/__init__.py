"""LiteLLM integration for attributed AUDR model usage."""

from audr_adapter_litellm._callback import LiteLLMAudrCallback
from audr_adapter_litellm._config import LiteLLMConfig
from audr_adapter_litellm._errors import LiteLLMActivationError, LiteLLMRunErrorCode
from audr_adapter_litellm._version import __version__

__all__ = [
    "LiteLLMActivationError",
    "LiteLLMAudrCallback",
    "LiteLLMConfig",
    "LiteLLMRunErrorCode",
    "__version__",
]
