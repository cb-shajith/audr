import { describe, expect, it } from 'vitest';

import { BoundedMap, closeToolSpan, openToolSpan, RunTracker } from '../src/runs.js';

const root = {
  operationId: 'ai.generateText',
  attribution: { environment: 'test' as const },
  runType: 'agent_run' as const,
  name: 'agent',
};

describe('VAI-11 bounded state', () => {
  it('VAI-11 evicts oldest first and reports the count', () => {
    const map = new BoundedMap<number>(2);
    expect(map.set('a', 1)).toBe(0);
    expect(map.set('b', 2)).toBe(0);
    expect(map.set('c', 3)).toBe(1);
    expect(map.get('a')).toBeUndefined();
    expect(map.get('b')).toBe(2);
    expect(map.size).toBe(2);
  });

  it('VAI-11 re-setting a key refreshes its position', () => {
    const map = new BoundedMap<number>(2);
    map.set('a', 1);
    map.set('b', 2);
    map.set('a', 3);
    map.set('c', 4);
    expect(map.get('a')).toBe(3);
    expect(map.get('b')).toBeUndefined();
  });

  it('VAI-11 take removes and returns', () => {
    const map = new BoundedMap<number>(2);
    map.set('a', 1);
    expect(map.take('a')).toBe(1);
    expect(map.take('a')).toBeUndefined();
    expect(map.size).toBe(0);
  });

  it('VAI-11 an evicted run stays gone', () => {
    const runs = new RunTracker(1);
    runs.beginRoot({ callId: 'call-1', ...root });
    expect(runs.beginRoot({ callId: 'call-2', ...root })).toBe(1);
    expect(runs.get('call-1')).toBeUndefined();
    expect(runs.get('call-2')).toBeDefined();
  });

  it('VAI-11 end is idempotent', () => {
    const runs = new RunTracker(4);
    runs.beginRoot({ callId: 'call-1', ...root });
    runs.end('call-1');
    runs.end('call-1');
    runs.end('never-started');
    expect(runs.get('call-1')).toBeUndefined();
  });
});

describe('VAI-10 run state', () => {
  it('VAI-10 a root run is its own run with a fresh counter', () => {
    const runs = new RunTracker(4);
    runs.beginRoot({ callId: 'call-1', ...root });
    expect(runs.get('call-1')).toEqual({
      runId: 'call-1',
      operationId: 'ai.generateText',
      parentSpanId: undefined,
      attribution: { environment: 'test' },
      runType: 'agent_run',
      name: 'agent',
      counter: { next: 0 },
      modelCalls: 0,
      rerankCalls: 0,
      toolSpans: new Set(),
      openTools: new Map(),
      embedStarts: new Map(),
      rerankStartedAt: undefined,
    });
  });

  it('VAI-10 a spawned run joins its parent and shares the step counter', () => {
    const runs = new RunTracker(4);
    runs.beginRoot({ callId: 'call-1', ...root });
    const parent = runs.get('call-1')!;
    parent.modelCalls = 3;
    runs.beginSpawned('call-2', 'ai.embed', { run: parent, spanId: 'tool:call-1:tc' });
    const child = runs.get('call-2')!;
    expect(child).toMatchObject({
      runId: 'call-1',
      operationId: 'ai.embed',
      parentSpanId: 'tool:call-1:tc',
      attribution: parent.attribution,
      runType: 'agent_run',
      name: 'agent',
      modelCalls: 0,
    });
    expect(child.counter).toBe(parent.counter);
    expect(child.toolSpans).not.toBe(parent.toolSpans);
    expect(child.embedStarts).not.toBe(parent.embedStarts);
  });

  it('VAI-10 the spawn context is scoped to its callback', async () => {
    const runs = new RunTracker(4);
    runs.beginRoot({ callId: 'call-1', ...root });
    const context = { run: runs.get('call-1')!, spanId: 'tool:call-1:tc' };
    expect(runs.spawningSpan()).toBeUndefined();
    await runs.runInSpan(context, async () => {
      await Promise.resolve();
      expect(runs.spawningSpan()).toBe(context);
    });
    expect(runs.spawningSpan()).toBeUndefined();
  });

  it('VAI-10 the spawn context belongs to its tracker', async () => {
    const mine = new RunTracker(4);
    const other = new RunTracker(4);
    mine.beginRoot({ callId: 'call-1', ...root });
    await mine.runInSpan({ run: mine.get('call-1')!, spanId: 'tool:call-1:tc' }, async () => {
      await Promise.resolve();
      expect(other.spawningSpan()).toBeUndefined();
    });
  });
});

describe('VAI-09 tool spans', () => {
  it('VAI-09 a reused tool call id gets a suffixed span', () => {
    const runs = new RunTracker(4);
    runs.beginRoot({ callId: 'call-1', ...root });
    const run = runs.get('call-1')!;
    expect(openToolSpan(run, 'call-1', 'tc')).toBe('tool:call-1:tc');
    expect(closeToolSpan(run, 'call-1', 'tc')).toBe('tool:call-1:tc');
    expect(openToolSpan(run, 'call-1', 'tc')).toBe('tool:call-1:tc:1');
    expect(closeToolSpan(run, 'call-1', 'tc')).toBe('tool:call-1:tc:1');
    expect(run.openTools.size).toBe(0);
  });

  it('VAI-09 a suffix never collides with a literal tool call id', () => {
    const runs = new RunTracker(4);
    runs.beginRoot({ callId: 'call-1', ...root });
    const run = runs.get('call-1')!;
    const spans = ['tc:1', 'tc', 'tc', 'tc'].map((id) => closeToolSpan(run, 'call-1', id));
    expect(spans).toEqual([
      'tool:call-1:tc:1',
      'tool:call-1:tc',
      'tool:call-1:tc:2',
      'tool:call-1:tc:3',
    ]);
  });
});
