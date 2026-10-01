import { describe, expect, it } from 'vitest';

import { CallTracker, closeToolSpan, openToolSpan } from '../src/runs.js';

const root = {
  operationId: 'ai.generateText',
  attribution: { environment: 'test' as const },
  runType: 'agent_run' as const,
  name: 'agent',
};

describe('call cleanup', () => {
  it('end is idempotent', () => {
    const tracker = new CallTracker();
    tracker.startRoot({ callId: 'call-1', ...root });
    tracker.end('call-1');
    tracker.end('call-1');
    tracker.end('never-started');
    expect(tracker.get('call-1')).toBeUndefined();
  });

  it('ending a sub-agent leaves its parent tracked', () => {
    const tracker = new CallTracker();
    tracker.startRoot({ callId: 'call-1', ...root });
    tracker.startChild('call-2', 'ai.generateText', {
      call: tracker.get('call-1')!,
      spanId: 'tool:call-1:tc',
    });
    tracker.end('call-2');
    expect(tracker.get('call-2')).toBeUndefined();
    expect(tracker.get('call-1')).toBeDefined();
  });
});

describe('call state', () => {
  it('a root call is its own run with a fresh step sequence', () => {
    const tracker = new CallTracker();
    tracker.startRoot({ callId: 'call-1', ...root });
    expect(tracker.get('call-1')).toEqual({
      callId: 'call-1',
      runId: 'call-1',
      operationId: 'ai.generateText',
      parentSpanId: undefined,
      attribution: { environment: 'test' },
      runType: 'agent_run',
      name: 'agent',
      steps: { next: 0 },
      modelCalls: 0,
      rerankCalls: 0,
      toolCalls: 0,
      openToolSpans: new Map(),
      embedStartTimes: new Map(),
      rerankStartedAt: undefined,
    });
  });

  it('a child call joins its parent and shares the step sequence', () => {
    const tracker = new CallTracker();
    tracker.startRoot({ callId: 'call-1', ...root });
    const parent = tracker.get('call-1')!;
    parent.modelCalls = 3;
    tracker.startChild('call-2', 'ai.embed', { call: parent, spanId: 'tool:call-1:tc' });
    const child = tracker.get('call-2')!;
    expect(child).toMatchObject({
      runId: 'call-1',
      operationId: 'ai.embed',
      parentSpanId: 'tool:call-1:tc',
      attribution: parent.attribution,
      runType: 'agent_run',
      name: 'agent',
      modelCalls: 0,
    });
    expect(child.steps).toBe(parent.steps);
    expect(child.toolCalls).toBe(0);
    expect(child.embedStartTimes).not.toBe(parent.embedStartTimes);
  });

  it('the tool span is scoped to its callback', async () => {
    const tracker = new CallTracker();
    tracker.startRoot({ callId: 'call-1', ...root });
    const span = { call: tracker.get('call-1')!, spanId: 'tool:call-1:tc' };
    expect(tracker.currentToolSpan()).toBeUndefined();
    await tracker.runInToolSpan(span, async () => {
      await Promise.resolve();
      expect(tracker.currentToolSpan()).toBe(span);
    });
    expect(tracker.currentToolSpan()).toBeUndefined();
  });

  it('the tool span belongs to its tracker', async () => {
    const mine = new CallTracker();
    const other = new CallTracker();
    mine.startRoot({ callId: 'call-1', ...root });
    await mine.runInToolSpan({ call: mine.get('call-1')!, spanId: 'tool:call-1:tc' }, async () => {
      await Promise.resolve();
      expect(other.currentToolSpan()).toBeUndefined();
    });
  });

  it("a tracker finds its own span under another tracker's span", async () => {
    const mine = new CallTracker();
    const other = new CallTracker();
    mine.startRoot({ callId: 'call-1', ...root });
    other.startRoot({ callId: 'call-2', ...root });
    const outer = { call: mine.get('call-1')!, spanId: 'tool:call-1:tc' };
    const inner = { call: other.get('call-2')!, spanId: 'tool:call-2:tc' };
    await mine.runInToolSpan(outer, () =>
      other.runInToolSpan(inner, async () => {
        await Promise.resolve();
        expect(mine.currentToolSpan()).toBe(outer);
        expect(other.currentToolSpan()).toBe(inner);
      }),
    );
  });

  it('the innermost span of a tracker wins', async () => {
    const tracker = new CallTracker();
    tracker.startRoot({ callId: 'call-1', ...root });
    const call = tracker.get('call-1')!;
    const outer = { call, spanId: 'tool:call-1:a' };
    const inner = { call, spanId: 'tool:call-1:b' };
    await tracker.runInToolSpan(outer, async () => {
      await tracker.runInToolSpan(inner, async () => {
        await Promise.resolve();
        expect(tracker.currentToolSpan()).toBe(inner);
      });
      expect(tracker.currentToolSpan()).toBe(outer);
    });
  });
});

describe('tool spans', () => {
  it('a reused tool call id gets a suffixed span', () => {
    const tracker = new CallTracker();
    tracker.startRoot({ callId: 'call-1', ...root });
    const call = tracker.get('call-1')!;
    expect(openToolSpan(call, 'tc')).toBe('tool:call-1:0:tc');
    expect(closeToolSpan(call, 'tc')).toBe('tool:call-1:0:tc');
    expect(openToolSpan(call, 'tc')).toBe('tool:call-1:1:tc');
    expect(closeToolSpan(call, 'tc')).toBe('tool:call-1:1:tc');
    expect(call.openToolSpans.size).toBe(0);
  });

  it('an invocation index never collides with a literal tool call id', () => {
    const tracker = new CallTracker();
    tracker.startRoot({ callId: 'call-1', ...root });
    const call = tracker.get('call-1')!;
    const spans = ['tc:1', 'tc', 'tc', 'tc'].map((id) => closeToolSpan(call, id));
    expect(spans).toEqual([
      'tool:call-1:0:tc:1',
      'tool:call-1:1:tc',
      'tool:call-1:2:tc',
      'tool:call-1:3:tc',
    ]);
  });

  it('completed tool spans retain no per-invocation history', () => {
    const tracker = new CallTracker();
    tracker.startRoot({ callId: 'call-1', ...root });
    const call = tracker.get('call-1')!;
    for (let index = 0; index < 1_000; index += 1) {
      closeToolSpan(call, `tc-${String(index)}`);
    }
    expect(call.toolCalls).toBe(1_000);
    expect(call.openToolSpans.size).toBe(0);
    expect(call).not.toHaveProperty('usedToolSpanIds');
  });
});
