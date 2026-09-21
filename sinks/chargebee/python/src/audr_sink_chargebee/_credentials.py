"""Credential validation, resolution, and safe rendering."""

from __future__ import annotations

import base64
import os
import re
from dataclasses import dataclass
from urllib.parse import urlparse

from audr import ConfigurationError

_HOST_LABEL = r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
_HOST_PATTERN = re.compile(rf"^{_HOST_LABEL}(?:\.{_HOST_LABEL})+$")

_ACCEPTED_PATHS = frozenset({"", "/", "/api/v2/batch/usage_events"})
_INGEST_URL_EXAMPLE = "https://acme.ingest.chargebee.com"
_BATCH_PATH = "/api/v2/batch/usage_events"

_SITE_PATTERN = re.compile(rf"^{_HOST_LABEL}$")

# The official Chargebee batch ingest domain; it is not site- or geography-specific.
DEFAULT_INGEST_DOMAIN = "ingest.chargebee.com"


@dataclass(frozen=True, slots=True)
class IngestEndpoint:
    """A validated Chargebee usage-ingest origin."""

    origin: str

    @classmethod
    def parse(cls, ingest_url: str) -> IngestEndpoint:
        """Parse a full ingest URL and return the sole permitted origin."""
        parsed = urlparse(ingest_url)

        if parsed.scheme != "https":
            raise ConfigurationError("ingest_url scheme must be https")

        if parsed.username is not None or parsed.password is not None:
            raise ConfigurationError("ingest_url must not include userinfo")

        if parsed.port is not None:
            raise ConfigurationError("ingest_url must not include a port")

        if parsed.query:
            raise ConfigurationError("ingest_url must not include a query string")

        if parsed.fragment:
            raise ConfigurationError("ingest_url must not include a fragment")

        raw_host_match = re.match(r"^https://([^/?#]+)", ingest_url)
        if raw_host_match is None:
            raise ConfigurationError("ingest_url must include a host name")
        raw_host = raw_host_match.group(1).split("@")[-1]
        if raw_host.endswith("."):
            raise ConfigurationError("ingest_url host must not have a trailing dot")
        if raw_host != raw_host.lower():
            raise ConfigurationError("ingest_url host must be lowercase")

        hostname = parsed.hostname
        if hostname is None or not hostname:
            raise ConfigurationError("ingest_url must include a host name")

        # The host is matched against a dotted host-label pattern that admits no scheme,
        # port, path, or userinfo. Relaxing it would let a configured value redirect an
        # authenticated POST, and the API key with it.
        if not _HOST_PATTERN.fullmatch(hostname):
            raise ConfigurationError(
                "ingest_url host must be a dotted lowercase host name with at least two labels"
            )

        path = parsed.path or ""
        if path not in _ACCEPTED_PATHS:
            raise ConfigurationError(
                "ingest_url path must be empty, /, or /api/v2/batch/usage_events; the SDK "
                "only calls the batch endpoint"
            )

        return cls(origin=f"https://{hostname}")


@dataclass(frozen=True, slots=True, repr=False)
class ApiKey:
    """A Chargebee API key whose standard string representations are redacted."""

    _value: str

    def __post_init__(self) -> None:
        if not self._value.strip():
            raise ConfigurationError("api_key must not be empty; set CHARGEBEE_API_KEY")

    @property
    def raw_value(self) -> str:
        """Return the key value for the HTTP authorization boundary only."""
        return self._value

    def basic_auth_header(self) -> str:
        """Return HTTP Basic credentials with this key as username and no password."""
        encoded = base64.b64encode(f"{self._value}:".encode()).decode()
        return f"Basic {encoded}"

    def __repr__(self) -> str:
        return "ApiKey(***)"

    def __str__(self) -> str:
        return "ApiKey(***)"


def resolve_credentials(
    *,
    site: str | None = None,
    api_key: str | None = None,
    ingest_domain: str | None = None,
    ingest_url: str | None = None,
) -> tuple[IngestEndpoint, ApiKey]:
    """Resolve credentials once, prioritizing explicit values over environment values.

    The primary configuration mirrors the official Chargebee SDK: `site` (plus
    `ingest_domain`) and `api_key`. `ingest_url` remains as an escape hatch
    for hosts other than the default ingest domain; it is mutually exclusive
    with `site`/`ingest_domain`.
    """
    resolved_api_key = api_key if api_key is not None else os.environ.get("CHARGEBEE_API_KEY")
    if resolved_api_key is None:
        raise ConfigurationError("api_key is required; provide api_key or set CHARGEBEE_API_KEY")

    resolved_ingest_url = (
        ingest_url if ingest_url is not None else os.environ.get("CHARGEBEE_INGEST_URL")
    )

    if resolved_ingest_url is not None:
        if site is not None or ingest_domain is not None:
            raise ConfigurationError("ingest_url is mutually exclusive with site/ingest_domain")
        return IngestEndpoint.parse(resolved_ingest_url), ApiKey(resolved_api_key)

    resolved_site = site if site is not None else os.environ.get("CHARGEBEE_SITE")
    if resolved_site is None:
        raise ConfigurationError(
            "site is required; provide site (or set CHARGEBEE_SITE) or provide ingest_url "
            f"(or set CHARGEBEE_INGEST_URL, for example {_INGEST_URL_EXAMPLE})"
        )
    if not _SITE_PATTERN.fullmatch(resolved_site):
        raise ConfigurationError(
            "site must be a lowercase DNS label: letters, digits, and hyphens, and it must "
            "not start or end with a hyphen"
        )

    resolved_domain = (
        ingest_domain
        if ingest_domain is not None
        else os.environ.get("CHARGEBEE_INGEST_DOMAIN", DEFAULT_INGEST_DOMAIN)
    )
    if not _HOST_PATTERN.fullmatch(resolved_domain):
        raise ConfigurationError(
            "ingest_domain must be a dotted lowercase host name with at least two labels"
        )

    url = f"https://{resolved_site}.{resolved_domain}{_BATCH_PATH}"
    return IngestEndpoint.parse(url), ApiKey(resolved_api_key)
