import { describe, expect, it } from 'vitest';
import type { CaliforniaWorkChunk } from './californiaOvertime.js';
import {
  CALIFORNIA_WORKDAY_TIMEZONE,
  buildWorkSegments,
  type WorkSegmentPunch,
} from './workSegments.js';

const HOUR = 3_600;

function punch(
  id: string,
  type: WorkSegmentPunch['type'],
  time: string,
  plantId = 'plant-a',
): WorkSegmentPunch {
  return { id, type, time, plantId };
}

function issueTypes(input: WorkSegmentPunch[]) {
  return buildWorkSegments(input).issues.map((entry) => entry.type);
}

describe('buildWorkSegments — valid work and meals', () => {
  it('01 builds one exact clock chunk from a simple cycle', () => {
    const result = buildWorkSegments([
      punch('in', 'shift_in', '2026-07-06T05:00:00-07:00'),
      punch('out', 'shift_out', '2026-07-06T13:30:00-07:00'),
    ]);

    expect(result.totalWorkedSeconds).toBe(8.5 * HOUR);
    expect(result.issues).toEqual([]);
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]).toMatchObject({
      workDate: '2026-07-06',
      durationSeconds: 8.5 * HOUR,
      plantId: 'plant-a',
      source: 'clock',
      order: 0,
    });
  });

  it('02 subtracts one unpaid meal exactly', () => {
    const result = buildWorkSegments([
      punch('in', 'shift_in', '2026-07-06T05:00:00-07:00'),
      punch('meal-out', 'meal_out', '2026-07-06T09:00:00-07:00'),
      punch('meal-in', 'meal_in', '2026-07-06T09:30:00-07:00'),
      punch('out', 'shift_out', '2026-07-06T13:30:00-07:00'),
    ]);

    expect(result.totalWorkedSeconds).toBe(8 * HOUR);
    expect(result.chunks.map((chunk) => chunk.durationSeconds)).toEqual([4 * HOUR, 4 * HOUR]);
    expect(result.issues).toEqual([]);
  });

  it('03 supports multiple meals in the same shift', () => {
    const result = buildWorkSegments([
      punch('in', 'shift_in', '2026-07-06T05:00:00-07:00'),
      punch('m1o', 'meal_out', '2026-07-06T07:00:00-07:00'),
      punch('m1i', 'meal_in', '2026-07-06T07:15:00-07:00'),
      punch('m2o', 'meal_out', '2026-07-06T09:00:00-07:00'),
      punch('m2i', 'meal_in', '2026-07-06T09:30:00-07:00'),
      punch('out', 'shift_out', '2026-07-06T13:00:00-07:00'),
    ]);

    expect(result.totalWorkedSeconds).toBe(7.25 * HOUR);
    expect(result.chunks.map((chunk) => chunk.durationSeconds)).toEqual([2 * HOUR, 1.75 * HOUR, 3.5 * HOUR]);
  });

  it('04 supports multiple shift cycles on one workday', () => {
    const result = buildWorkSegments([
      punch('in-1', 'shift_in', '2026-07-06T05:00:00-07:00'),
      punch('out-1', 'shift_out', '2026-07-06T09:00:00-07:00'),
      punch('in-2', 'shift_in', '2026-07-06T10:00:00-07:00'),
      punch('out-2', 'shift_out', '2026-07-06T14:00:00-07:00'),
    ]);

    expect(result.totalWorkedSeconds).toBe(8 * HOUR);
    expect(result.chunks).toHaveLength(2);
    expect(result.chunks.map((chunk) => chunk.order)).toEqual([0, 1]);
  });

  it('05 preserves whole-second precision and deterministically truncates milliseconds', () => {
    const result = buildWorkSegments([
      punch('in', 'shift_in', '2026-07-06T05:00:00.900-07:00'),
      punch('out', 'shift_out', '2026-07-06T05:01:01.100-07:00'),
    ]);

    expect(result.totalWorkedSeconds).toBe(61);
    expect(result.chunks[0]!.start).toBe('2026-07-06T12:00:00.000Z');
    expect(result.chunks[0]!.end).toBe('2026-07-06T12:01:01.000Z');
  });

  it('06 is structurally assignable to CaliforniaWorkChunk', () => {
    const result = buildWorkSegments([
      punch('in', 'shift_in', '2026-07-06T05:00:00-07:00'),
      punch('out', 'shift_out', '2026-07-06T06:00:00-07:00'),
    ]);
    const californiaChunks: CaliforniaWorkChunk[] = result.chunks;

    expect(californiaChunks[0]).toMatchObject({ source: 'clock', durationSeconds: HOUR, workDate: '2026-07-06' });
  });
});

