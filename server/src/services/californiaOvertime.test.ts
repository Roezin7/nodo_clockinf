import { describe, expect, it } from 'vitest';
import {
  CALIFORNIA_HOUR_SECONDS as HOUR,
  classifyCaliforniaOvertime,
  type CaliforniaBucketTotals,
  type CaliforniaWorkChunk,
} from './californiaOvertime.js';

const MINUTE = 60;
const WEEK_START = '2026-07-05'; // Sunday
const DATES = ['2026-07-05', '2026-07-06', '2026-07-07', '2026-07-08', '2026-07-09', '2026-07-10', '2026-07-11'];

const h = (hours: number): number => Math.round(hours * HOUR);

function chunk(
  id: string,
  dayIndex: number,
  durationSeconds: number,
  options: Partial<Pick<CaliforniaWorkChunk, 'plantId' | 'source' | 'order'>> = {},
): CaliforniaWorkChunk {
  return {
    id,
    workDate: DATES[dayIndex]!,
    durationSeconds,
    plantId: options.plantId ?? 'plant-a',
    source: options.source ?? 'clock',
    order: options.order ?? 0,
  };
}

function chunksForDays(daySeconds: readonly number[]): CaliforniaWorkChunk[] {
  return daySeconds.flatMap((seconds, index) => (seconds > 0 ? [chunk(`day-${index}`, index, seconds)] : []));
}

function classify(chunks: CaliforniaWorkChunk[]) {
  return classifyCaliforniaOvertime({ weekStart: WEEK_START, chunks });
}

function expectTotals(
  actual: CaliforniaBucketTotals,
  regularSeconds: number,
  overtime15Seconds: number,
  doubleTimeSeconds: number,
): void {
  expect(actual).toEqual({ regularSeconds, overtime15Seconds, doubleTimeSeconds });
}

