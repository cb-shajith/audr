/**
 * Meter an embeddings call, attributing it per request, and route every model to its
 * vendor with `mapResource`. `fetch` is answered locally: no network, no credentials.
 *
 *   node examples/embeddings.ts
 */
import { instrumentMergeGateway, withAudr } from '@openaudr/audr-adapter-merge-gateway';
import { Client } from '@openaudr/audr';
import { MemorySink } from '@openaudr/audr/testing';
import { MergeGateway } from 'merge-gateway-sdk';

// Stand-in for the Gateway API's POST /v1/embeddings.
globalThis.fetch = () =>
  Promise.resolve(
    Response.json({
      object: 'list',
      data: [
        { object: 'embedding', index: 0, embedding: [0.1, 0.2] },
        { object: 'embedding', index: 1, embedding: [0.3, 0.4] },
      ],
      model: 'openai/text-embedding-3-small',
      vendor: 'openai',
      usage: { prompt_tokens: 8, total_tokens: 8, cost: 0.00000016 },
    }),
  );

const sink = new MemorySink();
const client = new Client(sink);
const gateway = instrumentMergeGateway(new MergeGateway({ apiKey: 'mg_example' }), {
  client,
  attributionDefaults: { environment: 'test' },
  mapResource: ({ model }) => {
    const [provider, ...name] = model?.split('/') ?? [];
    return provider && name.length > 0 ? { provider, name: name.join('/') } : null;
  },
});

await withAudr({ attribution: { account_id: 'acct_42', user_id: 'u_8f14e45f' } }, () =>
  gateway.embeddings.create({
    model: 'openai/text-embedding-3-small',
    input: ['first document', 'second document'],
  }),
);

await client.shutdown();

const [record] = sink.records;
console.log(`resource: ${JSON.stringify(record?.resource)}`);
console.log(`usage: ${JSON.stringify(record?.usage)}`);
