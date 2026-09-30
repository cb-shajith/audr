import { describe, expect, it } from 'vitest';

import { decodeRecord, encodeRecord, parseRecord, ValidationError } from '../src/index.js';
import { makeRecord } from '../src/testing.js';

function issuesOf(call: () => unknown): [string, string][] {
  try {
    call();
  } catch (error) {
    if (error instanceof ValidationError) {
      return error.issues.map((found) => [found.code, found.path]);
    }
    throw error;
  }
  throw new Error('expected a ValidationError');
}

describe('parseRecord', () => {
  it('returns a copy of a valid record', () => {
    const record = makeRecord();
    const parsed = parseRecord(record);
    expect(parsed).toEqual(record);
    expect(parsed).not.toBe(record);
  });

  it('rejects a missing spec_version on that alone', () => {
    const { spec_version: _omitted, ...rest } = makeRecord();
    expect(issuesOf(() => parseRecord({ ...rest, resource: 'bad' }))).toEqual([
      ['REQUIRED', '/spec_version'],
    ]);
  });

  it('rejects an unsupported spec_version on that alone', () => {
    expect(issuesOf(() => parseRecord({ ...makeRecord(), spec_version: '2.0.0', run: 1 }))).toEqual(
      [['UNSUPPORTED_VERSION', '/spec_version']],
    );
  });

  it('carries every issue on the error', () => {
    const error = (() => {
      try {
        parseRecord({ ...makeRecord(), record_id: 'nope', attribution: {} });
      } catch (caught) {
        return caught;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).name).toBe('ValidationError');
    expect((error as ValidationError).message).toBe('1 issue(s): INVALID_IDENTIFIER at /record_id');
  });

  it('rejects a value that is not an object', () => {
    expect(issuesOf(() => parseRecord(42))).toEqual([['INVALID_TYPE', '/']]);
  });

  it('throws ValidationError for a value that throws while it is read', () => {
    const trapped = new Proxy(makeRecord(), {
      ownKeys: () => {
        throw new TypeError('trap');
      },
    });
    expect(issuesOf(() => parseRecord(trapped))).toEqual([['INVALID_TYPE', '/']]);
  });
});

describe('decodeRecord', () => {
  it('parses JSON text', () => {
    const record = makeRecord();
    expect(decodeRecord(JSON.stringify(record))).toEqual(record);
  });

  it('rejects text that is not JSON', () => {
    expect(issuesOf(() => decodeRecord('{'))).toEqual([['NOT_JSON', '/']]);
  });
});

describe('encodeRecord', () => {
  it('sorts keys at every level and drops undefined fields', () => {
    const record = { ...makeRecord(), corrects: undefined };
    const encoded = encodeRecord(record);
    expect(encoded).not.toContain('corrects');
    expect(Object.keys(JSON.parse(encoded) as object)).toEqual(
      Object.keys(record)
        .filter((key) => key !== 'corrects')
        .sort(),
    );
    expect(encoded).toContain('"resource":{"modality":"text","name":"test-model"');
  });

  it('is compact unless an indent is given', () => {
    const record = makeRecord();
    expect(encodeRecord(record)).not.toContain('\n');
    expect(encodeRecord(record, { indent: 2 })).toContain('\n  "attribution"');
  });

  it('round-trips through decodeRecord', () => {
    const record = makeRecord({ attribution: { environment: 'test', labels: { b: '2', a: '1' } } });
    expect(decodeRecord(encodeRecord(record))).toEqual(record);
  });

  it.each([Number.NaN, Infinity, -Infinity])('rejects %d, which JSON cannot hold', (value) => {
    const record = makeRecord({ usage: { llm: { input_tokens: value, requests: 1 } } });
    expect(issuesOf(() => encodeRecord(record))).toEqual([
      ['INVALID_TYPE', '/usage/llm/input_tokens'],
    ]);
  });

  it.each([
    ['an array', [3, 'x', { b: 1 }]],
    ['a Date', new Date()],
    ['a Map', new Map([['b', 1]])],
  ])('rejects %s, which no AUDR record holds', (_what, value) => {
    const record = { ...makeRecord(), x_extra: value };
    expect(issuesOf(() => encodeRecord(record))).toEqual([['INVALID_TYPE', '/x_extra']]);
  });

  it('encodes an object without a prototype', () => {
    const labels = Object.assign(Object.create(null) as Record<string, string>, { team: 'a' });
    const record = { ...makeRecord(), labels };
    expect(JSON.parse(encodeRecord(record))).toMatchObject({ labels: { team: 'a' } });
  });
});
