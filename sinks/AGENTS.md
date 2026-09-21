# AGENTS.md — sinks

Directives for work anywhere under `sinks/`. A package's own `AGENTS.md` takes precedence
inside that package. Repository-wide directives are in the root [`AGENTS.md`](../AGENTS.md);
contribution process is in [`CONTRIBUTING.md`](CONTRIBUTING.md) and the top-level
[`CONTRIBUTING.md`](../CONTRIBUTING.md).

## Invariants

1. `deliver()` and `close()` report outcomes and never raise for a delivery failure.
2. The pipeline never retries. Retries live inside `deliver()`, bounded by a configured
   policy.
3. A record the destination did not confirm is `unknown`, never assumed sent.
4. The whole record is forwarded. Nothing is added, nothing is dropped.
5. Credentials never reach a log, an error or `repr()`. Record field values never reach a
   log or an error.
6. `audr.testing.assert_sink_contract()` runs in the test suite and passes.
7. `make verify` passes in the package before the change is done.

## Creating a new sink

Follow this brief when asked to add a sink for a destination. Confirm an accepted issue
exists first; if none does, stop and say so.

1. **Read** [`CONTRIBUTING.md`](CONTRIBUTING.md) in full, then the contract in
   [`adapters/core/README.md`](../adapters/core/README.md#the-sink-contract), then the
   Chargebee sink (`chargebee/python/`) as the reference implementation.
2. **Create** `sinks/<target>/python/` by copying the shape of `chargebee/python/`:
   `pyproject.toml` (name `audr-sink-<target>`, `requires-python = ">=3.11"`, `httpx` if
   the destination is HTTP, shared Ruff/mypy/pytest configuration, `fail_under = 90`),
   `Makefile`, `scripts/verify_distribution.py`,
   `src/audr_sink_<target>/{__init__.py,_version.py,py.typed}`, `tests/`, `README.md`,
   `AGENTS.md`, `CHANGELOG.md`, `LICENSE`, `NOTICE`.
3. **Implement** as separate modules, with tests alongside each: credentials; the
   record-to-event encoding, including the routing and de-duplication keys; the transport
   with timeout and retry policy; the response-to-`BatchResult` mapping; the `Sink` class
   composing them. Add the `assert_sink_contract` test and a no-live-network test.
4. **Wire the repository:** `.github/workflows/sink-<target>-python-verify.yml` modelled
   on `sink-chargebee-python-verify.yml`, a root `Makefile` target `sink-<target>-python`
   added to `python`, a `CODEOWNERS` line, a row in [`README.md`](README.md), and
   `sinks/<target>/README.md` indexing the language.
5. **Write the README** for PyPI: install, configure, routing and delivery semantics, the
   data-handling restatement with a link to `SECURITY.md`. Absolute URLs. No version
   number. Execute every code block.
6. **Verify:** `make verify` in the package, then `make all` at the root.
