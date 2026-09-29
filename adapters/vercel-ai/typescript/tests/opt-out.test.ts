/** VAI-16: metering follows the AI SDK's telemetry settings. */
import { embed, generateText, registerTelemetry } from 'ai';
import { afterEach, describe, expect, it } from 'vitest';

import { embeddingModel, harness, model } from './helpers.js';

afterEach(() => {
  globalThis.AI_SDK_TELEMETRY_INTEGRATIONS = undefined;
});

describe('VAI-16 opt-outs are honoured', () => {
  it('VAI-16 isEnabled: false produces no records', async () => {
    const h = harness();
    registerTelemetry(h.telemetry);
    await generateText({ model: model(), prompt: 'x', telemetry: { isEnabled: false } });
    await embed({ model: embeddingModel(), value: 'x', telemetry: { isEnabled: false } });
    expect(await h.records()).toEqual([]);
  });

  it('VAI-16 per-call integrations that omit the adapter replace it', async () => {
    const h = harness();
    registerTelemetry(h.telemetry);
    const other = { onStart: () => undefined };
    await generateText({ model: model(), prompt: 'x', telemetry: { integrations: [other] } });
    expect(await h.records()).toEqual([]);
  });

  it('VAI-16 per-call integrations that include the adapter are metered', async () => {
    const h = harness();
    const other = { onStart: () => undefined };
    await generateText({
      model: model(),
      prompt: 'x',
      telemetry: { integrations: [other, h.telemetry] },
    });
    expect(await h.records()).toHaveLength(1);
  });
});
