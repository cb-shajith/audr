/**
 * End to end: real AI SDK calls against the `ai/test` mock models, with the integration
 * receiving events exactly as an application's would.
 */
import {
  customProvider,
  embed,
  embedMany,
  generateText,
  isStepCount,
  registerTelemetry,
  rerank,
  streamText,
  tool,
  ToolLoopAgent,
} from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { TOOL_ERROR_CODE } from '../src/index.js';
import {
  embeddingModel,
  harness,
  LLM_USAGE,
  model,
  PROVIDER_USAGE,
  rerankingModel,
  withAudr,
} from './helpers.js';

const lookup = tool({
  inputSchema: z.object({ id: z.string() }),
  execute: () => Promise.resolve({ status: 'shipped' }),
});

const failing = tool({
  inputSchema: z.object({ id: z.string() }),
  execute: (): Promise<{ status: string }> => Promise.reject(new Error('lookup failed')),
});

afterEach(() => {
  globalThis.AI_SDK_TELEMETRY_INTEGRATIONS = undefined;
  globalThis.AI_SDK_DEFAULT_PROVIDER = undefined;
});

describe('VAI-01 entry point', () => {
  it('VAI-01 meters a call when registered globally', async () => {
    const h = harness();
    registerTelemetry(h.telemetry);
    await generateText({ model: model(), prompt: 'x' });
    expect(await h.records()).toHaveLength(1);
  });

  it('VAI-01 meters only the calls that carry a per-call integration', async () => {
    const h = harness();
    await generateText({ model: model(), prompt: 'x', telemetry: { integrations: [h.telemetry] } });
    await generateText({ model: model(), prompt: 'x' });
    expect(await h.records()).toHaveLength(1);
  });
});

describe('VAI-04 generation records', () => {
  it('VAI-04 two-step tool loop: two generations and one tool execution in one run', async () => {
    const h = harness();
    await generateText({
      model: model({ toolCalls: [{ id: 'tc-1', name: 'lookup', input: '{"id":"42"}' }] }),
      prompt: 'x',
      tools: { lookup },
      stopWhen: isStepCount(3),
      ...withAudr(h.telemetry),
    });
    const records = await h.records();
    expect(records.map((r) => r.resource.operation)).toEqual([
      'generation',
      'tool_execution',
      'generation',
    ]);
    const runId = records[0]!.run.run_id;
    expect(runId).toMatch(/^call-/);
    expect(records.every((r) => r.run.run_id === runId)).toBe(true);
    expect(records.map((r) => r.run.span_id)).toEqual([
      `model:${runId}:0`,
      `tool:${runId}:tc-1`,
      `model:${runId}:1`,
    ]);
    expect(records.map((r) => r.run.step)).toEqual([0, 1, 2]);
    expect(records[0]).toMatchObject({
      resource: {
        provider: 'openai',
        type: 'model',
        name: 'gpt-5.4',
        operation: 'generation',
        modality: 'text',
      },
      usage: { llm: LLM_USAGE },
      run: { run_type: 'agent_run' },
      attribution: { environment: 'test' },
    });
    expect(records[1]).toMatchObject({
      resource: { provider: 'self-hosted', type: 'tool', name: 'lookup' },
      usage: { tool: { type: 'invocation', call_count: 1 } },
    });
    expect(records[1]!.run.error_code).toBeUndefined();
    expect(h.client.stats.submitted).toBe(3);
  });

  it('VAI-04 streamed call: one generation record with the final usage', async () => {
    const h = harness();
    const result = streamText({ model: model(), prompt: 'x', ...withAudr(h.telemetry) });
    await result.consumeStream();
    const records = await h.records();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      resource: { operation: 'generation', name: 'gpt-5.4' },
      usage: { llm: LLM_USAGE },
      run: { run_type: 'agent_run' },
    });
  });

  it('VAI-04 provider-echoed model id becomes resource.name', async () => {
    const h = harness();
    await generateText({
      model: model({ modelId: 'gpt-5.4', echoedModelId: 'gpt-5.4-2026-01-01' }),
      prompt: 'x',
      ...withAudr(h.telemetry),
    });
    const [record] = await h.records();
    expect(record!.resource.name).toBe('gpt-5.4-2026-01-01');
  });

  it('VAI-04 ToolLoopAgent with prepareCall carries per-request attribution', async () => {
    const h = harness({ attributionDefaults: { environment: 'production' } });
    const agent = new ToolLoopAgent({
      model: model({ toolCalls: [{ id: 'tc-1', name: 'lookup', input: '{"id":"42"}' }] }),
      tools: { lookup },
      telemetry: {
        functionId: 'support-agent',
        integrations: [h.telemetry],
        includeRuntimeContext: { audr: true },
      },
      callOptionsSchema: z.object({ accountId: z.string() }),
      prepareCall: ({ options, ...settings }) => ({
        ...settings,
        runtimeContext: { audr: { account_id: options.accountId } },
      }),
    });
    await agent.generate({ prompt: 'x', options: { accountId: 'acct_42' } });
    const records = await h.records();
    expect(records).toHaveLength(3);
    for (const record of records) {
      expect(record.attribution).toEqual({ environment: 'production', account_id: 'acct_42' });
      expect(record.run.name).toBe('support-agent');
      expect(record.run.run_type).toBe('agent_run');
    }
  });
});