describe('buildWorkSegments — California workday boundaries and DST', () => {
  it('07 splits a shift crossing local midnight into two workdays', () => {
    const result = buildWorkSegments([
      punch('in', 'shift_in', '2026-07-05T23:00:00-07:00'),
      punch('out', 'shift_out', '2026-07-06T02:00:00-07:00'),
    ]);

    expect(result.chunks.map((chunk) => [chunk.workDate, chunk.durationSeconds])).toEqual([
      ['2026-07-05', HOUR],
      ['2026-07-06', 2 * HOUR],
    ]);
  });

  it('08 splits a multi-day shift at every local midnight', () => {
    const result = buildWorkSegments([
      punch('in', 'shift_in', '2026-07-05T23:00:00-07:00'),
      punch('out', 'shift_out', '2026-07-07T01:00:00-07:00'),
    ]);

    expect(result.chunks.map((chunk) => [chunk.workDate, chunk.durationSeconds])).toEqual([
      ['2026-07-05', HOUR],
      ['2026-07-06', 24 * HOUR],
      ['2026-07-07', HOUR],
    ]);
  });

  it('09 uses elapsed time through the spring-forward transition', () => {
    const result = buildWorkSegments([
      punch('in', 'shift_in', '2026-03-08T00:00:00-08:00'),
      punch('out', 'shift_out', '2026-03-08T04:00:00-07:00'),
    ]);

    expect(result.totalWorkedSeconds).toBe(3 * HOUR);
    expect(result.chunks[0]!.workDate).toBe('2026-03-08');
  });

  it('10 splits correctly across spring-forward midnight', () => {
    const result = buildWorkSegments([
      punch('in', 'shift_in', '2026-03-07T23:00:00-08:00'),
      punch('out', 'shift_out', '2026-03-08T04:00:00-07:00'),
    ]);

    expect(result.chunks.map((chunk) => [chunk.workDate, chunk.durationSeconds])).toEqual([
      ['2026-03-07', HOUR],
      ['2026-03-08', 3 * HOUR],
    ]);
  });

  it('11 keeps the repeated fall-back hour as elapsed work', () => {
    const result = buildWorkSegments([
      punch('in', 'shift_in', '2026-11-01T00:00:00-07:00'),
      punch('out', 'shift_out', '2026-11-01T04:00:00-08:00'),
    ]);

    expect(result.totalWorkedSeconds).toBe(5 * HOUR);
    expect(result.chunks[0]!.workDate).toBe('2026-11-01');
    expect(CALIFORNIA_WORKDAY_TIMEZONE).toBe('America/Los_Angeles');
  });

  it('12 subtracts a meal that crosses midnight and emits no meal chunk', () => {
    const result = buildWorkSegments([
      punch('in', 'shift_in', '2026-07-05T22:00:00-07:00'),
      punch('meal-out', 'meal_out', '2026-07-05T23:30:00-07:00'),
      punch('meal-in', 'meal_in', '2026-07-06T00:30:00-07:00'),
      punch('out', 'shift_out', '2026-07-06T02:00:00-07:00'),
    ]);

    expect(result.totalWorkedSeconds).toBe(3 * HOUR);
    expect(result.chunks.map((chunk) => [chunk.workDate, chunk.durationSeconds])).toEqual([
      ['2026-07-05', 1.5 * HOUR],
      ['2026-07-06', 1.5 * HOUR],
    ]);
  });
});

