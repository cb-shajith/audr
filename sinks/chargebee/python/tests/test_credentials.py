import base64

import httpx
import pytest
from audr import Attribution, ConfigurationError
from audr.testing import make_record

from audr_sink_chargebee import ChargebeeSink
from audr_sink_chargebee._credentials import ApiKey, IngestEndpoint, resolve_credentials

_ACME_ORIGIN = "https://acme.ingest.chargebee.com"
_DEV_ORIGIN = "https://acme-test.ingest.chargebee.com"


@pytest.mark.parametrize(
    "ingest_url",
    [
        _ACME_ORIGIN,
        f"{_ACME_ORIGIN}/",
        f"{_ACME_ORIGIN}/api/v2/batch/usage_events",
    ],
)
def test_ingest_endpoint_accepts_supported_url_forms(ingest_url: str) -> None:
    assert IngestEndpoint.parse(ingest_url).origin == _ACME_ORIGIN


def test_ingest_endpoint_accepts_non_production_origin() -> None:
    assert IngestEndpoint.parse(_DEV_ORIGIN).origin == _DEV_ORIGIN


@pytest.mark.parametrize(
    ("ingest_url", "match"),
    [
        ("http://acme.ingest.chargebee.com", "scheme"),
        ("https://ACME.ingest.chargebee.com", "lowercase"),
        ("https://acme", "two labels"),
        ("https://acme.ingest.chargebee.com:443", "port"),
        ("https://user:pass@acme.ingest.chargebee.com", "userinfo"),
        ("https://acme.ingest.chargebee.com?x=1", "query"),
        (f"{_ACME_ORIGIN}/api/v2/usage_events", "batch endpoint"),
        ("https://acme.ingest.chargebee.com#frag", "fragment"),
        ("https://acme.ingest.chargebee.com/evil/path", "path"),
        ("https://acme.ingest.chargebee.com.", "trailing dot"),
        ("https://", "host name"),
        ("https:///api/v2/batch/usage_events", "host name"),
    ],
)
def test_ingest_endpoint_rejects_unsafe_or_unsupported_urls(ingest_url: str, match: str) -> None:
    with pytest.raises(ConfigurationError, match=match):
        IngestEndpoint.parse(ingest_url)


def test_api_key_redacts_representations_and_builds_basic_header() -> None:
    key = ApiKey("test_key")

    assert key.basic_auth_header() == f"Basic {base64.b64encode(b'test_key:').decode()}"
    assert str(key) == "ApiKey(***)"
    assert repr(key) == "ApiKey(***)"
    assert "test_key" not in f"{key}"


@pytest.mark.parametrize("value", ["", "  "])
def test_api_key_rejects_empty_values_without_leaking_them(value: str) -> None:
    with pytest.raises(ConfigurationError) as error:
        ApiKey(value)

    assert "api_key" in str(error.value)
    assert "CHARGEBEE_API_KEY" in str(error.value)
    if value:
        assert value not in str(error.value)


def test_resolve_credentials_reads_ingest_url_and_api_key_from_the_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CHARGEBEE_INGEST_URL", _DEV_ORIGIN)
    monkeypatch.setenv("CHARGEBEE_API_KEY", "from-env-key")

    endpoint, api_key = resolve_credentials()

    assert endpoint.origin == _DEV_ORIGIN
    assert api_key.raw_value == "from-env-key"


def test_resolve_credentials_prefers_explicit_values_over_the_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CHARGEBEE_INGEST_URL", _DEV_ORIGIN)
    monkeypatch.setenv("CHARGEBEE_API_KEY", "from-env-key")

    endpoint, api_key = resolve_credentials(
        ingest_url=_ACME_ORIGIN,
        api_key="explicit-key",
    )

    assert endpoint.origin == _ACME_ORIGIN
    assert api_key.raw_value == "explicit-key"


def test_resolve_credentials_reports_missing_ingest_url_with_an_example() -> None:
    with pytest.raises(ConfigurationError) as error:
        resolve_credentials(api_key="test-key")

    message = str(error.value)
    assert "ingest_url" in message
    assert "CHARGEBEE_INGEST_URL" in message
    assert _ACME_ORIGIN in message


def test_resolve_credentials_reports_missing_api_key_without_secret() -> None:
    with pytest.raises(ConfigurationError) as error:
        resolve_credentials(ingest_url=_ACME_ORIGIN)

    assert "api_key" in str(error.value)
    assert "CHARGEBEE_API_KEY" in str(error.value)


def test_resolve_credentials_builds_url_from_site_and_default_domain() -> None:
    endpoint, api_key = resolve_credentials(site="acme", api_key="test-key")

    assert endpoint.origin == _ACME_ORIGIN
    assert api_key.raw_value == "test-key"