describe('VAI-06 tool execution records', () => {
  it('VAI-06 a throwing tool yields a tool_execution record with the error code', async () => {
    const h = harness();
    await generateText({
      model: model({ toolCalls: [{ id: 'tc-1', name: 'failing', input: '{"id":"42"}' }] }),
      prompt: 'x',
      tools: { failing },
      stopWhen: isStepCount(3),
      ...withAudr(h.telemetry),
    });
    const records = await h.records();
    const toolRecord = records.find((r) => r.resource.operation === 'tool_execution');
    expect(toolRecord).toMatchObject({
      resource: { name: 'failing', provider: 'self-hosted' },
      run: { error_code: TOOL_ERROR_CODE },
    });
    expect(JSON.stringify(records)).not.toContain('lookup failed');
    expect(h.logger.lines.join('\n')).not.toContain('lookup failed');
  });

  it('VAI-06 provider-executed tools produce no tool_execution record', async () => {
    const h = harness();
    const searching = new MockLanguageModelV4({
      provider: 'openai.responses',
      modelId: 'gpt-5.4',
      doGenerate: {
        content: [
          {
            type: 'tool-call',
            toolCallId: 'ws-1',
            toolName: 'web_search',
            input: '{}',
            providerExecuted: true,
          },
          { type: 'tool-result', toolCallId: 'ws-1', toolName: 'web_search', result: {} },
          { type: 'text', text: 'ok' },
        ],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: PROVIDER_USAGE,
        warnings: [],
      },
    });
    const result = await generateText({
      model: searching,
      prompt: 'x',
      tools: {
        web_search: tool({
          type: 'provider',
          id: 'openai.web_search',
          args: {},
          isProviderExecuted: true,
          inputSchema: z.object({}),
          outputSchema: z.object({}),
        }),
      },
      ...withAudr(h.telemetry),
    });
    expect(result.toolResults).toHaveLength(1);
    const records = await h.records();
    expect(records.map((r) => r.resource.operation)).toEqual(['generation']);
  });
});

describe('VAI-07 embedding and reranking records', () => {
  it('VAI-07 embed yields one embedding record with its input tokens', async () => {
    const h = harness();
    await embed({ model: embeddingModel(), value: 'x', ...withAudr(h.telemetry) });
    const records = await h.records();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      resource: {
        provider: 'openai',
        type: 'model',
        name: 'text-embedding-3-small',
        operation: 'embedding',
        modality: 'text',
      },
      usage: { llm: { input_tokens: 7, requests: 1 } },
      run: { run_type: 'single_call' },
    });
    expect(records[0]!.timing.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('VAI-07 chunked embedMany yields one record per provider call in one run', async () => {
    const h = harness();
    await embedMany({
      model: embeddingModel({ maxEmbeddingsPerCall: 2 }),
      values: ['a', 'b', 'c', 'd', 'e'],
      ...withAudr(h.telemetry),
    });
    const records = await h.records();
    expect(records).toHaveLength(3);
    expect(new Set(records.map((r) => r.run.run_id)).size).toBe(1);
    expect(new Set(records.map((r) => r.run.span_id)).size).toBe(3);
    expect(records.every((r) => r.run.span_id.startsWith('embed:'))).toBe(true);
  });

  it('VAI-07 an embedding without reported usage has no input_tokens and is accepted', async () => {
    const h = harness();
    await embed({
      model: embeddingModel({ tokens: 'unreported' }),
      value: 'x',
      ...withAudr(h.telemetry),
    });
    const records = await h.records();
    expect(records).toHaveLength(1);
    expect(records[0]!.usage.llm).toEqual({ requests: 1 });
    expect(h.logger.lines).toEqual([]);
  });

  it('VAI-07 rerank yields one reranking record', async () => {
    const h = harness();
    await rerank({
      model: rerankingModel(),
      documents: ['a', 'b'],
      query: 'q',
      ...withAudr(h.telemetry),
    });
    const records = await h.records();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      resource: {
        provider: 'cohere',
        name: 'rerank-v3.5',
        operation: 'reranking',
        modality: 'text',
      },
      usage: { llm: { requests: 1 } },
      run: { run_type: 'single_call' },
    });
    expect(records[0]!.run.span_id).toBe(`rerank:${records[0]!.run.run_id}:0`);
  });
});

