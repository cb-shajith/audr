import { validate } from '@openaudr/audr';
import { describe, expect, it } from 'vitest';

import { embedding, harness } from './helpers.js';

const PARAMS = { model: 'openai/text-embedding-3-small', input: ['first', 'second'] };

describe('embedding record', () => {
  it('records one valid embedding record per call', async () => {
    const h = harness();
    const body = embedding();
    h.fake.json(body);
    expect(await h.gateway.embeddings.create(PARAMS)).toEqual(body);
    const [record, ...rest] = await h.records();
    expect(rest).toEqual([]);
    expect(validate(record)).toEqual([]);
    expect(record).toMatchObject({
      resource: {
        provider: 'merge-gateway',
        type: 'model',
        name: 'openai/text-embedding-3-small',
        operation: 'embedding',
        modality: 'text',
      },
      usage: { llm: { input_tokens: 8, requests: 1 } },
      cost: { total_cost: 0.00000016, currency: 'USD' },
      run: { run_type: 'single_call' },
    });
    expect(record!.run.span_id).toBe(`embedding:${record!.run.run_id}`);
  });

  it('gives every embedding its own run and span', async () => {
    const h = harness();
    h.fake.json(embedding()).json(embedding());
    await h.gateway.embeddings.create(PARAMS);
    await h.gateway.embeddings.create(PARAMS);
    const [a, b] = await h.records();
    expect(a!.run.run_id).not.toBe(b!.run.run_id);
  });

  it('records the request alone when usage is unreported', async () => {
    const h = harness();
    h.fake.json(embedding({ usage: undefined }));
    await h.gateway.embeddings.create(PARAMS);
    const [record] = await h.records();
    expect(record!.usage.llm).toEqual({ requests: 1 });
    expect(record!.cost).toBeUndefined();
  });
});