def test_resolve_credentials_ingest_domain_overrides_the_default() -> None:
    endpoint, _ = resolve_credentials(
        site="acme",
        api_key="test-key",
        ingest_domain="ingest.example.test",
    )

    assert endpoint.origin == "https://acme.ingest.example.test"


def test_resolve_credentials_reads_ingest_domain_from_the_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CHARGEBEE_INGEST_DOMAIN", "ingest.example.test")

    endpoint, _ = resolve_credentials(site="acme", api_key="test-key")

    assert endpoint.origin == "https://acme.ingest.example.test"


def test_resolve_credentials_rejects_invalid_site() -> None:
    with pytest.raises(ConfigurationError, match="site"):
        resolve_credentials(site="Acme_Site!", api_key="test-key")


def test_resolve_credentials_rejects_invalid_ingest_domain() -> None:
    with pytest.raises(ConfigurationError, match="ingest_domain"):
        resolve_credentials(site="acme", api_key="test-key", ingest_domain="not-a-domain")


def test_resolve_credentials_rejects_region_kwarg() -> None:
    with pytest.raises(TypeError):
        resolve_credentials(site="acme", api_key="test-key", region="eu")  # type: ignore[call-arg]


def test_resolve_credentials_rejects_ingest_url_combined_with_site() -> None:
    with pytest.raises(ConfigurationError, match="mutually exclusive"):
        resolve_credentials(ingest_url=_ACME_ORIGIN, api_key="test-key", site="acme")


def test_resolve_credentials_rejects_ingest_url_combined_with_ingest_domain() -> None:
    with pytest.raises(ConfigurationError, match="mutually exclusive"):
        resolve_credentials(
            ingest_url=_ACME_ORIGIN, api_key="test-key", ingest_domain="ingest.chargebee.eu"
        )


def test_resolve_credentials_reports_missing_site_or_ingest_url() -> None:
    with pytest.raises(ConfigurationError) as error:
        resolve_credentials(api_key="test-key")

    message = str(error.value)
    assert "site" in message
    assert "CHARGEBEE_SITE" in message
    assert "ingest_url" in message


def test_resolve_credentials_reads_site_from_the_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CHARGEBEE_SITE", "acme")
    monkeypatch.setenv("CHARGEBEE_API_KEY", "from-env-key")

    endpoint, api_key = resolve_credentials()

    assert endpoint.origin == _ACME_ORIGIN
    assert api_key.raw_value == "from-env-key"


def test_resolve_credentials_prefers_explicit_site_and_domain_over_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CHARGEBEE_SITE", "other-site")
    monkeypatch.setenv("CHARGEBEE_INGEST_DOMAIN", "ingest.example.test")

    endpoint, _ = resolve_credentials(
        site="acme", ingest_domain="ingest.chargebee.com", api_key="test-key"
    )

    assert endpoint.origin == _ACME_ORIGIN


def test_resolve_credentials_ingest_url_still_works_and_is_validated(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CHARGEBEE_INGEST_URL", _DEV_ORIGIN)
    monkeypatch.setenv("CHARGEBEE_API_KEY", "from-env-key")

    endpoint, api_key = resolve_credentials()

    assert endpoint.origin == _DEV_ORIGIN
    assert api_key.raw_value == "from-env-key"

    with pytest.raises(ConfigurationError, match="scheme"):
        resolve_credentials(ingest_url="http://acme.ingest.chargebee.com", api_key="test-key")


def test_sink_accepts_site_and_api_key() -> None:
    sink = ChargebeeSink(site="acme", api_key="test_key")

    assert repr(sink) == f"ChargebeeSink(origin={_ACME_ORIGIN!r})"


def test_sink_rejects_region_kwarg() -> None:
    with pytest.raises(TypeError):
        ChargebeeSink(site="acme", api_key="test_key", region="eu")  # type: ignore[call-arg]


def test_sink_rejects_ingest_url_combined_with_site() -> None:
    with pytest.raises(ConfigurationError, match="mutually exclusive"):
        ChargebeeSink(site="acme", ingest_url=_ACME_ORIGIN, api_key="test_key")


async def test_sink_resolves_environment_credentials_once(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CHARGEBEE_INGEST_URL", _ACME_ORIGIN)
    monkeypatch.setenv("CHARGEBEE_API_KEY", "original-key")
    authorization_headers: list[str] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        authorization_headers.append(request.headers["Authorization"])
        return httpx.Response(202)

    sink = ChargebeeSink(transport=httpx.MockTransport(handler))
    monkeypatch.setenv("CHARGEBEE_API_KEY", "changed-key")

    record = make_record(attribution=Attribution(environment="test", subscription_id="sub_123"))
    await sink.deliver([record])

    assert authorization_headers == ["Basic b3JpZ2luYWwta2V5Og=="]
    await sink.close()