describe('California overtime — deterministic legal vectors', () => {
  const vectors: Array<{
    name: string;
    days: number[];
    regular: number;
    overtime: number;
    double: number;
  }> = [
    { name: '01 exact 8-hour day', days: [h(8)], regular: h(8), overtime: 0, double: 0 },
    {
      name: '02 one minute beyond 8 hours',
      days: [h(8) + MINUTE],
      regular: h(8),
      overtime: MINUTE,
      double: 0,
    },
    { name: '03 exact 12-hour day', days: [h(12)], regular: h(8), overtime: h(4), double: 0 },
    {
      name: '04 one minute beyond 12 hours',
      days: [h(12) + MINUTE],
      regular: h(8),
      overtime: h(4),
      double: MINUTE,
    },
    { name: '05 13-hour day', days: [h(13)], regular: h(8), overtime: h(4), double: h(1) },
    {
      name: '06 five 8-hour days',
      days: [h(8), h(8), h(8), h(8), h(8)],
      regular: h(40),
      overtime: 0,
      double: 0,
    },
    {
      name: '07 weekly threshold crossed by one hour',
      days: [h(8), h(8), h(8), h(8), h(8), h(1)],
      regular: h(40),
      overtime: h(1),
      double: 0,
    },
    {
      name: '08 daily overtime is not counted again toward weekly overtime',
      days: [h(10), h(10), h(10), h(10), h(8)],
      regular: h(40),
      overtime: h(8),
      double: 0,
    },
    {
      name: '09 five 10-hour days',
      days: [h(10), h(10), h(10), h(10), h(10)],
      regular: h(40),
      overtime: h(10),
      double: 0,
    },
    {
      name: '10 weekly threshold can split a daily regular candidate',
      days: [h(8), h(8), h(8), h(8), h(7), h(8)],
      regular: h(40),
      overtime: h(7),
      double: 0,
    },
    {
      name: '11 65 hours alone never creates double time',
      days: [h(11), h(11), h(11), h(11), h(10), h(11)],
      regular: h(40),
      overtime: h(25),
      double: 0,
    },
    {
      name: '12 one hour on each of seven days',
      days: [h(1), h(1), h(1), h(1), h(1), h(1), h(1)],
      regular: h(6),
      overtime: h(1),
      double: 0,
    },
    {
      name: '13 seven 8-hour days',
      days: [h(8), h(8), h(8), h(8), h(8), h(8), h(8)],
      regular: h(40),
      overtime: h(16),
      double: 0,
    },
    {
      name: '14 seventh day exceeds 8 hours',
      days: [h(8), h(8), h(8), h(8), h(8), h(8), h(10)],
      regular: h(40),
      overtime: h(16),
      double: h(2),
    },
    {
      name: '15 seven 10-hour days',
      days: [h(10), h(10), h(10), h(10), h(10), h(10), h(10)],
      regular: h(40),
      overtime: h(28),
      double: h(2),
    },
    {
      name: '16 any positive duration makes a worked day for seventh-day treatment',
      days: [h(0.25), h(0.25), h(0.25), h(0.25), h(0.25), h(0.25), h(13)],
      regular: h(1.5),
      overtime: h(8),
      double: h(5),
    },
    {
      name: '17 a gap prevents seventh-day treatment but not weekly overtime',
      days: [h(8), h(8), h(8), 0, h(8), h(8), h(13)],
      regular: h(40),
      overtime: h(12),
      double: h(1),
    },
    {
      name: '18 six current-week days are not seventh-day work',
      days: [h(1), h(1), h(1), h(1), h(1), h(1), 0],
      regular: h(6),
      overtime: 0,
      double: 0,
    },
  ];

  it.each(vectors)('$name', ({ days, regular, overtime, double }) => {
    const result = classify(chunksForDays(days));
    expectTotals(result.totals, regular, overtime, double);
    expect(result.totalWorkedSeconds).toBe(regular + overtime + double);
  });

  it('19 keeps second-level precision immediately after eight hours', () => {
    const result = classify([chunk('precise', 0, h(8) + 30)]);
    expectTotals(result.totals, h(8), 30, 0);
  });

  it('20 keeps second-level precision on the seventh-day double-time boundary', () => {
    const result = classify(chunksForDays([h(1), h(1), h(1), h(1), h(1), h(1), h(8) + 30]));
    expectTotals(result.totals, h(6), h(8), 30);
    expect(result.days[6]!.isSeventhConsecutiveDay).toBe(true);
  });

  it('21 treats split overnight time as the two workday chunks supplied by the caller', () => {
    const result = classify([chunk('monday-evening', 1, h(4)), chunk('tuesday-morning', 2, h(5))]);
    expectTotals(result.totals, h(9), 0, 0);
    expect(result.days[1]!.totalWorkedSeconds).toBe(h(4));
    expect(result.days[2]!.totalWorkedSeconds).toBe(h(5));
  });

  it('22 applies seventh-day treatment to the Saturday portion of an overnight schedule', () => {
    const result = classify(chunksForDays([h(1), h(1), h(1), h(1), h(1), h(4), h(5)]));
    expectTotals(result.totals, h(9), h(5), 0);
    expectTotals(result.days[6]!.totals, 0, h(5), 0);
  });

  it('23 accepts elapsed durations across spring DST without inventing an hour', () => {
    const result = classify([chunk('spring-dst-elapsed', 0, h(3))]);
    expectTotals(result.totals, h(3), 0, 0);
  });

  it('24 accepts elapsed durations across fall DST without losing the repeated hour', () => {
    const result = classify([chunk('fall-dst-elapsed', 0, h(4))]);
    expectTotals(result.totals, h(4), 0, 0);
  });

  it('25 classifies one day across two plants as one employee workday', () => {
    const result = classify([
      chunk('plant-a-five', 0, h(5), { plantId: 'plant-a', order: 0 }),
      chunk('plant-b-five', 0, h(5), { plantId: 'plant-b', order: 1 }),
    ]);

    expectTotals(result.totals, h(8), h(2), 0);
    expectTotals(result.byPlant['plant-a']!, h(5), 0, 0);
    expectTotals(result.byPlant['plant-b']!, h(3), h(2), 0);
  });

  it('26 consolidates the weekly threshold across plants', () => {
    const result = classify([
      chunk('a-su', 0, h(8), { plantId: 'plant-a' }),
      chunk('a-mo', 1, h(8), { plantId: 'plant-a' }),
      chunk('a-tu', 2, h(8), { plantId: 'plant-a' }),
      chunk('a-we', 3, h(8), { plantId: 'plant-a' }),
      chunk('b-th', 4, h(8), { plantId: 'plant-b' }),
      chunk('b-fr', 5, h(8), { plantId: 'plant-b' }),
    ]);

    expectTotals(result.totals, h(40), h(8), 0);
    expectTotals(result.byPlant['plant-a']!, h(32), 0, 0);
    expectTotals(result.byPlant['plant-b']!, h(8), h(8), 0);
  });
});

