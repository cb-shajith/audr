# AGENTS.md

Directives for working inside this package. Tier-wide directives are in
[`adapters/AGENTS.md`](../../AGENTS.md); repository setup, the shared Python toolchain and
the contribution process are in the top-level [`CONTRIBUTING.md`](../../../CONTRIBUTING.md).

## What this is

`adapters/core/python` is the `audr` distribution: the reference Python implementation of
the Agent Usage Detail Record (AUDR) standard. It is **destination-neutral**. A sink (a
file, a queue, a metering backend) is a plugin to this package, never the other way
around. A change that makes this package aware of a particular destination, or of a
particular adapter/runtime, is a change in the wrong direction.

## Layout

| Path | Owns |
| --- | --- |
| `src/audr/record/` | The AUDR v1.0.0 Pydantic models, encoding, and validation |
| `src/audr/sinks/` | The sink **contract** (`Sink`, `BatchResult`, `BatchOutcome`) plus the one bundled implementation, `FileSink` |
| `src/audr/client.py`, `src/audr/_pipeline.py` | The bounded, batching async delivery pipeline behind `Client` |
| `src/audr/testing.py` | `MemorySink`, `make_record`, and `assert_sink_contract` — a harness for testing sinks, not part of the delivery pipeline itself |
| `tests/` | The pytest suite for this distribution |
| `examples/` | Runnable examples, no credentials or network calls required |
| `scripts/gen_models.py` | Generates `src/audr/record/_schema.py` from the spec |
| `scripts/verify_distribution.py` | The isolation check `make isolation` runs against the built wheel |
| `../../../spec/` | The normative schema and prose — not packaged into the wheel |
| `../../../conformance/` | Shared fixtures this suite runs against |

## Working rules

1. The core never imports a sink implementation beyond `FileSink`, and never imports an
   adapter. `tests/test_public_api.py` pins `audr.__all__`, `audr.sinks.__all__`, and
   `audr.testing.__all__`; every addition is a SemVer promise and must be made
   deliberately. `make isolation` proves the built wheel installs and runs with no
   destination-specific dependency (e.g. `httpx`) present.
2. `record()` is the only submission path onto the delivery pipeline: it is synchronous,
   non-blocking, and returns a `RecordResult` rather than awaiting delivery. Anything
   that would let a caller await a single record's delivery is a design change to be
   agreed in an issue first.
3. `src/audr/record/_schema.py` is **generated**. Never hand-edit it — edit
   `scripts/gen_models.py` (and, if the schema itself is wrong, `spec/`) and run
   `make models`. `make models-check` fails CI if the generated file drifts from the
   spec.
4. No representation, log message, or exception may include an AUDR record's field
   *values* — names and JSON-pointer paths only. `ValidationIssue` carries a code and a
   path, never a value, for this reason.
5. Keep the public surface small. Prefer keyword-only constructors and explicit types.

## Toolchain

The shared toolchain — `uv`, Ruff, mypy `strict` with the Pydantic plugin, pytest with
`asyncio_mode = "auto"`, coverage gated at 90% — is defined in the top-level
[`CONTRIBUTING.md`](../../../CONTRIBUTING.md#shared-python-toolchain). Specific to this
package:

- **Runtime deps:** `pydantic`, `uuid6` — nothing destination-specific (no `httpx`, no
  adapter runtime).
- **Version:** `src/audr/_version.py`; `py.typed` ships in the wheel.

Targets beyond the shared `install / lint / test / build`:

```bash
make models          # regenerate src/audr/record/_schema.py from spec/
make models-check    # fail if the generated models drift from spec/
make conformance     # the shared fixtures only (tests/test_conformance.py)
make isolation       # build, then verify the wheel installs/runs with no adapter deps
make verify          # lint + models-check + test + isolation
```

## Conventions

- The public API is what `audr.__all__`, `audr.sinks.__all__`, and `audr.testing.__all__`
  export; `tests/test_public_api.py` pins those lists.
- Every event admitted through `record()` ends in exactly one terminal state: `sent`,
  `dropped`, or `unknown` (see `DeliveryStats` and `FailureReason`). `unknown` is terminal
  and never relabelled.
- `Sink` is a structural `Protocol` (`deliver()`, `close()`); a third-party sink does not
  need to import or subclass anything from this package. `audr.testing.assert_sink_contract`
  is the harness every sink, including `FileSink`, is checked against; it is a test helper,
  not stable delivery-pipeline API.
- `shutdown()` closes the sink, including one the caller supplied. `owns_sink=False` is
  the opt-out for a sink that outlives the client.
- Type-annotate public functions and class attributes. Imports at the top of the module.
- Reading is more tolerant than writing; see the spec's versioning rules before loosening
  a validation rule.

## What not to do

- Do not implement a destination-specific sink (Chargebee, a message queue, etc.) in this
  package; it belongs in its own distribution under `sinks/`.
- Do not add behaviour that depends on a specific destination's error format.
- Do not package the AUDR JSON Schema into the wheel.
- Do not add `httpx`, `aiofiles`, or any other adapter-shaped dependency to this
  package's runtime dependencies.
