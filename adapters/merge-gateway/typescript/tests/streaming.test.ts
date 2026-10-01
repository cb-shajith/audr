import { Stream } from 'merge-gateway-sdk';
import { describe, expect, it } from 'vitest';

import { drain, harness, response, RESPONSE_LLM, streamFrames } from './helpers.js';

const PARAMS = { model: 'openai/gpt-5.4', input: 'hi', stream: true } as const;

function incomplete(reason: string): string {
  return `@openaudr/adapter-merge-gateway: STREAM_INCOMPLETE (operation=responses.create, reason=${reason})`;
}

describe('streamed responses', () => {
  it('records the response.done frame and yields every frame unchanged', async () => {
    const h = harness();
    const frames = streamFrames();
    h.fake.sse(frames);
    const stream = await h.gateway.responses.create(PARAMS);
    expect(stream).toBeInstanceOf(Stream);
    expect(await drain(stream)).toEqual(frames);
    const [record, ...rest] = await h.records();
    expect(rest).toEqual([]);
    expect(record).toMatchObject({
      resource: { provider: 'merge-gateway', name: 'openai/gpt-5.4', operation: 'generation' },
      usage: { llm: RESPONSE_LLM },
      cost: { total_cost: 0.002365, currency: 'USD' },
      run: { run_id: 'resp_01J9Z8QK4M', span_id: 'response:resp_01J9Z8QK4M' },
    });
    expect(h.logger.lines).toEqual([]);
  });

  it('submits the record before the terminal frame reaches the caller', async () => {
    const h = harness();
    h.fake.sse(streamFrames());
    const stream = await h.gateway.responses.create(PARAMS);
    const seen: number[] = [];
    for await (const frame of stream) {
      seen.push(h.client.stats.submitted);
      if ((frame as { object?: unknown }).object === 'response.done') break;
    }
    expect(seen).toEqual([0, 0, 1]);
    expect(h.logger.lines).toEqual([]);
  });

  it('records only the terminal frame after a fallback restart', async () => {
    const h = harness();
    const done = response({ model: 'openai/gpt-5.4', vendor: 'azure' });
    const frames = [
      { ...response(), usage: undefined, object: 'response.stream' },
      { fallback_restart: true, model: 'openai/gpt-5.4', vendor: 'azure' },
      ...streamFrames(done),
    ];
    h.fake.sse(frames);
    expect(await drain(await h.gateway.responses.create(PARAMS))).toEqual(frames);
    expect(await h.records()).toHaveLength(1);
  });

  it('forwards other stream members to the native stream', async () => {
    const h = harness();
    h.fake.sse(streamFrames());
    const stream = await h.gateway.responses.create(PARAMS);
    expect(Symbol.asyncIterator in stream).toBe(true);
    await drain(stream);
    expect(await h.records()).toHaveLength(1);
  });
});

describe('incomplete streams produce no record', () => {
  it('a response.error frame', async () => {
    const h = harness();
    const frames = [
      streamFrames()[0],
      { object: 'response.error', error: { type: 'api_error', message: 'x', status_code: '502' } },
    ];
    h.fake.sse(frames);
    expect(await drain(await h.gateway.responses.create(PARAMS))).toEqual(frames);
    expect(await h.records()).toEqual([]);
    expect(h.logger.warnings).toEqual([incomplete('error_frame')]);
  });

  it('a stream that ends without a terminal frame', async () => {
    const h = harness();
    h.fake.sse(streamFrames().slice(0, 2));
    await drain(await h.gateway.responses.create(PARAMS));
    expect(await h.records()).toEqual([]);
    expect(h.logger.warnings).toEqual([incomplete('ended')]);
  });

  it('an iteration failure, which still reaches the caller', async () => {
    const h = harness();
    h.fake.sse(streamFrames(), { failAfter: 1 });
    const stream = await h.gateway.responses.create(PARAMS);
    await expect(drain(stream)).rejects.toThrow(TypeError);
    expect(await h.records()).toEqual([]);
    expect(h.logger.warnings).toEqual([incomplete('failed')]);
  });

  it('a consumer that stops early', async () => {
    const h = harness();
    h.fake.sse(streamFrames());
    const stream = await h.gateway.responses.create(PARAMS);
    for await (const frame of stream) {
      expect(frame).toBeDefined();
      break;
    }
    expect(await h.records()).toEqual([]);
    expect(h.logger.warnings).toEqual([incomplete('abandoned')]);
  });

  it('close() before the terminal frame, reported once', async () => {
    const h = harness();
    h.fake.sse(streamFrames());
    const stream = await h.gateway.responses.create(PARAMS);
    stream.close();
    stream.close();
    expect(await h.records()).toEqual([]);
    expect(h.logger.warnings).toEqual([incomplete('closed')]);
  });

  it('close() inside the loop fails exactly as the native stream does', async () => {
    // merge-gateway-sdk 0.4.0 releases a reader it has already cleared when closed mid-loop.
    const h = harness();
    h.fake.sse(streamFrames());
    const stream = await h.gateway.responses.create(PARAMS);
    const consume = async (): Promise<void> => {
      for await (const frame of stream) {
        expect(frame).toBeDefined();
        stream.close();
        break;
      }
    };
    await expect(consume()).rejects.toThrow(/releaseLock/);
    expect(await h.records()).toEqual([]);
    expect(h.logger.warnings).toEqual([incomplete('closed')]);
  });

  it('close() after the terminal frame reports nothing', async () => {
    const h = harness();
    h.fake.sse(streamFrames());
    const stream = await h.gateway.responses.create(PARAMS);
    await drain(stream);
    stream.close();
    expect(await h.records()).toHaveLength(1);
    expect(h.logger.lines).toEqual([]);
  });
});
