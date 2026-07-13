import { describe, expect, it } from 'vitest';
import {
  FIRST_MEAL_DEADLINE_SECONDS,
  MEAL_HOUR_SECONDS as HOUR,
  MINIMUM_MEAL_SECONDS,
  SECOND_MEAL_DEADLINE_SECONDS,
  screenCaliforniaMealCompliance,
  type MealComplianceInput,
  type MealComplianceMealInterval,
  type MealComplianceWorkInterval,
} from './mealCompliance.js';

const SECOND = 1;
const MINUTE = 60;
const BASE = Date.parse('2026-07-06T12:00:00.000Z'); // 05:00 in Modesto
const WORK_DATE = '2026-07-06';
const TIMEZONE = 'America/Los_Angeles';

function instant(offsetSeconds: number, base = BASE): string {
  return new Date(base + offsetSeconds * 1_000).toISOString();
}

function work(
  id: string,
  startSecond: number,
  endSecond: number,
  plantId = 'plant-a',
  base = BASE,
): MealComplianceWorkInterval {
  return { id, start: instant(startSecond, base), end: instant(endSecond, base), plantId };
}

function meal(
  id: string,
  startSecond: number,
  endSecond: number,
  plantId = 'plant-a',
  base = BASE,
): MealComplianceMealInterval {
  return { id, start: instant(startSecond, base), end: instant(endSecond, base), plantId };
}

function input(
  workIntervals: readonly MealComplianceWorkInterval[],
  mealIntervals: readonly MealComplianceMealInterval[] = [],
  options: Partial<Pick<MealComplianceInput, 'workDate' | 'timezone'>> = {},
): MealComplianceInput {
  return {
    workDate: options.workDate ?? WORK_DATE,
    timezone: options.timezone ?? TIMEZONE,
    workIntervals,
    mealIntervals,
  };
}

function timeline(
  endElapsedSeconds: number,
  meals: readonly { id: string; start: number; duration?: number; plantId?: string }[],
  plantIds: readonly string[] = ['plant-a'],
): MealComplianceInput {
  const orderedMeals = [...meals].sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
  const workIntervals: MealComplianceWorkInterval[] = [];
  const mealIntervals: MealComplianceMealInterval[] = [];
  let cursor = 0;
  let workIndex = 0;

  for (const entry of orderedMeals) {
    const duration = entry.duration ?? MINIMUM_MEAL_SECONDS;
    if (entry.start > cursor) {
      workIntervals.push(
        work(
          `work-${workIndex}`,
          cursor,
          entry.start,
          plantIds[workIndex % plantIds.length]!,
        ),
      );
      workIndex += 1;
    }
    mealIntervals.push(meal(entry.id, entry.start, entry.start + duration, entry.plantId));
    cursor = entry.start + duration;
  }

  if (endElapsedSeconds > cursor) {
    workIntervals.push(
      work(`work-${workIndex}`, cursor, endElapsedSeconds, plantIds[workIndex % plantIds.length]!),
    );
  }
  return input(workIntervals, mealIntervals);
}

function warningCodes(value: MealComplianceInput): string[] {
  return screenCaliforniaMealCompliance(value).warnings.map((warning) => warning.code);
}

