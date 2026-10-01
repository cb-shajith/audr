/**
 * A sentinel placed in every payload the SDK hands the integration must reach no
 * record and no log line.
 */
import {
  embed,
  embedMany,
  generateText,
  isStepCount,
  rerank,
  simulateReadableStream,
  streamText,
  tool,
} from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { embeddingModel, harness, PROVIDER_USAGE, rerankingModel } from './helpers.js';

const SENTINEL = 'SENTINEL-7f3a9c';

function leakyModel(): MockLanguageModelV4 {
  let calls = 0;
  return new MockLanguageModelV4({
    provider: 'openai.chat',
    modelId: 'gpt-5.4',
    doGenerate: () => {
      calls += 1;
      return Promise.resolve({
        content:
          calls === 1
            ? [
                { type: 'reasoning', text: SENTINEL },
                {
                  type: 'tool-call',
                  toolCallId: 'tc-ok',
                  toolName: 'echo',
                  input: JSON.stringify({ q: SENTINEL }),
                },
                {
                  type: 'tool-call',
                  toolCallId: 'tc-fail',
                  toolName: 'explode',
                  input: JSON.stringify({ q: SENTINEL }),
                },
              ]
            : [{ type: 'text', text: SENTINEL }],
        finishReason:
          calls === 1
            ? { unified: 'tool-calls', raw: SENTINEL }
            : { unified: 'stop', raw: SENTINEL },
        usage: { ...PROVIDER_USAGE, raw: { note: SENTINEL } },
        providerMetadata: { openai: { note: SENTINEL } },
        warnings: [],
        response: { id: SENTINEL, headers: { 'x-note': SENTINEL } },
        request: { body: SENTINEL },
      });
    },
    doStream: () =>
      Promise.resolve({
        stream: simulateReadableStream({
          chunks: [
            { type: 'response-metadata' as const, id: SENTINEL },
            { type: 'reasoning-start' as const, id: 'r' },
            { type: 'reasoning-delta' as const, id: 'r', delta: SENTINEL },
            { type: 'reasoning-end' as const, id: 'r' },
            { type: 'text-start' as const, id: 't' },
            { type: 'text-delta' as const, id: 't', delta: SENTINEL },
            { type: 'text-end' as const, id: 't' },
            {
              type: 'finish' as const,
              finishReason: { unified: 'stop' as const, raw: SENTINEL },
              usage: PROVIDER_USAGE,
              providerMetadata: { openai: { note: SENTINEL } },
            },
          ],
        }),
      }),
  });
}

describe('no payloads, no values in diagnostics', () => {
  it('sentinel in every payload position reaches no record and no log line', async () => {
    const h = harness({ attributionDefaults: { environment: 'test' } });
    const telemetry = {
      integrations: [h.telemetry],
      includeRuntimeContext: { audr: true },
      functionId: 'privacy-test',
    };
    const runtimeContext = { audr: { environment: 'test' }, secret: SENTINEL };
    await generateText({
      model: leakyModel(),
      system: SENTINEL,
      prompt: SENTINEL,
      tools: {
        echo: tool({
          inputSchema: z.object({ q: z.string() }),
          execute: ({ q }) => Promise.resolve({ echoed: q }),
        }),
        explode: tool({
          inputSchema: z.object({ q: z.string() }),
          execute: ({ q }): Promise<{ echoed: string }> => Promise.reject(new Error(q)),
        }),
      },
      stopWhen: isStepCount(3),
      runtimeContext,
      telemetry,
    });
    await streamText({
      model: leakyModel(),
      prompt: SENTINEL,
      runtimeContext,
      telemetry,
    }).consumeStream();
    await embed({ model: embeddingModel(), value: SENTINEL, runtimeContext, telemetry });
    await embedMany({
      model: embeddingModel(),
      values: [SENTINEL, SENTINEL],
      runtimeContext,
      telemetry,
    });
    await rerank({
      model: rerankingModel(),
      documents: [SENTINEL],
      query: SENTINEL,
      runtimeContext,
      telemetry,
    });

    const records = await h.records();
    // generateText: two generations and two tools; streamText, embed, embedMany, rerank: one each.
    expect(records).toHaveLength(8);
    expect(records.filter((r) => r.run.error_code !== undefined)).toHaveLength(1);
    expect(JSON.stringify(records)).not.toContain(SENTINEL);
    for (const line of [...h.logger.lines, ...h.clientLogger.lines]) {
      expect(line).not.toContain(SENTINEL);
    }
  });
});
