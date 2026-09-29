"""LiteLLM integration for attributed AUDR model usage."""

from importlib import import_module
from typing import TYPE_CHECKING

from audr_adapter_litellm._config import LiteLLMConfig
from audr_adapter_litellm._errors import LiteLLMActivationError, LiteLLMRunErrorCode
from audr_adapter_litellm._version import __version__

if TYPE_CHECKING:
    from audr_adapter_litellm._callback import LiteLLMAudrCallback

__all__ = [
    "LiteLLMActivationError",
    "LiteLLMAudrCallback",
    "LiteLLMConfig",
    "LiteLLMRunErrorCode",
    "__version__",
]


def __getattr__(name: str) -> object:
    """Load the LiteLLM-dependent callback only when it is activated."""
    if name != "LiteLLMAudrCallback":
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    try:
        module = import_module("audr_adapter_litellm._callback")
    except ModuleNotFoundError as error:
        if error.name != "litellm":
            raise
        raise LiteLLMActivationError(
            "LiteLLM is required to activate the callback; install the runtime extra"
        ) from error
    callback: object = getattr(module, name)
    return callback
