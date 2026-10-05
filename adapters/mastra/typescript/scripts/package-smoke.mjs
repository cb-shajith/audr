// Run by tools/verify-npm-package.mjs in an empty project where the packed package is installed.
import { Client } from '@openaudr/audr';
import { MemorySink } from '@openaudr/audr/testing';
import { AudrExporter } from '@openaudr/audr-adapter-mastra';

const sink = new MemorySink();
const client = new Client(sink, {
  emitter: { component: 'harness', name: 'package-smoke', version: '0' },
  logger: { warn() {}, error() {} },
});
const exporter = new AudrExporter({
  client,
  attributionDefaults: { environment: 'test' },
});
await exporter.exportTracingEvent({
  type: 'span_ended',
  exportedSpan: {
    id: 'b'.repeat(16),
    traceId: 'a'.repeat(32),
    name: 'inference',
    type: 'model_inference',
    startTime: new Date('2026-01-15T10:00:00.000Z'),
    endTime: new Date('2026-01-15T10:00:01.000Z'),
    isEvent: false,
    isRootSpan: false,
    attributes: {
      provider: 'openai.chat',
      model: 'gpt-5.4',
      usage: { inputTokens: 12, outputTokens: 7 },
    },
    metadata: {},
  },
});
await client.shutdown();
if (
  sink.records.length !== 1 ||
  sink.records[0].usage.llm.input_tokens !== 12 ||
  sink.records[0].usage.llm.requests !== 1
) {
  throw new Error('call was not metered');
}