describe('California meal screening — first meal exact boundaries', () => {
  it('01 does not require a meal at exactly five worked hours', () => {
    const result = screenCaliforniaMealCompliance(input([work('only', 0, 5 * HOUR)]));

    expect(result.totalWorkedSeconds).toBe(5 * HOUR);
    expect(result.warnings).toEqual([]);
    expect(result.requiresReview).toBe(false);
  });

  it('02 sends five hours plus one second without a meal to waiver review', () => {
    const result = screenCaliforniaMealCompliance(input([work('only', 0, 5 * HOUR + SECOND)]));

    expect(warningCodes(input([work('only', 0, 5 * HOUR + SECOND)]))).toEqual([
      'first_meal_waiver_review',
    ]);
    expect(result.warnings[0]).toMatchObject({
      thresholdSeconds: 6 * HOUR,
      observedSeconds: 5 * HOUR + SECOND,
      mealNumber: 1,
      mealIntervalId: null,
    });
  });

  it('03 keeps exactly six worked hours waiver-reviewable', () => {
    expect(warningCodes(input([work('only', 0, 6 * HOUR)]))).toEqual(['first_meal_waiver_review']);
  });

  it('04 reports a first meal missing at six hours plus one second', () => {
    expect(warningCodes(input([work('only', 0, 6 * HOUR + SECOND)]))).toEqual([
      'first_meal_missing',
    ]);
  });

  it('05 accepts a first meal beginning at exactly the fifth elapsed hour', () => {
    const result = screenCaliforniaMealCompliance(
      timeline(7.5 * HOUR, [{ id: 'first', start: 5 * HOUR }]),
    );

    expect(result.totalWorkedSeconds).toBe(7 * HOUR);
    expect(result.meals[0]).toMatchObject({
      durationSeconds: 30 * MINUTE,
      elapsedFromPeriodStartSeconds: 5 * HOUR,
    });
    expect(result.warnings).toEqual([]);
  });

  it('06 reports the same meal late at five elapsed hours plus one second', () => {
    expect(
      warningCodes(timeline(7.5 * HOUR + SECOND, [{ id: 'first', start: 5 * HOUR + SECOND }])),
    ).toEqual(['first_meal_late']);
  });

  it('07 accepts exactly 30 minutes and reports 29:59 as short', () => {
    expect(
      warningCodes(
        timeline(7.5 * HOUR, [{ id: 'first', start: 4 * HOUR, duration: 30 * MINUTE }]),
      ),
    ).toEqual([]);

    const shortResult = screenCaliforniaMealCompliance(
      timeline(7.5 * HOUR, [{ id: 'first', start: 4 * HOUR, duration: 30 * MINUTE - SECOND }]),
    );
    expect(shortResult.warnings.map((warning) => warning.code)).toEqual(['first_meal_short']);
    expect(shortResult.warnings[0]).toMatchObject({
      thresholdSeconds: 30 * MINUTE,
      observedSeconds: 30 * MINUTE - SECOND,
    });
  });

  it('08 deterministically reports short before late when both apply', () => {
    expect(
      warningCodes(
        timeline(7.5 * HOUR, [
          { id: 'first', start: 5 * HOUR + SECOND, duration: 30 * MINUTE - SECOND },
        ]),
      ),
    ).toEqual(['first_meal_short', 'first_meal_late']);
  });
});

describe('California meal screening — second meal and waiver review', () => {
  it('09 does not require a second meal at exactly ten worked hours', () => {
    const value = timeline(10.5 * HOUR, [{ id: 'first', start: 4 * HOUR }]);

    expect(screenCaliforniaMealCompliance(value).totalWorkedSeconds).toBe(10 * HOUR);
    expect(warningCodes(value)).toEqual([]);
  });

  it('10 sends ten hours plus one second to second-meal waiver review after a valid first meal', () => {
    const value = timeline(10.5 * HOUR + SECOND, [{ id: 'first', start: 4 * HOUR }]);

    expect(warningCodes(value)).toEqual(['second_meal_waiver_review']);
  });

  it('11 keeps exactly twelve worked hours waiver-reviewable after a valid first meal', () => {
    const value = timeline(12.5 * HOUR, [{ id: 'first', start: 4 * HOUR }]);

    expect(screenCaliforniaMealCompliance(value).totalWorkedSeconds).toBe(12 * HOUR);
    expect(warningCodes(value)).toEqual(['second_meal_waiver_review']);
  });

  it('12 reports the second meal missing above twelve worked hours', () => {
    const value = timeline(12.5 * HOUR + SECOND, [{ id: 'first', start: 4 * HOUR }]);

    expect(warningCodes(value)).toEqual(['second_meal_missing']);
  });

  it('13 does not offer a second-meal waiver when the first meal is absent', () => {
    const value = input([work('only', 0, 10 * HOUR + SECOND)]);

    expect(warningCodes(value)).toEqual(['first_meal_missing', 'second_meal_missing']);
  });

  it('14 does not offer a second-meal waiver when the first meal is short', () => {
    const value = timeline(10.5 * HOUR + SECOND, [
      { id: 'first', start: 4 * HOUR, duration: 30 * MINUTE - SECOND },
    ]);

    expect(warningCodes(value)).toEqual(['first_meal_short', 'second_meal_missing']);
  });

  it('15 accepts the second meal beginning at exactly the tenth elapsed hour', () => {
    const value = timeline(11 * HOUR + SECOND, [
      { id: 'first', start: 4 * HOUR },
      { id: 'second', start: 10 * HOUR },
    ]);

    expect(screenCaliforniaMealCompliance(value).totalWorkedSeconds).toBe(10 * HOUR + SECOND);
    expect(warningCodes(value)).toEqual([]);
  });

  it('16 reports the second meal late at ten elapsed hours plus one second', () => {
    const value = timeline(11 * HOUR + 2 * SECOND, [
      { id: 'first', start: 4 * HOUR },
      { id: 'second', start: 10 * HOUR + SECOND },
    ]);

    expect(warningCodes(value)).toEqual(['second_meal_late']);
    expect(screenCaliforniaMealCompliance(value).warnings[0]).toMatchObject({
      thresholdSeconds: SECOND_MEAL_DEADLINE_SECONDS,
      observedSeconds: SECOND_MEAL_DEADLINE_SECONDS + SECOND,
    });
  });

  it('17 reports a second meal shorter than 30 minutes', () => {
    const value = timeline(11 * HOUR, [
      { id: 'first', start: 4 * HOUR },
      { id: 'second', start: 9 * HOUR, duration: 30 * MINUTE - SECOND },
    ]);

    expect(warningCodes(value)).toEqual(['second_meal_short']);
  });
});

