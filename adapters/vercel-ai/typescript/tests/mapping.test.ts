import type { LanguageModelUsage } from 'ai';
import { describe, expect, it } from 'vitest';

import {
  counter,
  durationMs,
  embedSpanId,
  isProviderSlug,
  modelSpanId,
  providerSlug,
  rerankSpanId,
  runTypeFor,
  toLlmUsage,
  toolSpanId,
} from '../src/mapping.js';

interface Counts {
  input?: number;
  noCache?: number;
  cacheRead?: number;
  cacheWrite?: number;
  output?: number;
  text?: number;
  reasoning?: number;
  total?: number;
}

function usage(counts: Counts): LanguageModelUsage {
  return {
    inputTokens: counts.input,
    inputTokenDetails: {
      noCacheTokens: counts.noCache,
      cacheReadTokens: counts.cacheRead,
      cacheWriteTokens: counts.cacheWrite,
    },
    outputTokens: counts.output,
    outputTokenDetails: { textTokens: counts.text, reasoningTokens: counts.reasoning },
    totalTokens: counts.total,
  };
}

describe('VAI-05 token arithmetic', () => {
  it('VAI-05 cached and reasoning tokens', () => {
    expect(
      toLlmUsage(
        usage({ input: 120, noCache: 100, cacheRead: 20, output: 50, text: 40, reasoning: 10 }),
      ),
    ).toEqual({
      input_tokens: 100,
      output_tokens: 40,
      cache_read_tokens: 20,
      reasoning_tokens: 10,
      requests: 1,
    });
  });

  it('VAI-05 no detail breakdown: subtract cache reads, writes and reasoning', () => {
    expect(
      toLlmUsage(usage({ input: 120, cacheRead: 20, cacheWrite: 5, output: 50, reasoning: 10 })),
    ).toEqual({
      input_tokens: 95,
      output_tokens: 40,
      cache_read_tokens: 20,
      cache_write_tokens: 5,
      reasoning_tokens: 10,
      requests: 1,
    });
  });

  it('VAI-05 unreported counters leave only requests', () => {
    expect(toLlmUsage(usage({}))).toEqual({ requests: 1 });
  });

  it('VAI-05 totals alone pass through', () => {
    expect(toLlmUsage(usage({ input: 12, output: 3, total: 15 }))).toEqual({
      input_tokens: 12,
      output_tokens: 3,
      requests: 1,
    });
  });

  it('VAI-05 subtraction never goes below zero', () => {
    expect(toLlmUsage(usage({ input: 5, cacheRead: 9, output: 2, reasoning: 4 }))).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 9,
      reasoning_tokens: 4,
      requests: 1,
    });
  });

  it.each([Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY])(
    'VAI-05 a counter of %s is treated as unreported',
    (bad) => {
      expect(
        toLlmUsage(
          usage({
            input: bad,
            noCache: bad,
            cacheRead: bad,
            cacheWrite: bad,
            output: bad,
            text: bad,
            reasoning: bad,
          }),
        ),
      ).toEqual({ requests: 1 });
      expect(toLlmUsage(usage({ input: 10, cacheRead: bad, output: 4, reasoning: bad }))).toEqual({
        input_tokens: 10,
        output_tokens: 4,
        requests: 1,
      });
    },
  );

  it('VAI-05 totalTokens and raw are never copied', () => {
    const result = toLlmUsage({ ...usage({ total: 99 }), raw: { total: 99 } });
    expect(Object.keys(result)).toEqual(['requests']);
  });

  it.each([
    [0, 0],
    [3, 3],
    [2.5, undefined],
    [-1, undefined],
    [Number.NaN, undefined],
    ['3', undefined],
    [undefined, undefined],
  ])('counter(%s) is %s', (value, expected) => {
    expect(counter(value)).toBe(expected);
  });

  it.each([
    [812.4, 812],
    [0, 0],
    [0.6, 1],
    [-0.1, undefined],
    [Number.NaN, undefined],
    [Number.POSITIVE_INFINITY, undefined],
    [undefined, undefined],
  ])('durationMs(%s) is %s', (value, expected) => {
    expect(durationMs(value)).toBe(expected);
  });
});

describe('VAI-15 provider slug', () => {
  it.each([
    ['openai.responses', 'openai'],
    ['openai.chat', 'openai'],
    ['anthropic.messages', 'anthropic'],
    ['azure.chat', 'azure-openai'],
    ['azure', 'azure-openai'],
    ['gateway', 'vercel-ai-gateway'],
    ['gateway.embedding', 'vercel-ai-gateway'],
    ['amazon-bedrock', 'aws-bedrock'],
    ['bedrock.anthropic.messages', 'aws-bedrock'],
    ['bedrock-mantle.responses', 'aws-bedrock'],
    ['google.vertex.chat', 'google-vertex'],
    ['googleVertex.anthropic.messages', 'google-vertex'],
    ['vertex.maas', 'google-vertex'],
    ['google.generative-ai', 'google'],
    ['mistral.chat', 'mistral'],
    ['xai.responses', 'xai'],
    ['cohere.reranking', 'cohere'],
    ['deepseek.chat', 'deepseek'],
    ['Together_AI.chat', 'together-ai'],
    ['__weird__', 'weird'],
    ['gatewayish.chat', 'gatewayish'],
    ['azure-foundry.chat', 'azure-foundry'],
  ])('VAI-15 %s → %s', (provider, slug) => {
    expect(providerSlug(provider)).toBe(slug);
  });

  it.each(['', '.chat', '...', '___'])('VAI-15 %j has no slug', (provider) => {
    expect(providerSlug(provider)).toBeUndefined();
  });

  it.each([
    ['openai', true],
    ['aws-bedrock', true],
    ['Open AI', false],
    ['open.ai', false],
    ['', false],
  ])('isProviderSlug(%j) is %s', (slug, valid) => {
    expect(isProviderSlug(slug)).toBe(valid);
  });
});

describe('VAI-09 identifiers', () => {
  it('VAI-09 span ids carry the operation kind and its own call id', () => {
    expect(modelSpanId('call-a', 2)).toBe('model:call-a:2');
    expect(toolSpanId('call-a', 'tc-1')).toBe('tool:call-a:tc-1');
    expect(embedSpanId('call-e')).toBe('embed:call-e');
    expect(rerankSpanId('call-a', 0)).toBe('rerank:call-a:0');
  });

  it.each([
    ['ai.generateText', 'agent_run'],
    ['ai.streamText', 'agent_run'],
    ['ai.embed', 'single_call'],
    ['ai.embedMany', 'single_call'],
    ['ai.rerank', 'single_call'],
    ['ai.generateObject', 'single_call'],
  ])('VAI-09 run type of %s is %s', (operationId, runType) => {
    expect(runTypeFor(operationId)).toBe(runType);
  });
});
