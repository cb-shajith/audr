import importlib.util

import pytest


@pytest.fixture(autouse=True, scope="session")
def _core_has_no_http_dependency() -> None:
    # The core must never grow an HTTP dependency; the dev environment must not have one either.
    assert importlib.util.find_spec("httpx") is None, (
        "httpx must not be installed in the core dev env"
    )
