"""Chargebee sink for AUDR.

Delivers AUDR usage records to a site's usage-ingest batch endpoint.

    import audr
    from audr_sink_chargebee import ChargebeeSink

    async with audr.Client(ChargebeeSink(site="acme", api_key=...)) as client:
        client.record(record)

Credentials come from ``CHARGEBEE_SITE`` and ``CHARGEBEE_API_KEY`` unless
passed explicitly as ``site``/``api_key``. The ingest domain defaults to
``ingest.chargebee.com``; override it with ``CHARGEBEE_INGEST_DOMAIN`` (or
``ingest_domain=``). ``ingest_url`` (or ``CHARGEBEE_INGEST_URL``) sets the full
origin directly for any other host. Credentials belong to
the sink, never to the core client.
"""

from audr_sink_chargebee._event import UsageEvent
from audr_sink_chargebee._flatten import PropertyValue, flatten_audr
from audr_sink_chargebee._retry import FailureClass, RetryPolicy
from audr_sink_chargebee._sink import ChargebeeSink
from audr_sink_chargebee._transport import HttpTransportConfig
from audr_sink_chargebee._version import __version__

__all__ = [
    "ChargebeeSink",
    "FailureClass",
    "HttpTransportConfig",
    "PropertyValue",
    "RetryPolicy",
    "UsageEvent",
    "__version__",
    "flatten_audr",
]
