import { describe, expect, it } from 'vitest';
import {
  canonicalExceptionDedupeKey,
  derivePunchExceptionCandidates,
  type OperationalPunchInput,
} from './operationalExceptions.js';

const ORGANIZATION_ID = 'org-a';
const EMPLOYEE_ID = 'employee-a';
const PLANT_A = 'plant-a';
const PLANT_B = 'plant-b';
const TIMEZONE = 'America/Los_Angeles';
const WORK_DATE = '2026-07-06';
const BASE = Date.parse('2026-07-06T12:00:00.000Z'); // 05:00 Modesto

function at(seconds: number): string {
  return new Date(BASE + seconds * 1_000).toISOString();
}

function punch(
  id: string,
  punchType: OperationalPunchInput['punchType'],
  seconds: number,
  plantId = PLANT_A,
  employeeId = EMPLOYEE_ID,
): OperationalPunchInput {
  return { id, punchType, punchedAt: at(seconds), plantId, employeeId };
}

function derive(punches: readonly OperationalPunchInput[]) {
  return derivePunchExceptionCandidates({
    organizationId: ORGANIZATION_ID,
    fromDate: WORK_DATE,
    toDate: WORK_DATE,
    timezone: TIMEZONE,
    now: new Date('2026-07-07T12:00:00.000Z'),
    punches,
  });
}

function codes(punches: readonly OperationalPunchInput[]): string[] {
  return derive(punches).map((value) => value.code);
}

describe('operational exception canonical identity', () => {
  it('builds a stable, namespaced SHA-256 dedupe key', () => {
    const first = canonicalExceptionDedupeKey(
      'missing_shift_out',
      'punch_sequence',
      'employee-a:punch-a',
    );
    const repeated = canonicalExceptionDedupeKey(
      'missing_shift_out',
      'punch_sequence',
      'employee-a:punch-a',
    );
    const differentCode = canonicalExceptionDedupeKey(
      'missing_meal_in',
      'punch_sequence',
      'employee-a:punch-a',
    );

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(repeated).toBe(first);
    expect(differentCode).not.toBe(first);
    expect(() =>
      canonicalExceptionDedupeKey('missing_shift_out', 'punch_sequence', '   '),
    ).toThrow('sourceKey');
  });

  it('is deterministic for database order and does not mutate caller input', () => {
    const input = [
      punch('out', 'shift_out', 8.5 * 3_600),
      punch('meal-in', 'meal_in', 4.5 * 3_600),
      punch('in', 'shift_in', 0),
      punch('meal-out', 'meal_out', 4 * 3_600),
    ];
    const frozenShape = JSON.stringify(input);

    const first = derive(input);
    const second = derive([...input].reverse());

    expect(first).toEqual(second);
    expect(first).toEqual([]);
    expect(JSON.stringify(input)).toBe(frozenShape);
  });
});

