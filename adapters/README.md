# Adapters

An adapter observes a harness, router, or other agent runtime and turns its own events
into [AUDR](../spec/SPEC.md) records, which it hands to a `Client` built on the
[core SDK](core/). It never talks to a destination directly — that is a sink's job.

The core SDK is located here because every adapter depends on it, and because an
application that emits records directly uses the core alone: the null adapter.

| Adapter | Directory | PyPI | Status |
| --- | --- | --- | --- |
| Core (null adapter) | [`core/`](core/) | `audr` | Pre-release `0.1.0a1` |
| NVIDIA NeMo Relay | [`nemo-relay/`](nemo-relay/) | `audr-adapter-nemo-relay` | Experimental |

See [`sinks/`](../sinks/) for where records go once an adapter emits them, and
[CONTRIBUTING.md](../CONTRIBUTING.md) for how to propose a new adapter.
