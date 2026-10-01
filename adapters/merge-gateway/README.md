# Merge Gateway

An [adapter](../README.md) that wraps Merge Gateway's native SDK client and turns every
response, streamed or not, and every embedding call into an [AUDR](../../spec/SPEC.md)
record for an `@openaudr/audr` `Client` the host application owns. Token counts and the
per-call cost come from Gateway's own usage report; attribution comes from `withAudr`
scopes with configurable defaults. The adapter reads no input, output, tools or tags.

| Language | Distribution | Package guide |
| --- | --- | --- |
| [TypeScript](typescript/) | [![npm](https://img.shields.io/npm/v/@openaudr/adapter-merge-gateway?include_prereleases&label=%40openaudr%2Fadapter-merge-gateway)](https://www.npmjs.com/package/@openaudr/adapter-merge-gateway) | [`typescript/README.md`](typescript/README.md) — install, activation and shutdown, attribution, Merge tracing, record shape |

To contribute a change, see [`typescript/AGENTS.md`](typescript/AGENTS.md). To contribute a
new adapter, see [`../CONTRIBUTING.md`](../CONTRIBUTING.md).
