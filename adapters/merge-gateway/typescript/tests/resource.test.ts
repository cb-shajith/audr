import { describe, expect, it, vi } from 'vitest';

import { embedding, harness, response } from './helpers.js';

const PARAMS = { model: 'openai/gpt-5.4', input: 'hi' };

describe('resource provider and name', () => {
  it('passes the served model and vendor to mapResource', async () => {
    const mapResource = vi.fn(({ model }: { model: string | undefined }) => {
      const slash = model?.indexOf('/') ?? -1;
      return slash > 0 ? { provider: model!.slice(0, slash), name: model!.slice(slash + 1) } : null;
    });
    const h = harness({ mapResource });
    h.fake.json(response({ vendor: 'bedrock' })).json(embedding());
    await h.gateway.responses.create(PARAMS);
    await h.gateway.embeddings.create({ model: 'openai/text-embedding-3-small', input: 'a' });
    expect(mapResource.mock.calls).toEqual([
      [{ model: 'openai/gpt-5.4', vendor: 'bedrock' }],
      [{ model: 'openai/text-embedding-3-small', vendor: 'openai' }],
    ]);
    const [generation, embed] = await h.records();
    expect(generation!.resource).toMatchObject({ provider: 'openai', name: 'gpt-5.4' });
    expect(embed!.resource).toMatchObject({ provider: 'openai', name: 'text-embedding-3-small' });
  });

  it('keeps the default when mapResource returns nothing', async () => {
    const h = harness({ mapResource: () => undefined });
    h.fake.json(response());
    await h.gateway.responses.create(PARAMS);
    const [record] = await h.records();
    expect(record!.resource).toMatchObject({ provider: 'merge-gateway', name: 'openai/gpt-5.4' });
  });

  it('skips the record when mapResource throws', async () => {
    const h = harness({
      mapResource: () => {
        throw new SyntaxError('host bug');
      },
    });
    h.fake.json(response());
    await h.gateway.responses.create(PARAMS);
    expect(await h.records()).toEqual([]);
    expect(h.logger.errors).toEqual([
      '@openaudr/adapter-merge-gateway: HOOK_FAILED (operation=responses.create, error=SyntaxError)',
    ]);
  });

  it('leaves a mapped provider that is not a slug to the Client to reject', async () => {
    const h = harness({ mapResource: () => ({ provider: 'Open AI', name: 'gpt' }) });
    h.fake.json(response());
    await h.gateway.responses.create(PARAMS);
    expect(await h.records()).toEqual([]);
    expect(h.logger.warnings).toHaveLength(1);
    expect(h.logger.warnings[0]).toMatch(/RECORD_NOT_QUEUED .*issues=\w+@\/resource\/provider\)$/);
  });

  it('skips a response that names no model', async () => {
    const h = harness();
    h.fake.json(response({ model: '' })).json(embedding({ model: undefined }));
    await h.gateway.responses.create(PARAMS);
    await h.gateway.embeddings.create({ model: 'openai/text-embedding-3-small', input: 'a' });
    expect(await h.records()).toEqual([]);
    expect(h.logger.warnings).toEqual([
      '@openaudr/adapter-merge-gateway: MODEL_UNREPORTED (operation=responses.create)',
      '@openaudr/adapter-merge-gateway: MODEL_UNREPORTED (operation=embeddings.create)',
    ]);
  });

  it('lets mapResource name a model Gateway did not report', async () => {
    const h = harness({ mapResource: () => ({ provider: 'openai', name: 'gpt-5.4' }) });
    h.fake.json(response({ model: undefined }));
    await h.gateway.responses.create(PARAMS);
    const [record] = await h.records();
    expect(record!.resource).toMatchObject({ provider: 'openai', name: 'gpt-5.4' });
  });
});
