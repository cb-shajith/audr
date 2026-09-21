"""HTTP transport configuration and lazy client lifecycle."""

from __future__ import annotations

import asyncio
from collections.abc import Mapping
from dataclasses import dataclass
from math import isfinite

import httpx
from audr import ConfigurationError


@dataclass(frozen=True, slots=True)
class HttpTransportConfig:
    """Explicit timeouts and connection-pool limits for HTTP sinks."""

    connect_timeout: float = 5.0
    read_timeout: float = 10.0
    write_timeout: float = 10.0
    pool_timeout: float = 5.0
    max_connections: int = 10
    max_keepalive_connections: int = 5

    def __post_init__(self) -> None:
        for name in ("connect_timeout", "read_timeout", "write_timeout", "pool_timeout"):
            value = getattr(self, name)
            if isinstance(value, bool) or not isinstance(value, int | float) or not isfinite(value):
                raise ConfigurationError(f"{name} must be a finite number")
            if value <= 0:
                raise ConfigurationError(f"{name} must be greater than 0")
        for name in ("max_connections", "max_keepalive_connections"):
            value = getattr(self, name)
            if isinstance(value, bool) or not isinstance(value, int):
                raise ConfigurationError(f"{name} must be an integer")
        if self.max_connections < 1:
            raise ConfigurationError("max_connections must be at least 1")
        if self.max_keepalive_connections < 0:
            raise ConfigurationError("max_keepalive_connections must be non-negative")
        if self.max_keepalive_connections > self.max_connections:
            raise ConfigurationError("max_keepalive_connections must not exceed max_connections")


class _ClientClosedError(RuntimeError):
    """Raised when a request reaches a terminally closed client."""


class _LazyAsyncHttpClient:
    """Own one lazily initialized, terminally closeable HTTP client."""

    def __init__(
        self,
        *,
        config: HttpTransportConfig,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._config = config
        self._transport = transport
        self._client: httpx.AsyncClient | None = None
        self._lock = asyncio.Lock()
        self._closed = False

    @property
    def closed(self) -> bool:
        return self._closed

    async def post(
        self,
        url: str,
        *,
        content: bytes,
        headers: Mapping[str, str],
    ) -> httpx.Response:
        client = await self._get_client()
        try:
            return await client.post(url, content=content, headers=headers)
        except RuntimeError as error:
            if self._closed:
                raise _ClientClosedError from error
            raise

    async def close(self) -> None:
        async with self._lock:
            if self._closed:
                return
            self._closed = True
            client = self._client

        if client is not None:
            await client.aclose()

    async def _get_client(self) -> httpx.AsyncClient:
        async with self._lock:
            if self._closed:
                raise _ClientClosedError
            if self._client is None:
                config = self._config
                self._client = httpx.AsyncClient(
                    timeout=httpx.Timeout(
                        connect=config.connect_timeout,
                        read=config.read_timeout,
                        write=config.write_timeout,
                        pool=config.pool_timeout,
                    ),
                    limits=httpx.Limits(
                        max_connections=config.max_connections,
                        max_keepalive_connections=config.max_keepalive_connections,
                    ),
                    transport=self._transport,
                    verify=True,
                    # The validated origin is the sole destination for a request carrying
                    # the API key. Following a redirect would hand it to a host no
                    # credential check ever saw, so this must not depend on an httpx default.
                    follow_redirects=False,
                )
            return self._client
