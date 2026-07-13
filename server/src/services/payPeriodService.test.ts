import { describe, expect, it } from 'vitest';
import { canFinalizeWeek, canonicalJson, snapshotHash, weekBoundsForDate } from './payPeriodService.js';

describe('weekBoundsForDate', () => {
  it.each([
    ['2026-07-12', '2026-07-12', '2026-07-18'],
    ['2026-07-13', '2026-07-12', '2026-07-18'],
    ['2026-07-18', '2026-07-12', '2026-07-18'],
    ['2026-07-19', '2026-07-19', '2026-07-25'],
    ['2026-03-08', '2026-03-08', '2026-03-14'],
    ['2026-11-01', '2026-11-01', '2026-11-07'],
  ])('%s maps to Sunday %s through Saturday %s', (date, weekStart, weekEnd) => {
    expect(weekBoundsForDate(date)).toEqual({ weekStart, weekEnd });
  });

  it('rejects malformed and impossible dates', () => {
    expect(() => weekBoundsForDate('07/12/2026')).toThrow();
    expect(() => weekBoundsForDate('2026-02-30')).toThrow();
  });
});

describe('snapshot hashing', () => {
  it('sorts object keys recursively but preserves array order', () => {
    const left = { z: 1, nested: { b: 2, a: 1 }, list: [{ y: 2, x: 1 }, 3] };
    const right = { list: [{ x: 1, y: 2 }, 3], nested: { a: 1, b: 2 }, z: 1 };
    expect(canonicalJson(left)).toBe(canonicalJson(right));
    expect(snapshotHash(left)).toBe(snapshotHash(right));
    expect(snapshotHash({ ...right, list: [3, { x: 1, y: 2 }] })).not.toBe(snapshotHash(left));
  });

  it('produces a lowercase SHA-256 hash', () => {
    expect(snapshotHash({ hours: 40 })).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('finalization timing', () => {
  it('does not finalize before Saturday closes in Los Angeles', () => {
    expect(canFinalizeWeek('2026-07-18', new Date('2026-07-19T06:59:59Z'))).toBe(false);
  });

  it('allows finalization at Sunday midnight in Los Angeles', () => {
    expect(canFinalizeWeek('2026-07-18', new Date('2026-07-19T07:00:00Z'))).toBe(true);
  });
});
