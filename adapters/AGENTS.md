# AGENTS.md — adapters

Directives for work anywhere under `adapters/`. A package's own `AGENTS.md` takes precedence
inside that package. Repository-wide directives are in the root [`AGENTS.md`](../AGENTS.md);
contribution process is in [`CONTRIBUTING.md`](CONTRIBUTING.md) and the top-level
[`CONTRIBUTING.md`](../CONTRIBUTING.md).

## Invariants

1. An adapter never talks to a destination. It hands records to `client.record()` and
   nothing else.
2. An adapter never creates a `Client` or a sink. The host application owns both.
3. An adapter reads no prompts, completions, tool arguments or tool results, and no record
   field value reaches a log or an exception.
4. `record_id` is minted by the SDK. Runtime identifiers go on `run.run_id` and
   `run.span_id`.
5. The runtime is an optional extra, imported at activation, never at package import.
6. `make verify` passes in the package before the change is done.

## Creating a new adapter

Follow this brief when asked to add an adapter for a runtime. Confirm an accepted issue
exists first; if none does, stop and say so.

1. **Read** [`CONTRIBUTING.md`](CONTRIBUTING.md) in full, then
   [`core/README.md`](core/README.md) for how records flow, then the NeMo Relay adapter
   (`nemo-relay/python/`) as the reference implementation.
2. **Create** `adapters/<target>/python/` by copying the shape of `nemo-relay/python/`:
   `pyproject.toml` (name `audr-adapter-<target>`, `requires-python = ">=3.11"`, the
   runtime as an extra, shared Ruff/mypy/pytest configuration, `fail_under = 90`),
   `Makefile`, `src/audr_adapter_<target>/{__init__.py,_version.py,py.typed}`, `tests/`,
   `README.md`, `AGENTS.md`, `CHANGELOG.md`, `LICENSE`, `NOTICE`.
3. **Implement** in this order, with tests alongside each: the runtime hook and lifecycle;
   attribution resolution with configurable defaults; event-to-record mapping; the
   cross-thread handoff and `drain()` if the runtime uses worker threads.
4. **Wire the repository:** `.github/workflows/adapter-<target>-python-verify.yml`
   modelled on `adapter-nemo-relay-python-verify.yml`, a root `Makefile` target
   `adapter-<target>-python` added to `python`, a `CODEOWNERS` line, a row in
   [`README.md`](README.md), and `adapters/<target>/README.md` indexing the language.
5. **Write the README** for PyPI: install, activate and shut down, attribution, record
   shape, operational bounds. Absolute URLs. No version number. Execute every code block.
6. **Verify:** `make verify` in the package, then `make all` at the root.