describe('California meal screening — operation vectors', () => {
  it('18 screens the normal 05:00–13:30 shift with 09:00–09:30 meal at zero warnings', () => {
    const value = timeline(8.5 * HOUR, [{ id: 'lunch', start: 4 * HOUR }]);
    const result = screenCaliforniaMealCompliance(value);

    expect(result.periodStartedAt).toBe('2026-07-06T12:00:00.000Z');
    expect(result.totalWorkedSeconds).toBe(8 * HOUR);
    expect(result.meals).toHaveLength(1);
    expect(result.warnings).toEqual([]);
  });

  it('19 consolidates contiguous work across plants without a split-shift warning', () => {
    const value = input(
      [
        work('plant-a-before', 0, 3 * HOUR, 'plant-a'),
        work('plant-b-before', 3 * HOUR, 5 * HOUR, 'plant-b'),
        work('plant-c-after', 5.5 * HOUR, 7.5 * HOUR, 'plant-c'),
      ],
      [meal('meal', 5 * HOUR, 5.5 * HOUR, 'plant-b')],
    );

    const result = screenCaliforniaMealCompliance(value);
    expect(result.totalWorkedSeconds).toBe(7 * HOUR);
    expect(result.warnings).toEqual([]);
  });

  it('20 emits one split-shift policy warning for an unexplained shift-out/in gap', () => {
    const value = input([
      work('first-shift', 0, 3 * HOUR, 'plant-a'),
      work('second-shift', 4 * HOUR, 7 * HOUR, 'plant-b'),
    ]);
    const result = screenCaliforniaMealCompliance(value);

    expect(result.warnings.map((warning) => warning.code)).toEqual([
      'split_shift_policy_review',
      'first_meal_waiver_review',
    ]);
    expect(result.warnings[0]).toMatchObject({
      observedSeconds: HOUR,
      relatedIntervalIds: ['first-shift', 'second-shift'],
      plantIds: ['plant-a', 'plant-b'],
    });
  });

  it('21 does not call a gap a split shift when declared meals fully explain it', () => {
    const value = input(
      [work('before', 0, 3 * HOUR), work('after', 4 * HOUR, 7 * HOUR)],
      [meal('meal-a', 3 * HOUR, 3.5 * HOUR), meal('meal-b', 3.5 * HOUR, 4 * HOUR)],
    );

    expect(warningCodes(value)).not.toContain('split_shift_policy_review');
  });

  it('22 reports only the uncovered seconds when a meal explains part of a gap', () => {
    const value = input(
      [work('before', 0, 3 * HOUR), work('after', 4 * HOUR, 7 * HOUR)],
      [meal('partial-meal', 3 * HOUR, 3.5 * HOUR)],
    );
    const split = screenCaliforniaMealCompliance(value).warnings.find(
      (warning) => warning.code === 'split_shift_policy_review',
    );

    expect(split?.observedSeconds).toBe(30 * MINUTE);
  });

  it('23 is deterministic under shuffled input and deduplicates warning codes', () => {
    const chronological = input(
      [
        work('w1', 0, 5 * HOUR + SECOND, 'plant-b'),
        work('w2', 5.5 * HOUR, 7.5 * HOUR, 'plant-a'),
      ],
      [meal('m1', 5 * HOUR + SECOND, 5.5 * HOUR, 'plant-b')],
    );
    const shuffled = input(
      [...chronological.workIntervals].reverse(),
      [...chronological.mealIntervals].reverse(),
    );

    const first = screenCaliforniaMealCompliance(chronological);
    const second = screenCaliforniaMealCompliance(shuffled);
    expect(second).toEqual(first);
    expect(new Set(first.warnings.map((warning) => warning.key)).size).toBe(first.warnings.length);
  });

  it('24 remains pure and does not mutate frozen input arrays', () => {
    const workIntervals = Object.freeze([Object.freeze(work('later', 4.5 * HOUR, 8.5 * HOUR)), Object.freeze(work('early', 0, 4 * HOUR))]);
    const mealIntervals = Object.freeze([Object.freeze(meal('meal', 4 * HOUR, 4.5 * HOUR))]);
    const value = Object.freeze(input(workIntervals, mealIntervals));

    const first = screenCaliforniaMealCompliance(value);
    const second = screenCaliforniaMealCompliance(value);
    expect(second).toEqual(first);
    expect(workIntervals.map((entry) => entry.id)).toEqual(['later', 'early']);
  });

  it('25 returns screening facts only and never adds premiums or payable hours', () => {
    const result = screenCaliforniaMealCompliance(input([work('only', 0, 7 * HOUR)]));

    expect(Object.keys(result).sort()).toEqual([
      'meals',
      'periodStartedAt',
      'requiresReview',
      'timezone',
      'totalWorkedSeconds',
      'warnings',
      'workDate',
    ]);
    expect(JSON.stringify(result)).not.toMatch(/premium|payable|manual/i);
  });
});

