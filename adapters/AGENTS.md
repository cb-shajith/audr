# AGENTS.md — adapters

Guidance for work under `adapters/`. A package's own `AGENTS.md` takes precedence inside
that package; repository-wide rules are in the root [`AGENTS.md`](../AGENTS.md).
[`CONTRIBUTING.md`](CONTRIBUTING.md) explains what an adapter is and what a new one ships.
This file summarises the rules to observe and the steps to follow.

## Rules

1. Hand records to `client.record()` only. An adapter never communicates with a
   destination.
2. Do not create a `Client` or a sink. The host application owns both.
3. Do not read prompts, completions, tool arguments or tool results. If a record cannot be
   attributed, skip it with a value-free warning rather than billing it to a guess.
4. The SDK mints `record_id`. Place the runtime's own identifiers on `run.run_id` and
   `run.span_id`.
5. Make the runtime an optional extra and import it at activation, never at package import.

## Creating a new adapter

Follow these steps when adding an adapter for a runtime. Confirm first that an accepted
issue agrees the runtime hook and the record shape; if none exists, stop and report it.

1. **Read** [`CONTRIBUTING.md`](CONTRIBUTING.md) in full, then
   [`core/README.md`](core/README.md) for how records flow, then the NeMo Relay adapter
   (`nemo-relay/python/`) as the reference implementation.
2. **Create** `adapters/<target>/python/` by copying the shape of `nemo-relay/python/`.
   `CONTRIBUTING.md` lists every file the package ships. In `pyproject.toml`: name
   `audr-adapter-<target>`, `requires-python = ">=3.11"`, the runtime as an extra, the
   shared Ruff/mypy/pytest configuration, `fail_under = 90`.
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
