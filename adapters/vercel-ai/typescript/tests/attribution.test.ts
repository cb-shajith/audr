import { describe, expect, it } from 'vitest';

import {
  type AttributionSource,
  mergeAttribution,
  readRuntimeAttribution,
  resolveAttribution,
} from '../src/attribution.js';

function source(runtimeContext: Record<string, unknown> = {}): AttributionSource {
  return { operationId: 'ai.generateText', functionId: undefined, runtimeContext };
}

describe('VAI-08 default runtimeContext reader', () => {
  it('VAI-08 keeps the string fields and string labels', () => {
    expect(
      readRuntimeAttribution(
        source({
          audr: {
            environment: 'production',
            user_id: 'u',
            account_id: 'a',
            subscription_id: 's',
            labels: { team: 'x' },
          },
        }),
      ),
    ).toEqual({
      environment: 'production',
      user_id: 'u',
      account_id: 'a',
      subscription_id: 's',
      labels: { team: 'x' },
    });
  });

  it('VAI-08 unknown fields are dropped', () => {
    expect(
      readRuntimeAttribution(
        source({ audr: { account_id: 42, environment: 'test', cost_center: 'x', email: 'e' } }),
      ),
    ).toEqual({ environment: 'test' });
  });

  it.each([
    ['labels with a non-string value', { labels: { a: 'x', b: 1 } }],
    ['labels as an array', { labels: ['x'] }],
    ['labels as a string', { labels: 'x' }],
  ])('VAI-08 drops %s', (_, audr) => {
    expect(readRuntimeAttribution(source({ audr }))).toEqual({});
  });

  it.each([undefined, null, 'acct', 42, ['a'], new Map()])(
    'VAI-08 no per-call attribution when audr is %s',
    (audr) => {
      expect(readRuntimeAttribution(source({ audr }))).toBeUndefined();
    },
  );

  it('VAI-08 accepts a null-prototype object', () => {
    const audr = Object.assign(Object.create(null) as object, { account_id: 'a' });
    expect(readRuntimeAttribution(source({ audr }))).toEqual({ account_id: 'a' });
  });
});

describe('VAI-08 merge', () => {
  it('VAI-08 per-call wins field by field', () => {
    expect(
      mergeAttribution(
        { environment: 'production', account_id: 'a', user_id: 'u' },
        { account_id: 'b' },
      ),
    ).toEqual({ environment: 'production', account_id: 'b', user_id: 'u' });
  });

  it('VAI-08 labels merge by key', () => {
    expect(
      mergeAttribution(
        { environment: 'test', labels: { team: 'a', region: 'eu' } },
        { labels: { team: 'b' } },
      ),
    ).toEqual({ environment: 'test', labels: { team: 'b', region: 'eu' } });
  });

  it('VAI-08 undefined fields do not erase defaults', () => {
    expect(
      mergeAttribution({ environment: 'test', account_id: 'a' }, { account_id: undefined }),
    ).toEqual({ environment: 'test', account_id: 'a' });
  });

  it('VAI-08 nothing on either side is empty', () => {
    expect(mergeAttribution(undefined, undefined)).toEqual({});
  });
});

describe('VAI-08 resolution', () => {
  it('VAI-08 defaults only', () => {
    expect(resolveAttribution(source(), { environment: 'test' })).toEqual({
      kind: 'resolved',
      attribution: { environment: 'test' },
    });
  });

  it('VAI-08 per-call only', () => {
    expect(resolveAttribution(source({ audr: { environment: 'staging' } }), undefined)).toEqual({
      kind: 'resolved',
      attribution: { environment: 'staging' },
    });
  });

  it('VAI-08 nothing resolves', () => {
    expect(resolveAttribution(source(), { account_id: 'a' })).toEqual({
      kind: 'unresolved',
    });
  });

  it('VAI-08 a non-object audr value leaves the defaults', () => {
    expect(resolveAttribution(source({ audr: 'acct' }), { environment: 'test' })).toEqual({
      kind: 'resolved',
      attribution: { environment: 'test' },
    });
  });
});
