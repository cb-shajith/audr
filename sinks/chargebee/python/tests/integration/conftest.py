import os

import pytest


@pytest.fixture(autouse=True)
def block_real_http() -> None:
    """Override the unit-test network block; these tests exist to reach the network."""


@pytest.fixture(autouse=True)
def isolate_credential_env() -> None:
    """Override the unit-test env scrub; these tests are configured through it."""


@pytest.fixture(scope="session")
def live_ingest_url() -> str:
    return _required_env("CHARGEBEE_INGEST_URL")


@pytest.fixture(scope="session")
def live_api_key() -> str:
    return _required_env("CHARGEBEE_API_KEY")


@pytest.fixture(scope="session")
def live_subscription_id() -> str:
    """A subscription on the live site that usage may be recorded against."""
    return _required_env("CHARGEBEE_TEST_SUBSCRIPTION_ID")


def _required_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        pytest.skip(f"{name} is not set")
    return value
