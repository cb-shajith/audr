---
id: definitions
number: "2"
title: Definitions
---

**Emitter**: The component that wrote the record, identified by
`emitter.component`.

**Harness**: The agent runtime or orchestration layer that runs the agent loop.
It builds prompts, calls the model, executes tools, returns the results, and
manages session state, context, and tool permissions.

**Merge key**: The pair `(run.run_id, run.span_id)`. It groups records from
different emitters that describe the same metered operation.

**Metered operation**: One model operation, tool execution, or retrieval
identified by a unique `run_id` and `span_id` pair.

**Provider**: The vendor or platform that serves the model or executes the
metered tool.

**Rating**: The downstream calculation of a billable amount from raw usage and
billing configuration.

**Record**: One emitted AUDR JSON object with its own `record_id`.

**Router / AI Gateway**: The layer that routes model requests to providers. This
provides a unified interface for agent harness to invoke multiple provider
models. The router tracks token consumption and optionally has a fallback
mechanism for optimizing model calls or during outages.

**SDK**: The client library role responsible for record construction fields such
as `spec_version` and `record_id`.

**Sink**: The ingest layer that validates, deduplicates, merges, and stores the
usage records. It is distinct from Rating in that Sink is responsible only for
validating and storing records, not for calculating a billable amount.

**Tools**: External capabilities invoked by an agent harness. Each request to one
of these capabilities is a tool invocation. Examples include web search, code
execution, file access, retrieval, database queries, and API calls.