describe('buildWorkSegments — blocking sequence and missing-punch issues', () => {
  it('13 reports an orphan shift_out', () => {
    const input = [punch('out', 'shift_out', '2026-07-06T13:30:00-07:00')];
    expect(issueTypes(input)).toEqual(['out_of_sequence']);
    expect(buildWorkSegments(input).chunks).toEqual([]);
  });

  it('14 reports meal_out while outside a shift', () => {
    expect(issueTypes([punch('meal', 'meal_out', '2026-07-06T09:00:00-07:00')])).toEqual([
      'out_of_sequence',
    ]);
  });

  it('15 reports meal_in without meal_out', () => {
    const result = buildWorkSegments([
      punch('in', 'shift_in', '2026-07-06T05:00:00-07:00'),
      punch('meal-in', 'meal_in', '2026-07-06T09:30:00-07:00'),
      punch('out', 'shift_out', '2026-07-06T13:30:00-07:00'),
    ]);

    expect(result.issues.map((entry) => entry.type)).toEqual(['out_of_sequence']);
    expect(result.totalWorkedSeconds).toBe(8.5 * HOUR);
  });

  it('16 reports a repeated shift_in and retains the original open cycle', () => {
    const result = buildWorkSegments([
      punch('in-1', 'shift_in', '2026-07-06T05:00:00-07:00'),
      punch('in-2', 'shift_in', '2026-07-06T06:00:00-07:00'),
      punch('out', 'shift_out', '2026-07-06T13:00:00-07:00'),
    ]);

    expect(result.issues.map((entry) => entry.type)).toEqual(['out_of_sequence']);
    expect(result.totalWorkedSeconds).toBe(8 * HOUR);
  });

  it('17 reports missing shift_out without inventing an end time', () => {
    const result = buildWorkSegments([punch('in', 'shift_in', '2026-07-06T05:00:00-07:00')]);

    expect(result.issues.map((entry) => entry.type)).toEqual(['missing_shift_out']);
    expect(result.totalWorkedSeconds).toBe(0);
    expect(result.hasBlockingIssues).toBe(true);
  });

  it('18 preserves known pre-meal work and reports both missing punches at end of input', () => {
    const result = buildWorkSegments([
      punch('in', 'shift_in', '2026-07-06T05:00:00-07:00'),
      punch('meal-out', 'meal_out', '2026-07-06T09:00:00-07:00'),
    ]);

    expect(result.totalWorkedSeconds).toBe(4 * HOUR);
    expect(result.issues.map((entry) => entry.type)).toEqual(['missing_meal_in', 'missing_shift_out']);
  });

  it('19 closes a shift_out during meal but reports missing meal_in', () => {
    const result = buildWorkSegments([
      punch('in', 'shift_in', '2026-07-06T05:00:00-07:00'),
      punch('meal-out', 'meal_out', '2026-07-06T09:00:00-07:00'),
      punch('out', 'shift_out', '2026-07-06T13:30:00-07:00'),
    ]);

    expect(result.totalWorkedSeconds).toBe(4 * HOUR);
    expect(result.issues.map((entry) => entry.type)).toEqual(['missing_meal_in']);
  });

  it('20 flags non-chronological input and still derives the sorted unambiguous interval', () => {
    const result = buildWorkSegments([
      punch('out', 'shift_out', '2026-07-06T13:00:00-07:00'),
      punch('in', 'shift_in', '2026-07-06T05:00:00-07:00'),
    ]);

    expect(result.issues.map((entry) => entry.type)).toEqual(['out_of_sequence']);
    expect(result.totalWorkedSeconds).toBe(8 * HOUR);
  });

  it('21 treats a zero-second in/out pair as blocking instead of fabricating time', () => {
    const result = buildWorkSegments([
      punch('in', 'shift_in', '2026-07-06T05:00:00.100-07:00'),
      punch('out', 'shift_out', '2026-07-06T05:00:00.900-07:00'),
    ]);

    expect(result.totalWorkedSeconds).toBe(0);
    expect(result.issues.map((entry) => entry.type)).toEqual(['out_of_sequence']);
  });
});

