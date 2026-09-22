import httpx
import pytest
from audr import ConfigurationError

from audr_sink_chargebee._transport import (
    HttpTransportConfig,
    _ClientClosedError,
    _LazyAsyncHttpClient,
)


def test_http_transport_config_defaults_and_override() -> None:
    defaults = HttpTransportConfig()
    overridden = HttpTransportConfig(read_timeout=20.0)

    assert defaults.connect_timeout == 5.0
    assert defaults.read_timeout == 10.0
    assert defaults.write_timeout == 10.0
    assert defaults.pool_timeout == 5.0
    assert defaults.max_connections == 10
    assert defaults.max_keepalive_connections == 5
    assert overridden.read_timeout == 20.0
    assert overridden.connect_timeout == defaults.connect_timeout
    assert overridden.write_timeout == defaults.write_timeout
    assert overridden.pool_timeout == defaults.pool_timeout
    assert overridden.max_connections == defaults.max_connections
    assert overridden.max_keepalive_connections == defaults.max_keepalive_connections


@pytest.mark.parametrize(
    ("kwargs", "field"),
    [
        ({"connect_timeout": 0}, "connect_timeout"),
        ({"read_timeout": float("nan")}, "read_timeout"),
        ({"write_timeout": float("inf")}, "write_timeout"),
        ({"pool_timeout": True}, "pool_timeout"),
        ({"max_connections": 0}, "max_connections"),
        ({"max_connections": 1.5}, "max_connections"),
        ({"max_keepalive_connections": -1}, "max_keepalive_connections"),
        (
            {"max_connections": 1, "max_keepalive_connections": 2},
            "max_keepalive_connections",
        ),
    ],
)
def test_http_transport_config_rejects_invalid_values(
    kwargs: dict[str, object], field: str
) -> None:
    with pytest.raises(ConfigurationError, match=field):
        HttpTransportConfig(**kwargs)  # type: ignore[arg-type]


def test_http_client_construction_is_lazy_and_needs_no_event_loop() -> None:
    client = _LazyAsyncHttpClient(config=HttpTransportConfig())

    assert client._client is None
    assert not client.closed


async def test_http_client_is_built_once_and_reused() -> None:
    requests = 0

    async def handler(_: httpx.Request) -> httpx.Response:
        nonlocal requests
        requests += 1
        return httpx.Response(200)

    client = _LazyAsyncHttpClient(
        config=HttpTransportConfig(),
        transport=httpx.MockTransport(handler),
    )

    await client.post("https://example.test/one", content=b"", headers={})
    pooled_client = client._client
    await client.post("https://example.test/two", content=b"", headers={})

    assert requests == 2
    assert client._client is pooled_client
    await client.close()


async def test_http_client_does_not_follow_a_redirect_away_from_the_validated_origin() -> None:
    visited: list[str] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        visited.append(str(request.url))
        if request.url.host == "acme.ingest.chargebee.test":
            return httpx.Response(302, headers={"Location": "https://attacker.test/steal"})
        return httpx.Response(200)

    client = _LazyAsyncHttpClient(
        config=HttpTransportConfig(),
        transport=httpx.MockTransport(handler),
    )

    response = await client.post(
        "https://acme.ingest.chargebee.test/api/v2/batch/usage_events",
        content=b"",
        headers={"Authorization": "Basic secret"},
    )

    assert response.status_code == 302
    assert visited == ["https://acme.ingest.chargebee.test/api/v2/batch/usage_events"]
    await client.close()


async def test_http_client_close_is_terminal_and_idempotent() -> None:
    requests = 0

    async def handler(_: httpx.Request) -> httpx.Response:
        nonlocal requests
        requests += 1
        return httpx.Response(200)

    client = _LazyAsyncHttpClient(
        config=HttpTransportConfig(),
        transport=httpx.MockTransport(handler),
    )
    await client.post("https://example.test", content=b"", headers={})

    await client.close()
    await client.close()

    assert client.closed
    with pytest.raises(_ClientClosedError):
        await client.post("https://example.test", content=b"", headers={})
    assert requests == 1
