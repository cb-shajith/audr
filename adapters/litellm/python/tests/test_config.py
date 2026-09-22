"""Configuration and public API tests."""

import pytest
from audr import Attribution
from pydantic import ValidationError

import audr_adapter_litellm
from audr_adapter_litellm import LiteLLMConfig


def test_public_api_is_deliberate() -> None:
    assert audr_adapter_litellm.__all__ == [
        "LiteLLMActivationError",
        "LiteLLMAudrCallback",
        "LiteLLMConfig",
        "LiteLLMRunErrorCode",
        "__version__",
    ]


def test_config_defaults_are_bounded() -> None:
    config = LiteLLMConfig()

    assert config.attribution_defaults == Attribution()
    assert config.max_pending_handoffs == 1000


@pytest.mark.parametrize("value", [0, 100_001, True, 1.5])
def test_invalid_handoff_bound_is_rejected(value: object) -> None:
    with pytest.raises(ValidationError):
        LiteLLMConfig(max_pending_handoffs=value)  # type: ignore[arg-type]


def test_non_pseudonymous_default_is_rejected() -> None:
    with pytest.raises(ValidationError, match="cannot be billed"):
        LiteLLMConfig(
            attribution_defaults=Attribution(environment="test", user_id="user@example.com")
        )


def test_config_is_frozen_and_rejects_unknown_fields() -> None:
    config = LiteLLMConfig()
    with pytest.raises(ValidationError):
        config.max_pending_handoffs = 3  # type: ignore[misc]
    with pytest.raises(ValidationError):
        LiteLLMConfig.model_validate({"unexpected": True})
