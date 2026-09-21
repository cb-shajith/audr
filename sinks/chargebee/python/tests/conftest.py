import httpx
import pytest

_CREDENTIAL_ENV_VARS = (
    "CHARGEBEE_INGEST_URL",
    "CHARGEBEE_API_KEY",
    "CHARGEBEE_SITE",
    "CHARGEBEE_INGEST_DOMAIN",
    "CHARGEBEE_TEST_SUBSCRIPTION_ID",
)


@pytest.fixture(autouse=True)
def isolate_credential_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep unit tests hermetic when the developer's shell has real credentials set."""
    for name in _CREDENTIAL_ENV_VARS:
        monkeypatch.delenv(name, raising=False)


@pytest.fixture(autouse=True)
def block_real_http(monkeypatch: pytest.MonkeyPatch) -> None:
    """Make every test fail if it attempts the default network transport."""

    async def reject_real_request(
        _: httpx.AsyncHTTPTransport, request: httpx.Request
    ) -> httpx.Response:
        pytest.fail(f"unexpected real HTTP request to {request.url!s}")

    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", reject_real_request)