describe('California overtime — manual credited hours', () => {
  it('27 appends manual time after clock time and classifies it automatically', () => {
    const result = classify([
      chunk('manual-first-in-input', 0, h(3), { source: 'manual', order: -10 }),
      chunk('clock-second-in-input', 0, h(8), { source: 'clock', order: 99 }),
    ]);

    expectTotals(result.totals, h(8), h(3), 0);
    expectTotals(result.bySource.clock, h(8), 0, 0);
    expectTotals(result.bySource.manual, 0, h(3), 0);
  });

  it('28 splits a five-hour manual credit across overtime and double time', () => {
    const result = classify([
      chunk('clock', 0, h(8)),
      chunk('manual', 0, h(5), { source: 'manual', order: 0 }),
    ]);

    expectTotals(result.totals, h(8), h(4), h(1));
    expectTotals(result.bySource.manual, 0, h(4), h(1));
  });

  it('29 can split a manual credit between regular and overtime', () => {
    const result = classify([
      chunk('clock', 0, h(6)),
      chunk('manual', 0, h(4), { source: 'manual', order: 0 }),
    ]);

    expectTotals(result.totals, h(8), h(2), 0);
    expectTotals(result.bySource.manual, h(2), h(2), 0);
  });

  it('30 makes manual time beyond 40 weekly regular candidates overtime', () => {
    const result = classify([
      ...chunksForDays([h(8), h(8), h(8), h(8), h(8)]),
      chunk('manual-friday', 5, h(2), { source: 'manual' }),
    ]);

    expectTotals(result.totals, h(40), h(2), 0);
    expectTotals(result.bySource.manual, 0, h(2), 0);
  });

  it('31 applies seventh-day overtime to a manual-only Saturday', () => {
    const result = classify([
      ...chunksForDays([h(8), h(8), h(8), h(8), h(8), h(8)]),
      chunk('manual-saturday', 6, h(2), { source: 'manual' }),
    ]);

    expectTotals(result.totals, h(40), h(10), 0);
    expectTotals(result.bySource.manual, 0, h(2), 0);
    expect(result.days[6]!.isSeventhConsecutiveDay).toBe(true);
  });

  it('32 allows a manual Sunday to participate in the seven-day sequence', () => {
    const result = classify([
      chunk('manual-sunday', 0, h(1), { source: 'manual' }),
      ...[1, 2, 3, 4, 5].map((day) => chunk(`clock-${day}`, day, h(8))),
      chunk('clock-saturday', 6, h(4)),
    ]);

    expectTotals(result.totals, h(40), h(5), 0);
    expectTotals(result.bySource.manual, h(1), 0, 0);
  });

  it('33 classifies an unlimited 13-hour manual entry through every daily bucket', () => {
    const result = classify([chunk('manual-only', 1, h(13), { source: 'manual' })]);
    expectTotals(result.totals, h(8), h(4), h(1));
    expectTotals(result.bySource.manual, h(8), h(4), h(1));
  });

  it('34 orders multiple manual credits by order then id', () => {
    const result = classify([
      chunk('manual-later', 0, h(2), { source: 'manual', order: 2 }),
      chunk('clock', 0, h(7), { order: 500 }),
      chunk('manual-earlier', 0, h(1), { source: 'manual', order: 1 }),
    ]);

    expectTotals(result.totals, h(8), h(2), 0);
    const earlier = result.parts.filter((part) => part.id === 'manual-earlier');
    const later = result.parts.filter((part) => part.id === 'manual-later');
    expect(earlier).toHaveLength(1);
    expect(earlier[0]!.bucket).toBe('regular');
    expect(later).toHaveLength(1);
    expect(later[0]!.bucket).toBe('overtime_1_5');
  });

  it('35 a manual bridge day can create a seventh consecutive day', () => {
    const result = classify([
      chunk('su', 0, h(1)),
      chunk('mo', 1, h(1)),
      chunk('tu', 2, h(1)),
      chunk('manual-we', 3, h(1), { source: 'manual' }),
      chunk('th', 4, h(1)),
      chunk('fr', 5, h(1)),
      chunk('sa', 6, h(1)),
    ]);

    expectTotals(result.totals, h(6), h(1), 0);
    expect(result.days[6]!.isSeventhConsecutiveDay).toBe(true);
  });
});