describe('California meal screening — overnight and DST elapsed seconds', () => {
  it('26 allows a workDate-owned period to cross local midnight', () => {
    const base = Date.parse('2026-07-07T05:00:00.000Z'); // 22:00 Jul 6 PDT
    const value = input(
      [
        work('before', 0, 5 * HOUR, 'plant-a', base),
        work('after', 5.5 * HOUR, 6.5 * HOUR, 'plant-a', base),
      ],
      [meal('meal', 5 * HOUR, 5.5 * HOUR, 'plant-a', base)],
    );

    const result = screenCaliforniaMealCompliance(value);
    expect(result.totalWorkedSeconds).toBe(6 * HOUR);
    expect(result.meals[0]!.elapsedFromPeriodStartSeconds).toBe(5 * HOUR);
    expect(result.warnings).toEqual([]);
  });

  it('27 uses real elapsed seconds across spring-forward for the five-hour deadline', () => {
    const value = input(
      [
        {
          id: 'before',
          start: '2026-03-08T00:00:00-08:00',
          end: '2026-03-08T06:00:00-07:00',
          plantId: 'plant-a',
        },
        {
          id: 'after',
          start: '2026-03-08T06:30:00-07:00',
          end: '2026-03-08T07:30:00-07:00',
          plantId: 'plant-a',
        },
      ],
      [
        {
          id: 'meal',
          start: '2026-03-08T06:00:00-07:00',
          end: '2026-03-08T06:30:00-07:00',
          plantId: 'plant-a',
        },
      ],
      { workDate: '2026-03-08' },
    );

    const result = screenCaliforniaMealCompliance(value);
    expect(result.totalWorkedSeconds).toBe(6 * HOUR);
    expect(result.meals[0]!.elapsedFromPeriodStartSeconds).toBe(FIRST_MEAL_DEADLINE_SECONDS);
    expect(result.warnings).toEqual([]);
  });

  it('28 keeps the repeated fall-back hour in the five-hour deadline', () => {
    const value = input(
      [
        {
          id: 'before',
          start: '2026-11-01T00:00:00-07:00',
          end: '2026-11-01T04:00:00-08:00',
          plantId: 'plant-a',
        },
        {
          id: 'after',
          start: '2026-11-01T04:30:00-08:00',
          end: '2026-11-01T05:30:00-08:00',
          plantId: 'plant-a',
        },
      ],
      [
        {
          id: 'meal',
          start: '2026-11-01T04:00:00-08:00',
          end: '2026-11-01T04:30:00-08:00',
          plantId: 'plant-a',
        },
      ],
      { workDate: '2026-11-01' },
    );

    const result = screenCaliforniaMealCompliance(value);
    expect(result.meals[0]!.elapsedFromPeriodStartSeconds).toBe(5 * HOUR);
    expect(result.warnings).toEqual([]);
  });

  it('29 normalizes both endpoints to whole epoch seconds', () => {
    const result = screenCaliforniaMealCompliance(
      input([
        {
          id: 'precise',
          start: '2026-07-06T05:00:00.900-07:00',
          end: '2026-07-06T10:00:01.100-07:00',
          plantId: 'plant-a',
        },
      ]),
    );

    expect(result.totalWorkedSeconds).toBe(5 * HOUR + SECOND);
    expect(warningCodes(input([
      {
        id: 'precise',
        start: '2026-07-06T05:00:00.900-07:00',
        end: '2026-07-06T10:00:01.100-07:00',
        plantId: 'plant-a',
      },
    ]))).toEqual(['first_meal_waiver_review']);
  });
});

