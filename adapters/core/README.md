# Core SDK

The vendor-neutral core every adapter and sink depends on: it models and validates
[AUDR](../../spec/SPEC.md) records and delivers them through a sink contract. It also
serves as the null adapter: an application that emits records directly uses this package
alone.

| Language | Status | Distribution |
| --- | --- | --- |
| [Python](python/) | Pre-release `0.1.0a1` | `audr` |

Every implementation of the core follows the same three rules, which are what make them
interchangeable:

1. **The core is destination-neutral.** It models and validates records and delivers them
   through a sink contract. Sinks and adapters are separate packages, so an implementation
   of the standard depends only on what it uses.
2. **The schema has a single source.** [`spec/audr.schema.json`](../../spec/audr.schema.json)
   is the one copy. A core validates with native types and tests those against it.
3. **Conformance is shared.** Every core runs [`conformance/`](../../conformance/README.md) —
   the same fixtures with the same expected outcomes. That is the definition of done.
