/**
 * Stream a response through an instrumented MergeGateway. The record is submitted when
 * the `response.done` frame arrives, before the loop sees it. `fetch` is answered
 * locally: no network, no credentials.
 *
 *   node examples/streaming.ts
 */
import { instrumentMergeGateway } from '@openaudr/audr-adapter-merge-gateway';
import { Client } from '@openaudr/audr';
import { MemorySink } from '@openaudr/audr/testing';
import { MergeGateway } from 'merge-gateway-sdk';

// Stand-in for the Gateway API: a native stream of one snapshot and the terminal frame.
globalThis.fetch = () => {
  const response = {
    id: 'resp_example_stream',
    model: 'anthropic/claude-sonnet-5',
    vendor: 'anthropic',
    output: [],
  };
  const frames = [
    { ...response, object: 'response.stream' },
    {
      ...response,
      object: 'response.done',
      usage: {
        input_tokens: 5620,
        output_tokens: 180,
        total_tokens: 5800,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 5533,
        cost: 0.0041,
      },
    },
  ];
  const sse = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('');
  return Promise.resolve(new Response(sse, { headers: { 'content-type': 'text/event-stream' } }));
};

const sink = new MemorySink();
const client = new Client(sink);
const gateway = instrumentMergeGateway(new MergeGateway({ apiKey: 'mg_example' }), {
  client,
  attributionDefaults: { environment: 'test', account_id: 'acct_42' },
});

const stream = await gateway.responses.create({
  model: 'anthropic/claude-sonnet-5',
  input: 'Write a short answer.',
  stream: true,
});
const kinds: unknown[] = [];
for await (const frame of stream) {
  kinds.push(frame.object);
}

await client.shutdown();

const [record] = sink.records;
console.log(`frames read: ${kinds.join(', ')}`);
console.log(`usage: ${JSON.stringify(record?.usage)}`);
console.log(`cost: ${JSON.stringify(record?.cost)}`);
