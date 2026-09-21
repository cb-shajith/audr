---
id: introduction
number: "1"
title: Introduction
---

### 1.1 Scope

This specification defines the Agent Usage Detail Record (AUDR), a JSON object
that describes one metered operation in an agent system. A record identifies its
emitter and resource, reports raw model or tool usage, associates the operation
with a run, and carries attribution required for downstream cost allocation. A
record MAY include an informational cost assertion.

### 1.2 Architecture

A typical AUDR-enabled agent workflow has five logical components:

1. **Agent Harness**: Runs the agent and performs tasks by requesting model
   operations and invoking tools. It manages sessions, tool execution and
   supplies run hierarchy.
2. **Router / AI Gateway**: Selects a model and provider through a normalized
   provider interface, forwards each operation, and captures resource and usage
   data.
3. **Provider**: Executes the model operation or provider-hosted tool and returns
   the result with native usage and cost observations when available.
4. **Sink**: The ingest layer that receives emitted usage records, then
   validates, deduplicates, merges, and stores them.
5. **Rating**: The downstream calculation of a billable amount from raw usage and
   billing configuration.

The application invokes the agent harness. Each metered operation passes from the
agent harness through the router role to the provider; roles MAY be co-located,
participating components MAY emit independent AUDR records, and the sink
assembles records that share a `run.run_id` and `run.span_id`. Rating consumes
stored records and is out of scope for this specification.

### 1.3 Out of Scope

- Rated customer amounts, invoice generation, and revenue recognition.
- Sink operational policies such as orphan wait duration and merge timing.
- Agent internal state records and observability event formats.

### 1.4 Record Processing Model

Multiple components MAY describe the same metered operation or agentic run. A
sink assembles those observations using the pair `run.run_id` and `run.span_id`.
Each emitted record has an independent `record_id` for deduplication and
correction processing. Downstream rating components MAY use or ignore the
asserted `cost` object according to its own billing configuration.
