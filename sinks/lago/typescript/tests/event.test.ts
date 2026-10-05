import { describe, expect, it } from 'vitest';

import {
  createEvent,
  type EventFields,
  formatTimestamp,
  InvalidEventError,
  pointer,
} from '../src/event.js';

const FIELDS: EventFields = {
  transactionId: 'rec_1',
  subscriptionId: 'sub_1',
  code: 'tokens',
  eventTime: '2022-04-29T14:19:51.123Z',
  properties: { usage__llm__input_tokens: 1200, resource__name: 'claude' },
};

function reason(fields: Partial<EventFields>): string {
  try {
    createEvent({ ...FIELDS, ...fields });
  } catch (error) {
    if (error instanceof InvalidEventError) return error.message;
    throw error;
  }
  return 'accepted';
}

describe('formatTimestamp', () => {
  it.each([
    ['2022-04-29T14:19:51.123Z', '1651241991.123'],
    ['2022-04-29T16:19:51.123+02:00', '1651241991.123'],
    ['2026-10-05T08:00:00.005Z', '1791187200.005'],
    ['2026-10-05T08:00:00Z', '1791187200.000'],
    ['1970-01-01T00:00:00.000Z', '0.000'],
  ])('converts %s to Unix seconds %s', (eventTime, expected) => {
    expect(formatTimestamp(eventTime)).toBe(expected);
  });

  it('yields the same string for the same instant every time', () => {
    expect(formatTimestamp(FIELDS.eventTime)).toBe(formatTimestamp(FIELDS.eventTime));
  });

  it.each(['', 'yesterday', '2022-13-45T00:00:00Z', '1969-12-31T23:59:59.999Z'])(
    'rejects %j',
    (eventTime) => {
      expect(() => formatTimestamp(eventTime)).toThrow('invalid_timestamp');
    },
  );

  it('rejects a value that is not a string', () => {
    expect(() => formatTimestamp(1651241991123 as unknown as string)).toThrow('invalid_timestamp');
  });
});

describe('createEvent', () => {
  it('maps each field to its Lago name', () => {
    expect(createEvent(FIELDS)).toEqual({
      transaction_id: 'rec_1',
      external_subscription_id: 'sub_1',
      code: 'tokens',
      timestamp: '1651241991.123',
      properties: { usage__llm__input_tokens: 1200, resource__name: 'claude' },
    });
  });

  it('returns an event that cannot be changed, and does not alias the input', () => {
    const properties = { a: 1 };
    const event = createEvent({ ...FIELDS, properties });
    properties.a = 2;

    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.properties)).toBe(true);
    expect(event.properties).toEqual({ a: 1 });
  });

  it.each([undefined, '', '   '])('rejects the subscription %j as missing', (subscriptionId) => {
    expect(reason({ subscriptionId })).toBe('missing_subscription_id');
  });

  it('rejects a blank transaction identifier by pointer', () => {
    expect(reason({ transactionId: ' ' })).toBe('invalid_field:/record_id');
  });

  it('rejects an event without a metric code', () => {
    expect(reason({ code: undefined })).toBe('missing_metric_code');
  });

  it.each(['', '   ', ' tokens', 'tokens ', 'tokens\n', 42, null])(
    'rejects the metric code %j',
    (code) => {
      expect(reason({ code: code as unknown as string })).toBe('invalid_metric_code');
    },
  );

  it('rejects an invalid instant', () => {
    expect(reason({ eventTime: 'soon' })).toBe('invalid_timestamp');
  });

  it.each([
    ['not a number', { bad: Number.NaN }],
    ['infinite', { bad: Number.POSITIVE_INFINITY }],
    ['a boolean', { bad: true }],
    ['null', { bad: null }],
    ['an object', { bad: { nested: 1 } }],
    ['an array', { bad: [1] }],
    ['undefined', { bad: undefined }],
  ])('rejects a property value that is %s, naming only its path', (_name, properties) => {
    expect(reason({ properties: properties as unknown as EventFields['properties'] })).toBe(
      'unencodable_field:/properties/bad',
    );
  });

  it('rejects an empty property name', () => {
    expect(reason({ properties: { '': 1 } })).toBe('unencodable_field:/properties/');
  });

  it.each([null, [], 'text'])('rejects properties that are %j', (properties) => {
    expect(reason({ properties: properties as unknown as EventFields['properties'] })).toBe(
      'unencodable_field:/properties',
    );
  });

  it('accepts an event with no properties', () => {
    expect(reason({ properties: {} })).toBe('accepted');
  });
});

describe('pointer', () => {
  it('escapes the characters RFC 6901 reserves', () => {
    expect(pointer(['a/b', 'c~d'])).toBe('/a~1b/c~0d');
  });

  it('is empty for the whole document', () => {
    expect(pointer([])).toBe('');
  });
});