describe('structural blockers derived from authoritative punches', () => {
  it('does not call an active shift a missing punch before the grace window', () => {
    const result = derivePunchExceptionCandidates({
      organizationId: ORGANIZATION_ID,
      fromDate: WORK_DATE,
      toDate: WORK_DATE,
      timezone: TIMEZONE,
      now: new Date(BASE + 10 * 3_600 * 1_000),
      punches: [punch('shift-in', 'shift_in', 0)],
    });
    expect(result).toEqual([]);
  });

  it('uses the assigned shift end plus one hour for a timely missing-out alert', () => {
    const shiftIn = {
      ...punch('shift-in', 'shift_in', 0),
      expectedShiftEndAt: at(8.5 * 3_600),
    };
    const beforeDeadline = derivePunchExceptionCandidates({
      organizationId: ORGANIZATION_ID,
      fromDate: WORK_DATE,
      toDate: WORK_DATE,
      timezone: TIMEZONE,
      now: new Date(BASE + (9.5 * 3_600 - 1) * 1_000),
      punches: [shiftIn],
    });
    const atDeadline = derivePunchExceptionCandidates({
      organizationId: ORGANIZATION_ID,
      fromDate: WORK_DATE,
      toDate: WORK_DATE,
      timezone: TIMEZONE,
      now: new Date(BASE + 9.5 * 3_600 * 1_000),
      punches: [shiftIn],
    });

    expect(beforeDeadline).toEqual([]);
    expect(atDeadline.map((value) => value.code)).toEqual(['missing_shift_out']);
  });

  it('disables live grace at finalization so every open sequence is detailed', () => {
    const result = derivePunchExceptionCandidates({
      organizationId: ORGANIZATION_ID,
      fromDate: WORK_DATE,
      toDate: WORK_DATE,
      timezone: TIMEZONE,
      now: new Date(BASE + 30 * 60 * 1_000),
      applyOpenSequenceGrace: false,
      punches: [punch('shift-in', 'shift_in', 0)],
    });

    expect(result.map((value) => value.code)).toEqual(['missing_shift_out']);
  });

  it('raises an open meal after two hours but not while lunch is in progress', () => {
    const punches = [
      punch('shift-in', 'shift_in', 0),
      punch('meal-out', 'meal_out', 4 * 3_600),
    ];
    const duringMeal = derivePunchExceptionCandidates({
      organizationId: ORGANIZATION_ID,
      fromDate: WORK_DATE,
      toDate: WORK_DATE,
      timezone: TIMEZONE,
      now: new Date(BASE + 4.5 * 3_600 * 1_000),
      punches,
    });
    const forgottenMeal = derivePunchExceptionCandidates({
      organizationId: ORGANIZATION_ID,
      fromDate: WORK_DATE,
      toDate: WORK_DATE,
      timezone: TIMEZONE,
      now: new Date(BASE + 6 * 3_600 * 1_000 + 1_000),
      punches,
    });
    expect(duringMeal).toEqual([]);
    expect(forgottenMeal.map((value) => value.code)).toEqual(['missing_meal_in']);
  });

  it('projects a missing shift-out as one blocker with its exact punch evidence', () => {
    const result = derive([punch('shift-in', 'shift_in', 0)]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      code: 'missing_shift_out',
      severity: 'blocker',
      sourceType: 'punch_sequence',
      employeeId: EMPLOYEE_ID,
      workDate: WORK_DATE,
      plantIds: [PLANT_A],
    });
    expect(result[0]?.details).toMatchObject({ related_punch_ids: ['shift-in'] });
  });

  it('projects missing meal-in and the still-open shift independently', () => {
    expect(
      codes([
        punch('shift-in', 'shift_in', 0),
        punch('meal-out', 'meal_out', 4 * 3_600),
      ]),
    ).toEqual(['missing_shift_out', 'missing_meal_in']);
  });

  it('projects semantic out-of-sequence punches', () => {
    const result = derive([punch('lonely-out', 'shift_out', 3_600)]);

    expect(result.map((value) => value.code)).toEqual(['out_of_sequence']);
    expect(result[0]?.severity).toBe('blocker');
    expect(result[0]?.details).toMatchObject({ punch_id: 'lonely-out' });
  });

  it('adds an explicit negative-duration blocker at the equal-time boundary', () => {
    const result = derive([
      punch('a-in', 'shift_in', 0),
      punch('b-out', 'shift_out', 0),
    ]);

    expect(result.map((value) => value.code).sort()).toEqual([
      'negative_duration',
      'out_of_sequence',
    ]);
    expect(result.every((value) => value.severity === 'blocker')).toBe(true);
  });

  it('detects overlapping work at two plants and suppresses speculative meal screening', () => {
    const result = derive([
      punch('a-in', 'shift_in', 0, PLANT_A),
      punch('b-in', 'shift_in', 2 * 3_600, PLANT_B),
      punch('a-out', 'shift_out', 7 * 3_600, PLANT_A),
      punch('b-out', 'shift_out', 8 * 3_600, PLANT_B),
    ]);

    expect(result.map((value) => value.code)).toEqual(['overlap_between_plants']);
    expect(result[0]).toMatchObject({
      severity: 'blocker',
      plantIds: [PLANT_A, PLANT_B],
    });
    expect(result[0]?.details).toMatchObject({ overlap_seconds: 5 * 3_600 });
  });
});

