import { describe, expect, it } from 'vitest';

import {
  classifyStatus,
  exceedsBatchLimit,
  parseValidationErrors,
  type StatusClass,
} from '../src/response.js';

describe('classifyStatus', () => {
  it.each<[number, StatusClass]>([
    [200, 'accepted'],
    [422, 'invalid'],
    [401, 'credential'],
    [403, 'forbidden'],
    [413, 'too_large'],
    [408, 'transient'],
    [429, 'transient'],
    [500, 'transient'],
    [502, 'transient'],
    [503, 'transient'],
    [504, 'transient'],
    [599, 'transient'],
    [400, 'permanent'],
    [404, 'permanent'],
    [409, 'permanent'],
    [301, 'permanent'],
    [302, 'permanent'],
    [307, 'permanent'],
    [201, 'unconfirmed'],
    [202, 'unconfirmed'],
    [204, 'unconfirmed'],
    [299, 'unconfirmed'],
    [300, 'permanent'],
    [100, 'permanent'],
    [600, 'permanent'],
  ])('maps %i to %s', (status, expected) => {
    expect(classifyStatus(status)).toBe(expected);
  });
});

const body = (details: unknown): unknown => ({ status: 422, error_details: details });
const duplicate = { transaction_id: ['value_already_exist'] };

describe('parseValidationErrors', () => {
  it('reads a sole value_already_exist on transaction_id as a duplicate', () => {
    expect(parseValidationErrors(body({ 1: duplicate, 0: duplicate }), 3)).toEqual({
      duplicates: [0, 1],
      invalid: [],
    });
  });

  it.each([
    [{ timestamp: ['invalid_format'] }, 'timestamp:invalid_format'],
    [{ code: ['value_is_mandatory'] }, 'code:value_is_mandatory'],
    [
      { external_subscription_id: ['value_is_mandatory'] },
      'external_subscription_id:value_is_mandatory',
    ],
    [{ properties: ['invalid_format'] }, 'properties:invalid_format'],
    [{ code: ['value_already_exist'] }, 'code:value_already_exist'],
  ])('rejects an event refused with %j as %s', (errors, detail) => {
    expect(parseValidationErrors(body({ 2: errors }), 3)).toEqual({
      duplicates: [],
      invalid: [{ index: 2, detail }],
    });
  });

  it('rejects an event that is both a duplicate and invalid, naming the other error', () => {
    const errors = { transaction_id: ['value_already_exist'], timestamp: ['invalid_format'] };

    expect(parseValidationErrors(body({ 0: errors }), 1)).toEqual({
      duplicates: [],
      invalid: [{ index: 0, detail: 'timestamp:invalid_format' }],
    });
  });

  it('treats several duplicate codes on transaction_id as one duplicate', () => {
    expect(
      parseValidationErrors(
        body({ 0: { transaction_id: ['value_already_exist', 'value_already_exist'] } }),
        1,
      ),
    ).toEqual({ duplicates: [0], invalid: [] });
  });

  it('separates duplicates from invalid events in one response, in request order', () => {
    const verdict = parseValidationErrors(
      body({
        4: { timestamp: ['invalid_format'] },
        1: duplicate,
        2: { code: ['value_is_mandatory'] },
      }),
      5,
    );

    expect(verdict).toEqual({
      duplicates: [1],
      invalid: [
        { index: 2, detail: 'code:value_is_mandatory' },
        { index: 4, detail: 'timestamp:invalid_format' },
      ],
    });
  });

  it('never echoes a field or code that is not on the allowlist', () => {
    const verdict = parseValidationErrors(
      body({ 0: { 'sk-live-secret': ['leaked message from Lago'] } }),
      1,
    );

    expect(verdict).toEqual({
      duplicates: [],
      invalid: [{ index: 0, detail: 'event:validation_error' }],
    });
  });

  it('rejects an event named by a message, which it never echoes', () => {
    const message = 'expression_evaluation_failed: Variable: sk-live-secret not found';

    expect(parseValidationErrors(body({ 1: message, 0: duplicate }), 3)).toEqual({
      duplicates: [0],
      invalid: [{ index: 1, detail: 'event:expression_evaluation_failed' }],
    });
  });

  it('rejects an event named by an empty message', () => {
    expect(parseValidationErrors(body({ 0: '' }), 1)).toEqual({
      duplicates: [],
      invalid: [{ index: 0, detail: 'event:expression_evaluation_failed' }],
    });
  });

  it('accepts the first and the last position of the request', () => {
    expect(parseValidationErrors(body({ 0: duplicate, 99: duplicate }), 100)).toEqual({
      duplicates: [0, 99],
      invalid: [],
    });
  });

  it.each([
    ['a position equal to the event count', { 3: duplicate }],
    ['a position beyond the event count', { 40: duplicate }],
    ['a negative position', { '-1': duplicate }],
    ['a non-numeric position', { first: duplicate }],
    ['a fractional position', { '1.5': duplicate }],
    ['a position with a leading zero', { '01': duplicate }],
    ['a position written in exponent form', { '1e0': duplicate }],
    ['a position of mixed digits and text', { '1a': duplicate }],
    ['a huge position', { ['9'.repeat(40)]: duplicate }],
    ['a valid position beside a bad one', { 0: duplicate, bad: duplicate }],
    ['an entry that is a number', { 0: 42 }],
    ['an entry that is null', { 0: null }],
    ['an entry that is an array', { 0: ['value_already_exist'] }],
    ['a message at a position beyond the event count', { 3: 'expression failed' }],
    ['an entry that is empty', { 0: {} }],
    ['a field whose errors are not an array', { 0: { transaction_id: 'value_already_exist' } }],
    ['a field with no errors', { 0: { transaction_id: [] } }],
    ['an error that is not a string', { 0: { transaction_id: [42] } }],
    ['no entries', {}],
  ])('cannot be trusted with %s', (_name, details) => {
    expect(parseValidationErrors(body(details), 3)).toBeUndefined();
  });

  it.each([
    ['a body that is not an object', 'oops'],
    ['a null body', null],
    ['an array body', []],
    ['a body without error_details', { status: 422 }],
    ['error_details as a string', { error_details: 'bad' }],
    ['error_details as an array', { error_details: [duplicate] }],
    ['error_details as null', { error_details: null }],
  ])('cannot be trusted with %s', (_name, payload) => {
    expect(parseValidationErrors(payload, 3)).toBeUndefined();
  });
});

describe('exceedsBatchLimit', () => {
  it('recognises the refusal of a request above the instance limit', () => {
    expect(exceedsBatchLimit(body({ events: ['too_many_events'] }))).toBe(true);
  });

  it.each([
    ['another refusal of the whole request', body({ events: ['no_events'] })],
    ['refusals by position', body({ 0: { timestamp: ['invalid_format'] } })],
    ['events errors that are not an array', body({ events: 'too_many_events' })],
    ['error_details that are not an object', body('too_many_events')],
    ['a body that is not an object', 'too_many_events'],
    ['no body', undefined],
  ])('does not recognise %s', (_name, payload) => {
    expect(exceedsBatchLimit(payload)).toBe(false);
  });
});
