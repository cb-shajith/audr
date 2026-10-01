/**
 * A sentinel placed in every payload position of a request and a response must
 * reach no record and no log line.
 */
import { describe, expect, it } from 'vitest';

import { withAudr } from '../src/index.js';
import { drain, embedding, harness, response } from './helpers.js';

const SENTINEL = 'SENTINEL-7f3a9c';

function leakyResponse(): Record<string, unknown> {
  return response({
    output: [
      {
        type: 'message',
        id: SENTINEL,
        role: 'assistant',
        finish_reason: 'tool_use',
        content: [
          { type: 'thinking', thinking: SENTINEL, signature: SENTINEL },
          { type: 'text', text: SENTINEL, annotations: [SENTINEL] },
          { type: 'tool_use', id: SENTINEL, name: SENTINEL, input: { q: SENTINEL } },
        ],
      },
    ],
    provider_request_id: SENTINEL,
    service_tier: SENTINEL,
    routing: { policy_name: SENTINEL, routing_reason: SENTINEL, cost_usd: 0.1 },
    guardrails: { note: SENTINEL },
    warnings: [{ code: SENTINEL, message: SENTINEL }],
  });
}

describe('no payloads, no values in diagnostics', () => {
  it('sentinel in every payload position reaches no record and no log line', async () => {
    const h = harness();
    const params = {
      model: 'openai/gpt-5.4',
      input: [{ type: 'message', role: 'user', content: SENTINEL }],
      tools: [{ type: 'function', name: SENTINEL, description: SENTINEL }],
      tags: [{ key: SENTINEL, value: SENTINEL }],
      customer: SENTINEL,
      project_id: SENTINEL,
      session_id: SENTINEL,
      modalities: [SENTINEL],
    };
    const leaky = leakyResponse();
    h.fake
      .json(leaky)
      .sse([
        { ...leaky, object: 'response.stream', usage: undefined },
        { fallback_restart: true, model: SENTINEL, vendor: SENTINEL },
        { ...leaky, object: 'response.done' },
      ])
      .sse([
        {
          object: 'response.error',
          error: { type: SENTINEL, message: SENTINEL, status_code: '500', source: SENTINEL },
        },
      ])
      .json(embedding({ data: [{ object: 'embedding', index: 0, embedding: SENTINEL }] }))
      .json({ error: { type: SENTINEL, message: SENTINEL } }, 400);

    await withAudr({ attribution: { labels: { feature: 'chat' } } }, async () => {
      await h.gateway.responses.create(params);
      await drain(await h.gateway.responses.create({ ...params, stream: true }));
      await drain(await h.gateway.responses.create({ ...params, stream: true }));
      await h.gateway.embeddings.create({
        model: 'openai/text-embedding-3-small',
        input: [SENTINEL],
        user: SENTINEL,
        customer: SENTINEL,
      });
      await expect(h.gateway.responses.create(params)).rejects.toThrow(SENTINEL);
    });

    const records = await h.records();
    expect(records).toHaveLength(3);
    expect(JSON.stringify(records)).not.toContain(SENTINEL);
    expect(h.logger.lines).toHaveLength(1);
    for (const line of [...h.logger.lines, ...h.clientLogger.lines]) {
      expect(line).not.toContain(SENTINEL);
    }
  });
});