describe('California overtime — aggregation and invariants', () => {
  it('36 returns seven ordered day records even for an empty workweek', () => {
    const result = classify([]);
    expect(result.days.map((day) => day.workDate)).toEqual(DATES);
    expect(result.weekEnd).toBe(DATES[6]);
    expectTotals(result.totals, 0, 0, 0);
    expect(result.totalWorkedSeconds).toBe(0);
  });

  it('37 keeps day, plant, source and week sums equal', () => {
    const result = classify([
      chunk('a-clock', 0, h(8), { plantId: 'plant-a' }),
      chunk('a-manual', 0, h(2), { plantId: 'plant-a', source: 'manual' }),
      chunk('b-clock', 1, h(13), { plantId: 'plant-b' }),
    ]);

    const bucketSum = (totals: CaliforniaBucketTotals) =>
      totals.regularSeconds + totals.overtime15Seconds + totals.doubleTimeSeconds;
    const daySum = result.days.reduce((sum, day) => sum + day.totalWorkedSeconds, 0);
    const plantSum = Object.values(result.byPlant).reduce((sum, totals) => sum + bucketSum(totals), 0);
    const sourceSum = Object.values(result.bySource).reduce((sum, totals) => sum + bucketSum(totals), 0);

    expect(result.totalWorkedSeconds).toBe(h(23));
    expect(bucketSum(result.totals)).toBe(result.totalWorkedSeconds);
    expect(daySum).toBe(result.totalWorkedSeconds);
    expect(plantSum).toBe(result.totalWorkedSeconds);
    expect(sourceSum).toBe(result.totalWorkedSeconds);
  });

  it('38 attributes the weekly split to the exact later chunk', () => {
    const result = classify([
      ...chunksForDays([h(8), h(8), h(8), h(8), h(7)]),
      chunk('friday-split', 5, h(2), { plantId: 'plant-b' }),
    ]);
    const friday = result.parts.filter((part) => part.id === 'friday-split');

    expect(friday.map(({ bucket, durationSeconds }) => ({ bucket, durationSeconds }))).toEqual([
      { bucket: 'regular', durationSeconds: h(1) },
      { bucket: 'overtime_1_5', durationSeconds: h(1) },
    ]);
  });
});

describe('California overtime — input validation', () => {
  it('39 rejects a non-Sunday week start', () => {
    expect(() => classifyCaliforniaOvertime({ weekStart: '2026-07-06', chunks: [] })).toThrow(
      'weekStart must be a Sunday',
    );
  });

  it('40 rejects an invalid calendar date', () => {
    expect(() => classifyCaliforniaOvertime({ weekStart: '2026-02-29', chunks: [] })).toThrow(
      'weekStart must be a valid ISO date',
    );
  });

  it('41 rejects a chunk outside the supplied workweek', () => {
    expect(() =>
      classify([
        {
          id: 'outside',
          workDate: '2026-07-12',
          durationSeconds: h(1),
          plantId: 'plant-a',
          source: 'clock',
          order: 0,
        },
      ]),
    ).toThrow('outside the supplied workweek');
  });

  it.each([0, -1, 1.5])('42 rejects invalid duration %s', (durationSeconds) => {
    expect(() => classify([chunk('invalid-duration', 0, durationSeconds)])).toThrow(
      'durationSeconds must be a positive whole number',
    );
  });

  it('43 rejects duplicate chunk identifiers', () => {
    expect(() => classify([chunk('duplicate', 0, h(1)), chunk('duplicate', 1, h(1))])).toThrow(
      'duplicate chunk id',
    );
  });

  it('44 rejects an empty plant identifier', () => {
    expect(() => classify([chunk('empty-plant', 0, h(1), { plantId: ' ' })])).toThrow('plantId is required');
  });

  it('45 rejects a non-integer order', () => {
    expect(() => classify([chunk('bad-order', 0, h(1), { order: 0.5 })])).toThrow('order must be a safe integer');
  });
});