describe('California meal screening warnings', () => {
  it('accepts the normal 05:00–13:30 shift with a 09:00–09:30 meal', () => {
    expect(
      derive([
        punch('in', 'shift_in', 0),
        punch('meal-out', 'meal_out', 4 * 3_600),
        punch('meal-in', 'meal_in', 4.5 * 3_600),
        punch('out', 'shift_out', 8.5 * 3_600),
      ]),
    ).toEqual([]);
  });

  it('treats no meal above six worked hours as a review warning, never payable time', () => {
    const result = derive([
      punch('in', 'shift_in', 0),
      punch('out', 'shift_out', 8 * 3_600),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      code: 'first_meal_missing',
      severity: 'warning',
      sourceType: 'employee_workday',
    });
    expect(result[0]?.details).toMatchObject({
      total_worked_seconds: 8 * 3_600,
      screening_only: true,
    });
    expect(result[0]?.details).not.toHaveProperty('premium_seconds');
  });

  it('keeps exactly six worked hours waiver-reviewable', () => {
    expect(
      codes([
        punch('in', 'shift_in', 0),
        punch('out', 'shift_out', 6 * 3_600),
      ]),
    ).toEqual(['first_meal_waiver_review']);
  });

  it('accepts first meal at exactly five elapsed hours and warns one second later', () => {
    const exact = derive([
      punch('in', 'shift_in', 0),
      punch('meal-out', 'meal_out', 5 * 3_600),
      punch('meal-in', 'meal_in', 5.5 * 3_600),
      punch('out', 'shift_out', 8.5 * 3_600),
    ]);
    const late = derive([
      punch('in', 'shift_in', 0),
      punch('meal-out', 'meal_out', 5 * 3_600 + 1),
      punch('meal-in', 'meal_in', 5.5 * 3_600 + 1),
      punch('out', 'shift_out', 8.5 * 3_600 + 1),
    ]);

    expect(exact).toEqual([]);
    expect(late.map((value) => value.code)).toEqual(['first_meal_late']);
  });

  it('warns when the meal is 29:59 and accepts exactly 30:00', () => {
    const short = derive([
      punch('in', 'shift_in', 0),
      punch('meal-out', 'meal_out', 4 * 3_600),
      punch('meal-in', 'meal_in', 4 * 3_600 + 29 * 60 + 59),
      punch('out', 'shift_out', 8.5 * 3_600),
    ]);
    const exact = derive([
      punch('in', 'shift_in', 0),
      punch('meal-out', 'meal_out', 4 * 3_600),
      punch('meal-in', 'meal_in', 4.5 * 3_600),
      punch('out', 'shift_out', 8.5 * 3_600),
    ]);

    expect(short.map((value) => value.code)).toEqual(['first_meal_short']);
    expect(short[0]?.details).toMatchObject({ observed_seconds: 29 * 60 + 59 });
    expect(exact).toEqual([]);
  });

  it('consolidates contiguous plant transfers into one work period', () => {
    const result = derive([
      punch('a-in', 'shift_in', 0, PLANT_A),
      punch('a-out', 'shift_out', 3 * 3_600, PLANT_A),
      punch('b-in', 'shift_in', 3 * 3_600, PLANT_B),
      punch('b-meal-out', 'meal_out', 5 * 3_600, PLANT_B),
      punch('b-meal-in', 'meal_in', 5.5 * 3_600, PLANT_B),
      punch('b-out', 'shift_out', 8.5 * 3_600, PLANT_B),
    ]);

    expect(result).toEqual([]);
  });

  it('keeps an overnight meal with the continuous shift instead of the civil-date OT chunks', () => {
    const result = derive([
      punch('in', 'shift_in', 17 * 3_600), // 22:00
      punch('meal-out', 'meal_out', 21 * 3_600), // 02:00 next day
      punch('meal-in', 'meal_in', 21.5 * 3_600),
      punch('out', 'shift_out', 25.5 * 3_600), // 06:30 next day
    ]);

    expect(result).toEqual([]);
  });

  it('preserves overnight short and late meal warnings across midnight', () => {
    const short = derive([
      punch('short-in', 'shift_in', 17 * 3_600),
      punch('short-meal-out', 'meal_out', 21 * 3_600),
      punch('short-meal-in', 'meal_in', 21 * 3_600 + 29 * 60 + 59),
      punch('short-out', 'shift_out', 25.5 * 3_600),
    ]);
    const late = derive([
      punch('late-in', 'shift_in', 17 * 3_600),
      punch('late-meal-out', 'meal_out', 22 * 3_600 + 1),
      punch('late-meal-in', 'meal_in', 22.5 * 3_600 + 1),
      punch('late-out', 'shift_out', 25.5 * 3_600),
    ]);

    expect(short.map((value) => value.code)).toEqual(['first_meal_short']);
    expect(short[0]?.details.total_worked_seconds).toBe(8 * 3_600 + 1);
    expect(late.map((value) => value.code)).toEqual(['first_meal_late']);
    expect(late[0]?.details.total_worked_seconds).toBe(8 * 3_600);
  });

  it('flags an unexplained split shift for policy review', () => {
    const result = derive([
      punch('first-in', 'shift_in', 0),
      punch('first-out', 'shift_out', 3 * 3_600),
      punch('second-in', 'shift_in', 4 * 3_600),
      punch('second-out', 'shift_out', 7 * 3_600),
    ]);

    expect(result.map((value) => value.code)).toEqual([
      'split_shift_policy_review',
      'first_meal_waiver_review',
    ]);
    expect(result.every((value) => value.severity === 'warning')).toBe(true);
  });
});

describe('scope validation', () => {
  it('rejects non-California screening and reversed ranges instead of guessing', () => {
    expect(() =>
      derivePunchExceptionCandidates({
        organizationId: ORGANIZATION_ID,
        fromDate: WORK_DATE,
        toDate: WORK_DATE,
        timezone: 'America/New_York',
        punches: [],
      }),
    ).toThrow('America/Los_Angeles');

    expect(() =>
      derivePunchExceptionCandidates({
        organizationId: ORGANIZATION_ID,
        fromDate: '2026-07-07',
        toDate: '2026-07-06',
        timezone: TIMEZONE,
        punches: [],
      }),
    ).toThrow('fromDate');
  });
});
