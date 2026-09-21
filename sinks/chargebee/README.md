# Chargebee

A [sink](../README.md) that delivers [AUDR](../../spec/SPEC.md) records to a Chargebee
site's usage-ingest batch endpoint, for Chargebee Usage-Based Billing. Chargebee routes on
`attribution.subscription_id` and de-duplicates on `record_id`; a record without a
`subscription_id` is rejected by name rather than sent.

| Language | Distribution | Package guide |
| --- | --- | --- |
| [Python](python/) | [![PyPI](https://img.shields.io/pypi/v/audr-sink-chargebee?include_prereleases&label=audr-sink-chargebee)](https://pypi.org/project/audr-sink-chargebee/) | [`python/README.md`](python/README.md) — install, configuration, routing and delivery semantics, data handling |

To contribute a change, see [`python/AGENTS.md`](python/AGENTS.md). To contribute a new
sink, see [`../CONTRIBUTING.md`](../CONTRIBUTING.md).
