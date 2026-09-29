import { type LanguageModelUsage, simulateReadableStream, type Telemetry } from 'ai';
import { MockEmbeddingModelV4, MockLanguageModelV4, MockRerankingModelV4 } from 'ai/test';
import { type AudrRecord, Client, type Logger } from 'audr';
import { MemorySink } from 'audr/testing';

import { audrTelemetry, type AudrTelemetryOptions } from '../src/index.js';

type LanguageModelV4GenerateResult = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>;
type LanguageModelV4Usage = LanguageModelV4GenerateResult['usage'];

/** A logger that keeps every line it is given. */
export class CapturingLogger implements Logger {
  readonly warnings: string[] = [];
  readonly errors: string[] = [];

  warn(message: string): void {
    this.warnings.push(message);
  }

  error(message: string): void {
    this.errors.push(message);
  }

  get lines(): string[] {
    return [...this.warnings, ...this.errors];
  }
}

export interface Harness {
  readonly sink: MemorySink;
  readonly client: Client;
  readonly logger: CapturingLogger;
  /** The client's own diagnostics, kept apart from the adapter's. */
  readonly clientLogger: CapturingLogger;
  readonly telemetry: Telemetry;
  /** Flush the client and return every record the sink has accepted. */
  records(): Promise<AudrRecord[]>;
}

export function harness(options: Partial<AudrTelemetryOptions> = {}): Harness {
  const sink = new MemorySink();
  const clientLogger = new CapturingLogger();
  const client = new Client(sink, {
    emitter: { component: 'harness', name: 'vercel-ai-tests', version: '0' },
    logger: clientLogger,
  });
  const logger = new CapturingLogger();
  const telemetry = audrTelemetry({
    client,
    logger,
    attributionDefaults: { environment: 'test' },
    ...options,
  });
  return {
    sink,
    client,
    logger,
    clientLogger,
    telemetry,
    async records() {
      await client.flush();
      return sink.records;
    },
  };
}

/** Telemetry options that pass `runtimeContext.audr` through to the integration. */
export function withAudr(
  telemetry: Telemetry,
  audr: Record<string, unknown> = {},
): {
  runtimeContext: { audr: Record<string, unknown> };
  telemetry: { integrations: Telemetry[]; includeRuntimeContext: { audr: true } };
} {
  return {
    runtimeContext: { audr },
    telemetry: { integrations: [telemetry], includeRuntimeContext: { audr: true } },
  };
}

export const PROVIDER_USAGE: LanguageModelV4Usage = {
  inputTokens: { total: 120, noCache: 100, cacheRead: 20, cacheWrite: undefined },
  outputTokens: { total: 50, text: 40, reasoning: 10 },
};

/** The SDK-level usage the provider usage above normalises to. */
export const SDK_USAGE: LanguageModelUsage = {
  inputTokens: 120,
  inputTokenDetails: { noCacheTokens: 100, cacheReadTokens: 20, cacheWriteTokens: undefined },
  outputTokens: 50,
  outputTokenDetails: { textTokens: 40, reasoningTokens: 10 },
  totalTokens: 170,
};

export const LLM_USAGE = {
  input_tokens: 100,
  output_tokens: 40,
  cache_read_tokens: 20,
  reasoning_tokens: 10,
  requests: 1,
};

const STOP = { unified: 'stop', raw: 'stop' } as const;

function text(value: string, modelId: string | undefined): LanguageModelV4GenerateResult {
  return {
    content: [{ type: 'text', text: value }],
    finishReason: STOP,
    usage: PROVIDER_USAGE,
    warnings: [],
    ...(modelId === undefined ? {} : { response: { modelId } }),
  };
}

function toolCalls(
  calls: readonly { id: string; name: string; input: string }[],
  modelId: string | undefined,
): LanguageModelV4GenerateResult {
  return {
    content: calls.map((call) => ({
      type: 'tool-call' as const,
      toolCallId: call.id,
      toolName: call.name,
      input: call.input,
    })),
    finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
    usage: PROVIDER_USAGE,
    warnings: [],
    ...(modelId === undefined ? {} : { response: { modelId } }),
  };
}

export interface ModelOptions {
  readonly provider?: string;
  readonly modelId?: string;
  /** The model id the provider echoes back; defaults to the requested one. */
  readonly echoedModelId?: string;
  /** Tool calls made on the first call; later calls answer with text. */
  readonly toolCalls?: readonly { id: string; name: string; input: string }[];
  /** The answer text. */
  readonly answer?: string;
}

/**
 * A language model that makes the given tool calls on its first `doGenerate`, then
 * answers. `doStream` answers at once.
 */
export function model(options: ModelOptions = {}): MockLanguageModelV4 {
  const answer = options.answer ?? 'ok';
  let calls = 0;
  return new MockLanguageModelV4({
    provider: options.provider ?? 'openai.chat',
    modelId: options.modelId ?? 'gpt-5.4',
    doGenerate: () => {
      calls += 1;
      const planned = options.toolCalls;
      return Promise.resolve(
        calls === 1 && planned !== undefined && planned.length > 0
          ? toolCalls(planned, options.echoedModelId)
          : text(answer, options.echoedModelId),
      );
    },
    doStream: () =>
      Promise.resolve({
        stream: simulateReadableStream({
          chunks: [
            ...(options.echoedModelId === undefined
              ? []
              : [{ type: 'response-metadata' as const, modelId: options.echoedModelId }]),
            { type: 'text-start' as const, id: 't' },
            { type: 'text-delta' as const, id: 't', delta: answer },
            { type: 'text-end' as const, id: 't' },
            { type: 'finish' as const, finishReason: STOP, usage: PROVIDER_USAGE },
          ],
        }),
      }),
  });
}

/** An embedding model reporting `tokens` per call; `'unreported'` omits usage entirely. */
export function embeddingModel(
  options: { tokens?: number | 'unreported'; maxEmbeddingsPerCall?: number } = {},
): MockEmbeddingModelV4 {
  const tokens = options.tokens ?? 7;
  return new MockEmbeddingModelV4({
    provider: 'openai.embedding',
    modelId: 'text-embedding-3-small',
    maxEmbeddingsPerCall: options.maxEmbeddingsPerCall ?? 100,
    doEmbed: ({ values }) =>
      Promise.resolve({
        embeddings: values.map(() => [0.1, 0.2]),
        ...(tokens === 'unreported' ? {} : { usage: { tokens } }),
        warnings: [],
      }),
  });
}

export function rerankingModel(): MockRerankingModelV4 {
  return new MockRerankingModelV4({
    provider: 'cohere.reranking',
    modelId: 'rerank-v3.5',
    doRerank: ({ documents }) =>
      Promise.resolve({
        ranking: documents.values.map((_, index) => ({ index, relevanceScore: 1 - index / 10 })),
      }),
  });
}
