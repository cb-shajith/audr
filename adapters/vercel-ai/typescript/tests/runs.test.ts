import { describe, expect, it } from 'vitest';

import { CallTracker, closeToolSpan, LruMap, openToolSpan } from '../src/runs.js';

const root = {
  operationId: 'ai.generateText',
  attribution: { environment: 'test' as const },
  runType: 'agent_run' as const,
  name: 'agent',
};

describe('VAI-11 bounded state', () => {
  it('VAI-11 evicts oldest first and reports the count', () => {
    const map = new LruMap<number>(2);
    expect(map.set('a', 1)).toBe(0);
    expect(map.set('b', 2)).toBe(0);
    expect(map.set('c', 3)).toBe(1);
    expect(map.get('a')).toBeUndefined();
    expect(map.get('b')).toBe(2);
    expect(map.size).toBe(2);
  });

  it('VAI-11 re-setting a key refreshes its position', () => {
    const map = new LruMap<number>(2);
    map.set('a', 1);
    map.set('b', 2);
    map.set('a', 3);
    map.set('c', 4);
    expect(map.get('a')).toBe(3);
    expect(map.get('b')).toBeUndefined();
  });

  it('VAI-11 reading an entry keeps it from eviction', () => {
    const map = new LruMap<number>(2);
    map.set('a', 1);
    map.set('b', 2);
    map.get('a');
    map.touch('missing');
    map.set('c', 3);
    expect(map.get('a')).toBe(1);
    expect(map.get('b')).toBeUndefined();
  });

  it('VAI-11 starting a sub-agent keeps its parent from eviction', () => {
    const tracker = new CallTracker(2);
    tracker.startRoot({ callId: 'call-1', ...root });
    tracker.startRoot({ callId: 'call-0', ...root });
    const span = { call: tracker.get('call-1')!, spanId: 'tool:call-1:tc' };
    tracker.get('call-0');
    expect(tracker.startChild('call-2', 'ai.generateText', span)).toBe(1);
    expect(tracker.get('call-1')).toBeDefined();
    expect(tracker.get('call-0')).toBeUndefined();
  });

  it('VAI-11 activity in a sub-agent keeps its parent from eviction', () => {
    const tracker = new CallTracker(3);
    tracker.startRoot({ callId: 'call-1', ...root });
    tracker.startChild('call-2', 'ai.generateText', {
      call: tracker.get('call-1')!,
      spanId: 'tool:call-1:tc',
    });
    tracker.startRoot({ callId: 'call-0', ...root });
    tracker.get('call-2');
    expect(tracker.startRoot({ callId: 'call-3', ...root })).toBe(1);
    expect(tracker.get('call-1')).toBeDefined();
    expect(tracker.get('call-0')).toBeUndefined();
  });

  it('VAI-11 delete is idempotent', () => {
    const map = new LruMap<number>(2);
    map.set('a', 1);
    map.delete('a');
    map.delete('a');
    expect(map.get('a')).toBeUndefined();
    expect(map.size).toBe(0);
  });

  it('VAI-11 end is idempotent', () => {
    const tracker = new CallTracker(4);
    tracker.startRoot({ callId: 'call-1', ...root });
    tracker.end('call-1');
    tracker.end('call-1');
    tracker.end('never-started');
    expect(tracker.get('call-1')).toBeUndefined();
  });
});

describe('VAI-10 call state', () => {
  it('VAI-10 a root call is its own run with a fresh step sequence', () => {
    const tracker = new CallTracker(4);
    tracker.startRoot({ callId: 'call-1', ...root });
    expect(tracker.get('call-1')).toEqual({
      callId: 'call-1',
      runId: 'call-1',
      parent: undefined,
      operationId: 'ai.generateText',
      parentSpanId: undefined,
      attribution: { environment: 'test' },
      runType: 'agent_run',
      name: 'agent',
      steps: { next: 0 },
      modelCalls: 0,
      rerankCalls: 0,
      usedToolSpanIds: new Set(),
      openToolSpans: new Map(),
      embedStartTimes: new Map(),
      rerankStartedAt: undefined,
    });
  });

  it('VAI-10 a child call joins its parent and shares the step sequence', () => {
    const tracker = new CallTracker(4);
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
    expect(child.usedToolSpanIds).not.toBe(parent.usedToolSpanIds);
    expect(child.embedStartTimes).not.toBe(parent.embedStartTimes);
  });

  it('VAI-10 the tool span is scoped to its callback', async () => {
    const tracker = new CallTracker(4);
    tracker.startRoot({ callId: 'call-1', ...root });
    const span = { call: tracker.get('call-1')!, spanId: 'tool:call-1:tc' };
    expect(tracker.currentToolSpan()).toBeUndefined();
    await tracker.runInToolSpan(span, async () => {
      await Promise.resolve();
      expect(tracker.currentToolSpan()).toBe(span);
    });
    expect(tracker.currentToolSpan()).toBeUndefined();
  });

  it('VAI-10 the tool span belongs to its tracker', async () => {
    const mine = new CallTracker(4);
    const other = new CallTracker(4);
    mine.startRoot({ callId: 'call-1', ...root });
    await mine.runInToolSpan({ call: mine.get('call-1')!, spanId: 'tool:call-1:tc' }, async () => {
      await Promise.resolve();
      expect(other.currentToolSpan()).toBeUndefined();
    });
  });

  it("VAI-10 a tracker finds its own span under another tracker's span", async () => {
    const mine = new CallTracker(4);
    const other = new CallTracker(4);
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

  it('VAI-10 the innermost span of a tracker wins', async () => {
    const tracker = new CallTracker(4);
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

describe('VAI-09 tool spans', () => {
  it('VAI-09 a reused tool call id gets a suffixed span', () => {
    const tracker = new CallTracker(4);
    tracker.startRoot({ callId: 'call-1', ...root });
    const call = tracker.get('call-1')!;
    expect(openToolSpan(call, 'tc')).toBe('tool:call-1:tc');
    expect(closeToolSpan(call, 'tc')).toBe('tool:call-1:tc');
    expect(openToolSpan(call, 'tc')).toBe('tool:call-1:tc:1');
    expect(closeToolSpan(call, 'tc')).toBe('tool:call-1:tc:1');
    expect(call.openToolSpans.size).toBe(0);
  });

  it('VAI-09 a suffix never collides with a literal tool call id', () => {
    const tracker = new CallTracker(4);
    tracker.startRoot({ callId: 'call-1', ...root });
    const call = tracker.get('call-1')!;
    const spans = ['tc:1', 'tc', 'tc', 'tc'].map((id) => closeToolSpan(call, id));
    expect(spans).toEqual([
      'tool:call-1:tc:1',
      'tool:call-1:tc',
      'tool:call-1:tc:2',
      'tool:call-1:tc:3',
    ]);
  });
});
