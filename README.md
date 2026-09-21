# AUDR — Agent Usage Detail Record

[![Spec](https://github.com/openaudr/audr/actions/workflows/spec-verify.yml/badge.svg)](https://github.com/openaudr/audr/actions/workflows/spec-verify.yml)
[![Core SDK](https://github.com/openaudr/audr/actions/workflows/adapter-core-python-verify.yml/badge.svg)](https://github.com/openaudr/audr/actions/workflows/adapter-core-python-verify.yml)
[![LiteLLM adapter](https://github.com/openaudr/audr/actions/workflows/adapter-litellm-python-verify.yml/badge.svg)](https://github.com/openaudr/audr/actions/workflows/adapter-litellm-python-verify.yml)
[![NeMo Relay adapter](https://github.com/openaudr/audr/actions/workflows/adapter-nemo-relay-python-verify.yml/badge.svg)](https://github.com/openaudr/audr/actions/workflows/adapter-nemo-relay-python-verify.yml)
[![Chargebee sink](https://github.com/openaudr/audr/actions/workflows/sink-chargebee-python-verify.yml/badge.svg)](https://github.com/openaudr/audr/actions/workflows/sink-chargebee-python-verify.yml)

[![Spec v1.0.0](https://img.shields.io/badge/spec-v1.0.0-blue)](spec/SPEC.md)
[![PyPI](https://img.shields.io/pypi/v/audr?label=pypi%20audr)](https://pypi.org/project/audr/)
[![Python versions](https://img.shields.io/pypi/pyversions/audr)](https://pypi.org/project/audr/)
[![License Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue)](LICENSE)

An open standard for recording who initiated an agent run and what each step
cost, across every system the run passes through.

A single agent run touches several systems. The application knows the customer
and the feature. The router knows the model, the tokens and the price. The
provider knows the cache split. The harness knows whether the run actually
resolved anything. Every layer is observable on its own, and none of them can
tell you what that customer's agent cost you last month.

AUDR is one JSON record per metered operation, carrying enough identity and
attribution that the records join.

```json
{
  "spec_version": "1.0.0",
  "record_id": "01K4N8D2J4P7Q9R3S6T8V1W5XY",
  "emitter": { "component": "router", "name": "@audr/openrouter", "version": "0.5.1" },
  "timing": { "event_time": "2026-09-08T12:00:00.000Z" },
  "resource": {
    "provider": "anthropic",
    "type": "model",
    "name": "claude-sonnet-4-20250514",
    "operation": "generation",
    "modality": "text"
  },
  "run": { "run_id": "01K4N8B0M2C5F7H9J1L3N6P8QR", "span_id": "model-call-1" },
  "attribution": { "environment": "production", "account_id": "account-42" },
  "usage": { "llm": { "input_tokens": 1200, "output_tokens": 300 } }
}
```

## Start here

| Path | Contains |
| --- | --- |
| [`spec/`](spec/SPEC.md) | The standard: [`SPEC.md`](spec/SPEC.md) to implement it, [`audr.schema.json`](spec/audr.schema.json) to validate records, [`examples/record.json`](spec/examples/record.json) for a complete record |
| [`conformance/`](conformance/README.md) | Language-neutral fixtures every implementation should reproduce |
| [`adapters/`](adapters/README.md) | Things that produce records — the [Python SDK](adapters/core/python/README.md) and runtime adapters |
| [`sinks/`](sinks/README.md) | Things that consume records — destinations such as Chargebee |
| `tools/` | The specification generator, driven by the [`Makefile`](Makefile) |

The schema's canonical URL is its `$id`:

```
https://openaudr.dev/spec/v1.0.0/audr.schema.json
```

Any JSON Schema Draft 2020-12 validator checks a record against it. In this
repository, `make examples` validates every example in the specification.

```bash
make check     # schema, examples, conformance fixtures, cross-references, staleness
make spec      # regenerate spec/SPEC.md from the schema, the outline and the prose
```

## SDKs

```bash
pip install audr
```

`0.1.0a1` is an alpha release. `pip install audr` resolves to it until a final
release is published.

```python
import audr

record = audr.AgentUsageRecord(
    timing=audr.Timing(duration_ms=812),                         # event_time defaults to now
    resource=audr.Resource(provider="anthropic", type="model", name="claude-sonnet-5",
                           operation="generation", modality="text"),
    usage=audr.Usage(llm=audr.LlmUsage(input_tokens=1200, output_tokens=340, requests=1)),
    run=audr.Run(run_id="01J8ZQ8Y2K3M4N5P6Q7R8S9T0V", span_id="turn-3", run_type="agent_run"),
    attribution=audr.Attribution(environment="production", account_id="acct_42"),
)                                                                # record_id and spec_version defaulted
```

Every record carries an emitter naming what produced it; an `audr.Client` stamps one
onto every record it delivers. The [Python SDK README](adapters/core/python/README.md)
covers the client, batching and sinks.

## Integrations

Runtime adapters turn framework and router events into records for the same client:

```bash
pip install audr-adapter-litellm
pip install "audr-adapter-nemo-relay[runtime]"
```

See the [LiteLLM adapter](adapters/litellm/python/README.md) for SDK and Router model
usage, and the [NeMo Relay adapter](adapters/nemo-relay/python/README.md) for Relay LLM
and tool scopes.

## Status

The current specification version is [1.0.0](spec/SPEC.md).

## Governance

AUDR was drafted at Chargebee, and is being improved with collaboration across
the ecosystem. Granular cost and usage instrumentation are foundational to agent
unit economics — the infrastructure every team building or monetizing agents
will need. We believe that infrastructure should be open, neutral, and
community-owned. As adoption grows, the goal is to move cost governance to an
independent foundation.

Stewarded by Chargebee. Contact us at <audr@chargebee.com>.

## Contributing

Tell us where AUDR breaks for a cost model you have and we haven't imagined.
[Open an issue](https://github.com/openaudr/audr/issues) or email
<audr@chargebee.com>. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

To report a vulnerability, follow [SECURITY.md](SECURITY.md). It also states the
data-handling rules the format depends on: records carry no prompt content, no
key material, and no PII.

## License

[Apache 2.0](LICENSE). See [NOTICE](NOTICE).