describe('buildWorkSegments — plants and overlaps', () => {
  it('22 accepts sequential cycles at different plants', () => {
    const result = buildWorkSegments([
      punch('a-in', 'shift_in', '2026-07-06T05:00:00-07:00', 'plant-a'),
      punch('a-out', 'shift_out', '2026-07-06T09:00:00-07:00', 'plant-a'),
      punch('b-in', 'shift_in', '2026-07-06T10:00:00-07:00', 'plant-b'),
      punch('b-out', 'shift_out', '2026-07-06T14:00:00-07:00', 'plant-b'),
    ]);

    expect(result.issues).toEqual([]);
    expect(result.totalWorkedSeconds).toBe(8 * HOUR);
    expect(result.chunks.map((chunk) => chunk.plantId)).toEqual(['plant-a', 'plant-b']);
  });

  it('23 reports an exact overlap between different plants', () => {
    const result = buildWorkSegments([
      punch('a-in', 'shift_in', '2026-07-06T05:00:00-07:00', 'plant-a'),
      punch('b-in', 'shift_in', '2026-07-06T06:00:00-07:00', 'plant-b'),
      punch('a-out', 'shift_out', '2026-07-06T08:00:00-07:00', 'plant-a'),
      punch('b-out', 'shift_out', '2026-07-06T09:00:00-07:00', 'plant-b'),
    ]);

    const overlap = result.issues.find((entry) => entry.type === 'overlap_between_plants');
    expect(overlap).toMatchObject({
      blocking: true,
      plantIds: ['plant-a', 'plant-b'],
      overlapSeconds: 2 * HOUR,
      start: '2026-07-06T13:00:00.000Z',
      end: '2026-07-06T15:00:00.000Z',
    });
  });

  it('24 does not consider touching plant intervals an overlap', () => {
    const result = buildWorkSegments([
      punch('a-in', 'shift_in', '2026-07-06T05:00:00-07:00', 'plant-a'),
      punch('a-out', 'shift_out', '2026-07-06T09:00:00-07:00', 'plant-a'),
      punch('b-in', 'shift_in', '2026-07-06T09:00:00-07:00', 'plant-b'),
      punch('b-out', 'shift_out', '2026-07-06T13:00:00-07:00', 'plant-b'),
    ]);

    expect(result.issues).toEqual([]);
  });

  it('25 excludes a meal from cross-plant overlap detection', () => {
    const result = buildWorkSegments([
      punch('a-in', 'shift_in', '2026-07-06T05:00:00-07:00', 'plant-a'),
      punch('a-meal-out', 'meal_out', '2026-07-06T06:00:00-07:00', 'plant-a'),
      punch('b-in', 'shift_in', '2026-07-06T06:00:00-07:00', 'plant-b'),
      punch('b-out', 'shift_out', '2026-07-06T07:00:00-07:00', 'plant-b'),
      punch('a-meal-in', 'meal_in', '2026-07-06T07:00:00-07:00', 'plant-a'),
      punch('a-out', 'shift_out', '2026-07-06T09:00:00-07:00', 'plant-a'),
    ]);

    expect(result.issues).toEqual([]);
    expect(result.totalWorkedSeconds).toBe(4 * HOUR);
  });

  it('26 detects an overlap that crosses local midnight', () => {
    const result = buildWorkSegments([
      punch('a-in', 'shift_in', '2026-07-05T23:00:00-07:00', 'plant-a'),
      punch('b-in', 'shift_in', '2026-07-05T23:30:00-07:00', 'plant-b'),
      punch('a-out', 'shift_out', '2026-07-06T00:30:00-07:00', 'plant-a'),
      punch('b-out', 'shift_out', '2026-07-06T01:00:00-07:00', 'plant-b'),
    ]);

    const overlap = result.issues.find((entry) => entry.type === 'overlap_between_plants');
    expect(overlap?.overlapSeconds).toBe(HOUR);
    expect(result.chunks.map((chunk) => chunk.workDate)).toEqual([
      '2026-07-05',
      '2026-07-05',
      '2026-07-06',
      '2026-07-06',
    ]);
  });
});

describe('buildWorkSegments — invalid input contracts', () => {
  it('27 rejects duplicate punch ids', () => {
    expect(() =>
      buildWorkSegments([
        punch('same', 'shift_in', '2026-07-06T05:00:00-07:00'),
        punch('same', 'shift_out', '2026-07-06T06:00:00-07:00'),
      ]),
    ).toThrow('duplicate punch id');
  });

  it('28 rejects invalid dates and missing plant ids', () => {
    expect(() => buildWorkSegments([punch('bad-time', 'shift_in', 'not-a-date')])).toThrow('time is invalid');
    expect(() => buildWorkSegments([punch('bad-plant', 'shift_in', '2026-07-06T05:00:00-07:00', '')])).toThrow(
      'plantId is required',
    );
  });

  it('29 does not mutate the caller input', () => {
    const input = [
      punch('in', 'shift_in', '2026-07-06T05:00:00-07:00'),
      punch('out', 'shift_out', '2026-07-06T06:00:00-07:00'),
    ];
    const before = JSON.stringify(input);
    buildWorkSegments(input);
    expect(JSON.stringify(input)).toBe(before);
  });
});