describe('VAI-08 attribution through the SDK', () => {
  it('VAI-08 per-call attribution overrides defaults field by field', async () => {
    const h = harness({ attributionDefaults: { environment: 'production', account_id: 'a' } });
    await generateText({
      model: model({ toolCalls: [{ id: 'tc-1', name: 'lookup', input: '{"id":"42"}' }] }),
      prompt: 'x',
      tools: { lookup },
      stopWhen: isStepCount(3),
      ...withAudr(h.telemetry, { account_id: 'b' }),
    });
    const records = await h.records();
    expect(records).toHaveLength(3);
    for (const record of records) {
      expect(record.attribution).toEqual({ environment: 'production', account_id: 'b' });
    }
  });

  it('VAI-08 runtimeContext not whitelisted leaves only the defaults', async () => {
    const h = harness({ attributionDefaults: { environment: 'test', account_id: 'a' } });
    await generateText({
      model: model(),
      prompt: 'x',
      runtimeContext: { audr: { account_id: 'b' } },
      telemetry: { integrations: [h.telemetry] },
    });
    const [record] = await h.records();
    expect(record!.attribution).toEqual({ environment: 'test', account_id: 'a' });
  });

  it('VAI-08 embed and rerank read runtimeContext too', async () => {
    const h = harness();
    await embed({
      model: embeddingModel(),
      value: 'x',
      ...withAudr(h.telemetry, { user_id: 'u1' }),
    });
    await rerank({
      model: rerankingModel(),
      documents: ['a'],
      query: 'q',
      ...withAudr(h.telemetry, { user_id: 'u2' }),
    });
    const records = await h.records();
    expect(records.map((r) => r.attribution.user_id)).toEqual(['u1', 'u2']);
  });
});

describe('VAI-09 run identifiers', () => {
  it('VAI-09 separate calls get separate runs and fresh record ids', async () => {
    const h = harness();
    await generateText({ model: model(), prompt: 'x', ...withAudr(h.telemetry) });
    await generateText({ model: model(), prompt: 'x', ...withAudr(h.telemetry) });
    const records = await h.records();
    expect(new Set(records.map((r) => r.run.run_id)).size).toBe(2);
    expect(new Set(records.map((r) => r.record_id)).size).toBe(2);
    expect(records.every((r) => r.run.step === 0)).toBe(true);
  });
});

describe('VAI-09 tool spans stay unique', () => {
  function reusingIds(): MockLanguageModelV4 {
    let calls = 0;
    const reply = (content: unknown, unified: 'tool-calls' | 'stop') => ({
      content,
      finishReason: { unified, raw: unified },
      usage: PROVIDER_USAGE,
      warnings: [],
    });
    return new MockLanguageModelV4({
      provider: 'openai-compatible.chat',
      modelId: 'local-model',
      doGenerate: () => {
        calls += 1;
        return Promise.resolve(
          (calls <= 2
            ? reply(
                [
                  {
                    type: 'tool-call',
                    toolCallId: 'call_0',
                    toolName: 'lookup',
                    input: '{"id":"1"}',
                  },
                ],
                'tool-calls',
              )
            : reply([{ type: 'text', text: 'ok' }], 'stop')) as never,
        );
      },
    });
  }

  it('VAI-09 a provider reusing a tool call id across steps gets distinct spans', async () => {
    const h = harness();
    await generateText({
      model: reusingIds(),
      prompt: 'x',
      tools: { lookup },
      stopWhen: isStepCount(5),
      ...withAudr(h.telemetry),
    });
    const records = await h.records();
    const runId = records[0]!.run.run_id;
    expect(
      records.filter((r) => r.resource.operation === 'tool_execution').map((r) => r.run.span_id),
    ).toEqual([`tool:${runId}:call_0`, `tool:${runId}:call_0:1`]);
    expect(new Set(records.map((r) => r.run.span_id)).size).toBe(records.length);
  });
});

