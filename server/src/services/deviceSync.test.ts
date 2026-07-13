import { describe, expect, it } from 'vitest';
import {
  CAPTURE_MAX_FUTURE_MS,
  deviceEventMatches,
  normalizeCapturedAt,
  normalizeCapturedAtSnapshot,
  OFFLINE_MAX_AGE_MS,
  sortDeviceEvents,
  validateCapturedAt,
} from './deviceSync.js';

const NOW = new Date('2026-07-14T12:00:00.000Z');

describe('validateCapturedAt', () => {
  it('accepts the exact future boundary', () => {
    const captured = new Date(NOW.getTime() + CAPTURE_MAX_FUTURE_MS).toISOString();
    expect(validateCapturedAt(captured, NOW)).toEqual({ ok: true, date: new Date(captured) });
  });

  it('rejects more than five minutes in the future', () => {
    const captured = new Date(NOW.getTime() + CAPTURE_MAX_FUTURE_MS + 1).toISOString();
    expect(validateCapturedAt(captured, NOW)).toMatchObject({
      ok: false,
      code: 'captured_in_future',
    });
  });

  it('accepts the exact fourteen-day age boundary', () => {
    const captured = new Date(NOW.getTime() - OFFLINE_MAX_AGE_MS).toISOString();
    expect(validateCapturedAt(captured, NOW)).toEqual({ ok: true, date: new Date(captured) });
  });

  it('rejects an event older than fourteen days', () => {
    const captured = new Date(NOW.getTime() - OFFLINE_MAX_AGE_MS - 1).toISOString();
    expect(validateCapturedAt(captured, NOW)).toMatchObject({
      ok: false,
      code: 'captured_too_old',
    });
  });
});

describe('sortDeviceEvents', () => {
  it('sorts by positive client sequence and is stable on ties', () => {
    const events = [
      { client_event_id: 'third', client_installation_id: 'install', client_sequence: 3, captured_at: NOW.toISOString() },
      { client_event_id: 'first-a', client_installation_id: 'install', client_sequence: 1, captured_at: NOW.toISOString() },
      { client_event_id: 'first-b', client_installation_id: 'install', client_sequence: 1, captured_at: NOW.toISOString() },
      { client_event_id: 'second', client_installation_id: 'install', client_sequence: 2, captured_at: NOW.toISOString() },
    ];
    expect(sortDeviceEvents(events).map((event) => event.client_event_id)).toEqual([
      'first-a',
      'first-b',
      'second',
      'third',
    ]);
    expect(events[0]?.client_event_id).toBe('third');
  });
});

describe('normalizeCapturedAt', () => {
  it('subtracts a fast tablet clock and adds a slow tablet clock', () => {
    expect(normalizeCapturedAt('2026-07-14T14:00:00.000Z', 7200).toISOString()).toBe(
      '2026-07-14T12:00:00.000Z'
    );
    expect(normalizeCapturedAt('2026-07-14T10:00:00.000Z', -7200).toISOString()).toBe(
      '2026-07-14T12:00:00.000Z'
    );
  });

  it('uses the event snapshot and preserves raw time when it is unavailable', () => {
    const captured = '2026-07-14T14:00:00.000Z';
    const eventSnapshot = 7200;
    const deviceSkewChangedBeforeSync = -3600;
    expect(normalizeCapturedAtSnapshot(captured, eventSnapshot).toISOString()).toBe(
      '2026-07-14T12:00:00.000Z'
    );
    expect(deviceSkewChangedBeforeSync).not.toBe(eventSnapshot);
    expect(normalizeCapturedAtSnapshot(captured, null).toISOString()).toBe(captured);
  });
});

describe('deviceEventMatches', () => {
  const persisted = {
    employee_number: 42,
    punch_type: 'shift_in',
    captured_at: new Date('2026-07-14T05:00:00-07:00'),
    client_sequence: '18',
    client_installation_id: '11111111-1111-4111-8111-111111111111',
    evidence_status: 'captured',
    client_clock_skew_seconds: 7200,
  };
  const client = {
    client_event_id: 'event',
    employee_number: 42,
    punch_type: 'shift_in',
    captured_at: '2026-07-14T12:00:00.000Z',
    client_sequence: 18,
    client_installation_id: '11111111-1111-4111-8111-111111111111',
    evidence_status: 'captured',
    client_clock_skew_seconds: 7200,
  };

  it('matches the same immutable payload across equivalent ISO offsets', () => {
    expect(deviceEventMatches(persisted, client)).toBe(true);
  });

  it.each([
    ['employee_number', 43],
    ['punch_type', 'shift_out'],
    ['captured_at', '2026-07-14T12:00:00.001Z'],
    ['client_sequence', 19],
    ['client_installation_id', '22222222-2222-4222-8222-222222222222'],
    ['evidence_status', 'camera_unavailable'],
    ['client_clock_skew_seconds', null],
  ])('rejects a reused UUID when %s differs', (field, value) => {
    expect(deviceEventMatches(persisted, { ...client, [field]: value })).toBe(false);
  });
});
