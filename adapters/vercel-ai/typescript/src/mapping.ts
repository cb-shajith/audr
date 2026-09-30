import type { LanguageModelUsage } from 'ai';
import type { LlmUsage, RunType } from 'audr';

/** Written to `run.error_code` on a failed tool execution. */
export const TOOL_ERROR_CODE = 'VERCEL_AI_TOOL_ERROR';

/** `resource.provider` for every client-side tool. */
export const TOOL_PROVIDER = 'self-hosted';

const SLUG = /^[a-z0-9-]+$/;

/**
 * AI SDK provider ids whose vendor prefix is not the AUDR provider. Each entry matches the
 * id itself and every `<id>.<api>` below it; the first match wins.
 */
const PROVIDER_ALIASES: readonly (readonly [prefixes: readonly string[], slug: string])[] = [
  [['gateway'], 'vercel-ai-gateway'],
  [['azure'], 'azure-openai'],
  [['amazon-bedrock', 'bedrock', 'bedrock-mantle'], 'aws-bedrock'],
  [['google.vertex', 'googleVertex', 'vertex'], 'google-vertex'],
];

/** A counter the SDK reported, or `undefined` unless it is a finite integer >= 0. */
export function counter(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** A duration in whole milliseconds, or `undefined` unless it is finite and >= 0. */
export function durationMs(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

/**
 * AUDR token counters from AI SDK usage: `input_tokens` excludes cache reads and writes,
 * `output_tokens` excludes reasoning. Unreported counters are omitted; `totalTokens` and
 * `raw` are never copied.
 */
export function toLlmUsage(usage: LanguageModelUsage): LlmUsage {
  const input = counter(usage.inputTokens);
  const noCache = counter(usage.inputTokenDetails.noCacheTokens);
  const cacheRead = counter(usage.inputTokenDetails.cacheReadTokens);
  const cacheWrite = counter(usage.inputTokenDetails.cacheWriteTokens);
  const output = counter(usage.outputTokens);
  const text = counter(usage.outputTokenDetails.textTokens);
  const reasoning = counter(usage.outputTokenDetails.reasoningTokens);
  const cached = (cacheRead ?? 0) + (cacheWrite ?? 0);
  return withoutUndefined({
    input_tokens: noCache ?? subtract(input, cached),
    output_tokens: text ?? subtract(output, reasoning ?? 0),
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
    reasoning_tokens: reasoning,
    requests: 1,
  });
}

function subtract(total: number | undefined, part: number): number | undefined {
  return total === undefined ? undefined : Math.max(total - part, 0);
}

function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

/** Whether `slug` is a valid AUDR `resource.provider`. */
export function isProviderSlug(slug: unknown): slug is string {
  return typeof slug === 'string' && SLUG.test(slug);
}

/**
 * The AUDR provider for an AI SDK provider id: the alias table first, then the text before
 * the first `.`, lowercased, with runs of other characters replaced by `-`. `undefined`
 * when nothing valid remains.
 */
export function providerSlug(provider: string): string | undefined {
  for (const [prefixes, slug] of PROVIDER_ALIASES) {
    if (prefixes.some((prefix) => provider === prefix || provider.startsWith(`${prefix}.`))) {
      return slug;
    }
  }
  const head = provider.split('.', 1)[0] ?? '';
  const slug = head
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : undefined;
}

/**
 * The deprecated object operations report usage through `onObjectStepEnd`, never through a
 * model call end event, so they produce no records.
 */
const UNSUPPORTED_OPERATIONS: ReadonlySet<string> = new Set([
  'ai.generateObject',
  'ai.streamObject',
]);

export function isSupportedOperation(operationId: string): boolean {
  return !UNSUPPORTED_OPERATIONS.has(operationId);
}

/** `agent_run` for text generation, which may loop through tools; `single_call` otherwise. */
export function runTypeFor(operationId: string): RunType {
  return operationId === 'ai.generateText' || operationId === 'ai.streamText'
    ? 'agent_run'
    : 'single_call';
}

export function modelSpanId(callId: string, index: number): string {
  return `model:${callId}:${String(index)}`;
}

export function toolSpanId(callId: string, toolCallId: string): string {
  return `tool:${callId}:${toolCallId}`;
}

export function embedSpanId(embedCallId: string): string {
  return `embed:${embedCallId}`;
}

export function rerankSpanId(callId: string, index: number): string {
  return `rerank:${callId}:${String(index)}`;
}