describe('California meal screening — strict input invariants', () => {
  it('30 rejects empty work input', () => {
    expect(() => screenCaliforniaMealCompliance(input([]))).toThrow('at least one work interval');
  });

  it('31 rejects invalid work dates, zones, and a mismatched local start date', () => {
    expect(() =>
      screenCaliforniaMealCompliance(input([work('w', 0, HOUR)], [], { workDate: '2026-02-30' })),
    ).toThrow('workDate/timezone combination is invalid');
    expect(() =>
      screenCaliforniaMealCompliance(input([work('w', 0, HOUR)], [], { timezone: 'Mars/Modesto' })),
    ).toThrow('workDate/timezone combination is invalid');
    expect(() =>
      screenCaliforniaMealCompliance(input([work('w', 0, HOUR)], [], { workDate: '2026-07-05' })),
    ).toThrow('workDate must equal the local date');
  });

  it('32 rejects non-absolute strings and invalid Date objects', () => {
    expect(() =>
      screenCaliforniaMealCompliance(
        input([{ id: 'w', start: '2026-07-06T05:00:00', end: instant(HOUR), plantId: 'a' }]),
      ),
    ).toThrow('absolute ISO timestamp');
    expect(() =>
      screenCaliforniaMealCompliance(
        input([{ id: 'w', start: new Date(Number.NaN), end: instant(HOUR), plantId: 'a' }]),
      ),
    ).toThrow('is invalid');
  });

  it('33 rejects duplicate ids, zero/negative intervals, and blank plant ids', () => {
    expect(() =>
      screenCaliforniaMealCompliance(input([work('same', 0, HOUR)], [meal('same', HOUR, 2 * HOUR)])),
    ).toThrow('duplicate interval id');
    expect(() =>
      screenCaliforniaMealCompliance(input([work('zero', 0, 0)])),
    ).toThrow('end must be after start');
    expect(() =>
      screenCaliforniaMealCompliance(input([work('blank', 0, HOUR, '  ')])),
    ).toThrow('plantId is required');
  });

  it('34 rejects overlapping work, overlapping meals, and meals overlapping work', () => {
    expect(() =>
      screenCaliforniaMealCompliance(input([work('a', 0, 2 * HOUR), work('b', HOUR, 3 * HOUR)])),
    ).toThrow('work intervals a and b overlap');

    expect(() =>
      screenCaliforniaMealCompliance(
        input(
          [work('work', 0, HOUR)],
          [meal('a', 2 * HOUR, 3 * HOUR), meal('b', 2.5 * HOUR, 4 * HOUR)],
        ),
      ),
    ).toThrow('meal intervals a and b overlap');

    expect(() =>
      screenCaliforniaMealCompliance(
        input([work('work', 0, 2 * HOUR)], [meal('meal', HOUR, 1.5 * HOUR)]),
      ),
    ).toThrow('meal interval meal overlaps work interval work');
  });

  it('35 rejects a meal before the first entry', () => {
    expect(() =>
      screenCaliforniaMealCompliance(
        input([work('work', HOUR, 3 * HOUR)], [meal('meal', 0, 30 * MINUTE)]),
      ),
    ).toThrow('cannot start before the work period');
  });
});
