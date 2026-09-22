# Examples

End-to-end scenarios showing how AUDR records fit together across a whole run.

These are illustrative. The examples embedded in the specification are the
other, flat JSON files in this directory, and the machine-readable
test data lives in [`conformance/fixtures/`](../../conformance/README.md). Every
file here is validated against the schema in CI.

## `multi-emitter-run/`

One agent run resolving a support ticket, observed by two components that never
coordinate. Four records, one `run_id`.

| File | Emitter | Span | What it knows |
| --- | --- | --- | --- |
| `01-router-model-call.json` | router | `model-call-1` | Model, tokens, cache split, asserted cost |
| `02-harness-retrieval.json` | harness | `tool-call-2` | A retrieval it executed, linked to the call that asked for it |
| `03-router-model-call.json` | router | `model-call-3` | The follow-up call, linked to the tool result |
| `04-harness-outcome.json` | harness | `run-summary` | That the run resolved |

Read them in order. The things worth noticing:

**No component knows everything.** The router meters tokens and cost but has no
idea whether the run helped anyone. The harness knows the outcome, but only after
the last model call was already metered — which is why it cannot be the single
emitter without buffering the whole run.

**`run_id` is identical on all four; `span_id` is not.** The pair is the merge
key. `parent_span_id` reconstructs the shape: the retrieval was requested by the
first model call, and the second model call consumed its result.

**`attribution` is repeated on every record, not just the first.** Records arrive
independently and may arrive out of order or partially. A record that cannot be
attributed on its own cannot be rated on its own.

**`run.outcome` appears exactly once, on a harness record.** It is harness-owned
(specification section 3.3). No
other component competes to write it, so the sink never has to choose.

**`cost` is asserted, not rated.** The router reports what Anthropic charged it.
What the end customer pays is a rating decision this record does not make
(specification section 3.3).

Summing `cost.total_cost` across the run gives $0.0186, attributable to
`account-42`, subscription `subscription-9`, and the `ticket-triage` feature —
which is the question no individual layer could answer.

## Validating these

```bash
python3 - <<'PY'
import json, glob
from jsonschema import Draft202012Validator, FormatChecker
schema = json.load(open("spec/audr.schema.json"))
validator = Draft202012Validator(schema, format_checker=FormatChecker())
for path in sorted(glob.glob("spec/examples/multi-emitter-run/*.json", recursive=True)):
    errors = list(validator.iter_errors(json.load(open(path))))
    print(("ok   " if not errors else "FAIL "), path)
PY
```
