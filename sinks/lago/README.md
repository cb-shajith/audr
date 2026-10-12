# Lago

A [sink](../README.md) that delivers [AUDR](../../spec/SPEC.md) records to Lago's batch event
endpoint, for usage-based billing. Lago routes on `attribution.subscription_id` and
de-duplicates on `record_id`; a record without a `subscription_id`, or one that corrects
another record, is rejected by name rather than sent.

| Language | Distribution | Package guide |
| --- | --- | --- |
| [TypeScript](typescript/) | [![npm](https://img.shields.io/npm/v/@openaudr/audr-sink-lago?include_prereleases&label=%40openaudr%2Faudr-sink-lago)](https://www.npmjs.com/package/@openaudr/audr-sink-lago) | [`typescript/README.md`](typescript/README.md) — setup, usage, configuration, delivery; the full reference is [`typescript/docs/reference.md`](typescript/docs/reference.md) |

To contribute a change, see [`typescript/AGENTS.md`](typescript/AGENTS.md). To contribute a
new sink, see [`../CONTRIBUTING.md`](../CONTRIBUTING.md).