describe('VAI-11 failure cleanup', () => {
  it('VAI-11 failed embedding calls leave no state behind', async () => {
    const h = harness({ maxTrackedOperations: 2 });
    let calls = 0;
    const flaky = embeddingModel();
    const original = flaky.doEmbed.bind(flaky);
    flaky.doEmbed = (options) => {
      calls += 1;
      return calls % 2 === 1 ? Promise.reject(new Error('provider down')) : original(options);
    };
    for (let i = 0; i < 6; i += 1) {
      await embed({ model: flaky, value: 'x', maxRetries: 0, ...withAudr(h.telemetry) }).catch(
        () => undefined,
      );
    }
    expect(await h.records()).toHaveLength(3);
    expect(h.logger.lines).toEqual([]);
  });

  it('VAI-11 a call that throws after one model call keeps its record', async () => {
    const h = harness();
    let calls = 0;
    const flaky = model();
    const original = flaky.doGenerate.bind(flaky);
    flaky.doGenerate = async (options) => {
      calls += 1;
      if (calls === 2) throw new Error('provider down');
      const result = await original(options);
      return {
        ...result,
        content: [
          { type: 'tool-call', toolCallId: 'tc-1', toolName: 'lookup', input: '{"id":"1"}' },
        ],
        finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
      };
    };
    await expect(
      generateText({
        model: flaky,
        prompt: 'x',
        tools: { lookup },
        stopWhen: isStepCount(3),
        maxRetries: 0,
        ...withAudr(h.telemetry),
      }),
    ).rejects.toThrow();
    const records = await h.records();
    expect(records.map((r) => r.resource.operation)).toEqual(['generation', 'tool_execution']);
  });
});

describe('VAI-15 provider slugs through the SDK', () => {
  it('VAI-15 a gateway model string meters as vercel-ai-gateway with the name verbatim', async () => {
    const h = harness();
    globalThis.AI_SDK_DEFAULT_PROVIDER = customProvider({
      languageModels: {
        'openai/gpt-5.4': model({ provider: 'gateway', modelId: 'openai/gpt-5.4' }),
      },
    });
    await generateText({ model: 'openai/gpt-5.4', prompt: 'x', ...withAudr(h.telemetry) });
    const [record] = await h.records();
    expect(record!.resource).toMatchObject({
      provider: 'vercel-ai-gateway',
      name: 'openai/gpt-5.4',
    });
  });

  it('VAI-15 the README mapResource attributes gateway calls to the vendor', async () => {
    const h = harness({
      mapResource: ({ provider, modelId }) => {
        if (provider !== 'gateway') return undefined;
        const slash = modelId.indexOf('/');
        return slash > 0
          ? { provider: modelId.slice(0, slash), name: modelId.slice(slash + 1) }
          : undefined;
      },
    });
    globalThis.AI_SDK_DEFAULT_PROVIDER = customProvider({
      languageModels: {
        'openai/gpt-5.4': model({ provider: 'gateway', modelId: 'openai/gpt-5.4' }),
        'meta/llama/4-scout': model({ provider: 'gateway', modelId: 'meta/llama/4-scout' }),
      },
    });
    await generateText({ model: 'openai/gpt-5.4', prompt: 'x', ...withAudr(h.telemetry) });
    await generateText({ model: 'meta/llama/4-scout', prompt: 'x', ...withAudr(h.telemetry) });
    const records = await h.records();
    expect(records.map((r) => [r.resource.provider, r.resource.name])).toEqual([
      ['openai', 'gpt-5.4'],
      ['meta', 'llama/4-scout'],
    ]);
  });
});
