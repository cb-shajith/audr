# AUDR conformance fixtures

Shared, language-neutral test data for anything that emits, validates, or ingests
AUDR records. If you are writing an implementation — an SDK, a validator, a sink —
these fixtures are the contract: agree with them and it is conformant.

## Layout

```
cases.json            manifest: every fixture, its expected outcome, and the
                      specification rule it exercises
fixtures/valid/       records a conformant validator MUST accept
fixtures/invalid/     records a conformant validator MUST reject
runner/python/run.py  reference runner
```

Every fixture is plain JSON, and so is `cases.json`. A runner in any language
reads the manifest, validates each file against `spec/audr.schema.json`, and
compares the outcome to `expect`.

## Running the suite

```bash
pip install -r requirements.txt
python3 conformance/runner/python/run.py      # -v to list every case
```

The runner prints a one-line summary of the cases it ran, and exits non-zero
naming every case whose outcome disagreed with the manifest.

## What the fixtures cover

| Rule | Covers |
| --- | --- |
| 3.1 | Closed objects; unspecified properties rejected |
| 3.4–3.5 | Required properties, `spec_version` family, `record_id` bounds, corrections |
| 3.6–3.10 | Per-object field constraints and closed sub-objects |
| 3.11 | Usage counters, absent-vs-zero, `x_*` extension naming |
| 3.12 | Cost components, currency format, required pairs |
| 3.13 | Cross-field operation constraints |

Two fixtures look odd until you know why they exist. Both guard against a
mistake caught during v1.0.0's drafting, and both must keep failing:

- `invalid/allof-as-field.json` — if `allOf` is ever nested inside `properties`
  again, every cross-field constraint silently stops applying and `allOf`
  becomes an accepted record field. This fixture is the alarm.
- `invalid/unknown-operation.json` — pins the `resource.operation` enum, so a
  value that is not a member cannot quietly reappear in an example.

## Format assertion

JSON Schema treats `format` as an annotation unless the validator is configured
to assert it. AUDR's `timing.event_time` and `timing.received_time` therefore
carry an RFC 3339 `pattern` alongside `format: date-time`, so the constraint
holds on every validator regardless of configuration. The reference runner also
enables format assertion explicitly.

## Requirements enforced outside the schema

Several AUDR requirements cannot be expressed in JSON Schema at all. They are
enforced by the sink, and are listed in section 3.3 of the specification. A
record can pass every fixture here and still be non-conformant at ingest — most
importantly, a record missing `attribution.environment` is schema-valid but
MUST be ignored and MUST NOT be rated.

## Adding a case

1. Add the JSON file under `fixtures/valid/` or `fixtures/invalid/`.
2. Append an entry to `cases.json` with `file`, `expect`, `rule`, and a `note`
   saying what the case proves.
3. Run the suite.

An invalid fixture should fail for exactly one reason. If it trips several
constraints at once it stops being a useful regression test.
