/**
 * Line AUDR records up with Merge Gateway tracing. `merge-gateway-sdk` 0.4 sends headers per
 * client, not per call, so each agent run gets its own client carrying `X-Merge-Trace-Id`,
 * and the same id becomes `run.run_id` through `withAudr`. `fetch` is answered locally: no
 * network, no credentials.
 *
 *   node examples/tracing.ts
 */
import { instrumentMergeGateway, withAudr } from '@openaudr/audr-adapter-merge-gateway';
import { Client, uuidv7 } from '@openaudr/audr';
import { MemorySink } from '@openaudr/audr/testing';
import { MergeGateway } from 'merge-gateway-sdk';

// Stand-in for the Gateway API: answers every POST /v1/responses and keeps the trace id sent.
const traceHeaders: string[] = [];
let served = 0;
globalThis.fetch = (_input, init) => {
  served += 1;
  traceHeaders.push(new Headers(init?.headers).get('x-merge-trace-id') ?? 'none');
  return Promise.resolve(
    Response.json({
      id: `resp_example_${String(served)}`,
      object: 'response',
      model: 'openai/gpt-5.4',
      vendor: 'openai',
      output: [],
      usage: { input_tokens: 812, output_tokens: 180, total_tokens: 992, cost: 0.002365 },
    }),
  );
};

const sink = new MemorySink();
const client = new Client(sink);

/** One agent run: a fresh id, a client that sends it to Merge, and a scope that records it. */
async function handleTicket(accountId: string, ticket: string): Promise<string> {
  // Merge accepts A-Z a-z 0-9 . _ : - up to 128 characters; AUDR needs 8 to 64.
  const runId = `run-${uuidv7()}`;
  const gateway = instrumentMergeGateway(
    new MergeGateway({
      apiKey: 'mg_example',
      timeout: 300_000,
      defaultHeaders: { 'X-Merge-Trace-Id': runId, 'X-Merge-Thread-Id': ticket },
    }),
    { client, attributionDefaults: { environment: 'production' } },
  );
  await withAudr(
    { attribution: { account_id: accountId }, run: { run_id: runId, name: 'support-agent' } },
    async () => {
      await gateway.responses.create({ model: 'openai/gpt-5.4', input: 'Draft a reply.' });
      await gateway.responses.create({ model: 'openai/gpt-5.4', input: 'Critique the draft.' });
    },
  );
  return runId;
}

const runId = await handleTicket('acct_42', 'ticket-42');

// After the application has stopped starting Gateway calls and awaited the ones in flight.
await client.shutdown();

const runIds = sink.records.map((record) => record.run.run_id);
console.log(`trace ids sent to Merge: ${traceHeaders.join(', ')}`);
console.log(`run ids recorded: ${runIds.join(', ')}`);
console.log(`joined: ${String([...traceHeaders, ...runIds].every((id) => id === runId))}`);
