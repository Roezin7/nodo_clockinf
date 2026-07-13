/**
 * Pure California meal-period screening for one employee workday.
 *
 * This module intentionally produces review warnings, not legal conclusions.
 * It never adds a meal premium, changes payable time, or accepts duration-only
 * manual credits. The caller supplies absolute clock-work intervals and
 * explicit off-duty meal intervals for one operational `workDate`.
 *
 * Contract and boundary rules:
 * - Eligibility uses exact elapsed work seconds, after excluding meals.
 * - The first-meal deadline is five elapsed clock hours from the first entry.
 * - The second-meal deadline is ten elapsed clock hours from the first entry.
 * - A meal is long enough at exactly 30 minutes.
 * - More than five worked hours requires a first meal. With no first meal,
 *   more than five through exactly six hours is sent to waiver review; more
 *   than six hours is reported missing.
 * - More than ten worked hours requires a second meal. With no second meal,
 *   more than ten through exactly twelve hours is waiver-reviewable only when
 *   the first meal was actually taken for at least 30 minutes. Above twelve
 *   hours, or when the first meal was absent/short, it is reported missing.
 * - Multiple contiguous work intervals (including a plant transfer) form one
 *   work period. A gap not completely explained by declared meal intervals is
 *   ambiguous split-shift policy and always requires review.
 *
 * Timestamps are normalized to their containing epoch second. Because all
 * duration/deadline math is performed between absolute instants, overnight
 * and daylight-saving transitions neither invent nor remove elapsed time.
 * `workDate` is the caller's operational grouping key; intervals may cross a
 * civil midnight and are not clipped here.
 */

import { DateTime } from 'luxon';

export const MEAL_HOUR_SECONDS = 60 * 60;
export const MINIMUM_MEAL_SECONDS = 30 * 60;
export const FIRST_MEAL_DEADLINE_SECONDS = 5 * MEAL_HOUR_SECONDS;
export const FIRST_MEAL_WAIVER_LIMIT_SECONDS = 6 * MEAL_HOUR_SECONDS;
export const SECOND_MEAL_DEADLINE_SECONDS = 10 * MEAL_HOUR_SECONDS;
export const SECOND_MEAL_WAIVER_LIMIT_SECONDS = 12 * MEAL_HOUR_SECONDS;

export interface MealComplianceWorkInterval {
  id: string;
  /** Absolute instant (`Date` or ISO-8601 string with `Z`/numeric offset). */
  start: Date | string;
  /** Absolute instant (`Date` or ISO-8601 string with `Z`/numeric offset). */
  end: Date | string;
  plantId: string;
}

export interface MealComplianceMealInterval {
  id: string;
  /** Absolute instant (`Date` or ISO-8601 string with `Z`/numeric offset). */
  start: Date | string;
  /** Absolute instant (`Date` or ISO-8601 string with `Z`/numeric offset). */
  end: Date | string;
  /** Plant at which the meal was recorded, when known. */
  plantId?: string;
}

export interface MealComplianceInput {
  /** ISO date used to group this employee's operational workday. */
  workDate: string;
  /** IANA zone used to validate the local date of the first entry. */
  timezone: string;
  /** Actual clock-work only. Duration-only/manual credits do not belong here. */
  workIntervals: readonly MealComplianceWorkInterval[];
  /** Explicit, off-duty meal intervals; these must not overlap clock work. */
  mealIntervals: readonly MealComplianceMealInterval[];
}

export type MealComplianceWarningCode =
  | 'split_shift_policy_review'
  | 'first_meal_waiver_review'
  | 'first_meal_missing'
  | 'first_meal_short'
  | 'first_meal_late'
  | 'second_meal_waiver_review'
  | 'second_meal_missing'
  | 'second_meal_short'
  | 'second_meal_late';

/**
 * Structured warning facts. `observedSeconds` is the value compared with
 * `thresholdSeconds`: uncovered gap, worked time, meal duration, or elapsed
 * deadline time depending on the warning code. UI copy is deliberately kept
 * outside the pure legal-screening engine.
 */
export interface MealComplianceWarning {
  key: string;
  code: MealComplianceWarningCode;
  requiresReview: true;
  mealNumber: 1 | 2 | null;
  mealIntervalId: string | null;
  thresholdSeconds: number;
  observedSeconds: number;
  relatedIntervalIds: string[];
  plantIds: string[];
}

export interface ScreenedMealInterval {
  id: string;
  ordinal: number;
  start: string;
  end: string;
  durationSeconds: number;
  elapsedFromPeriodStartSeconds: number;
  plantId: string | null;
}

export interface MealComplianceResult {
  workDate: string;
  timezone: string;
  periodStartedAt: string;
  totalWorkedSeconds: number;
  meals: ScreenedMealInterval[];
  warnings: MealComplianceWarning[];
  requiresReview: boolean;
}

interface NormalizedInterval {
  id: string;
  startSecond: number;
  endSecond: number;
  plantId: string | null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ABSOLUTE_ISO_SUFFIX = /(?:[zZ]|[+-]\d{2}:\d{2})$/;

const WARNING_ORDER: Record<MealComplianceWarningCode, number> = {
  split_shift_policy_review: 0,
  first_meal_waiver_review: 1,
  first_meal_missing: 2,
  first_meal_short: 3,
  first_meal_late: 4,
  second_meal_waiver_review: 5,
  second_meal_missing: 6,
  second_meal_short: 7,
  second_meal_late: 8,
};

function normalizeInstant(value: Date | string, label: string): number {
  if (typeof value === 'string' && !ABSOLUTE_ISO_SUFFIX.test(value)) {
    throw new Error(`${label} must be an absolute ISO timestamp with Z or a numeric offset`);
  }

  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  const milliseconds = parsed.getTime();
  if (!Number.isFinite(milliseconds)) throw new Error(`${label} is invalid`);
  return Math.floor(milliseconds / 1_000);
}

function normalizeIntervals(
  intervals: readonly (MealComplianceWorkInterval | MealComplianceMealInterval)[],
  kind: 'work' | 'meal',
  allIds: Set<string>,
): NormalizedInterval[] {
  const normalized = intervals.map((interval) => {
    if (!interval.id.trim()) throw new Error(`${kind} interval id is required`);
    if (allIds.has(interval.id)) throw new Error(`duplicate interval id: ${interval.id}`);
    allIds.add(interval.id);

    if (kind === 'work' && (!interval.plantId || !interval.plantId.trim())) {
      throw new Error(`work interval ${interval.id} plantId is required`);
    }
    if (interval.plantId !== undefined && !interval.plantId.trim()) {
      throw new Error(`${kind} interval ${interval.id} plantId cannot be blank`);
    }

    const startSecond = normalizeInstant(interval.start, `${kind} interval ${interval.id} start`);
    const endSecond = normalizeInstant(interval.end, `${kind} interval ${interval.id} end`);
    if (endSecond <= startSecond) {
      throw new Error(`${kind} interval ${interval.id} end must be after start`);
    }

    return {
      id: interval.id,
      startSecond,
      endSecond,
      plantId: interval.plantId ?? null,
    };
  });

  normalized.sort(
    (a, b) => a.startSecond - b.startSecond || a.endSecond - b.endSecond || a.id.localeCompare(b.id),
  );

  for (let index = 1; index < normalized.length; index += 1) {
    const prior = normalized[index - 1]!;
    const current = normalized[index]!;
    if (current.startSecond < prior.endSecond) {
      throw new Error(`${kind} intervals ${prior.id} and ${current.id} overlap`);
    }
  }

  return normalized;
}

function validateWorkDateAndTimezone(workDate: string, timezone: string, periodStartSecond: number): void {
  if (!ISO_DATE.test(workDate)) throw new Error('workDate must be an ISO date (YYYY-MM-DD)');
  if (!timezone.trim()) throw new Error('timezone is required');

  const localMidnight = DateTime.fromISO(`${workDate}T00:00:00`, { zone: timezone });
  if (!localMidnight.isValid || localMidnight.toISODate() !== workDate) {
    throw new Error('workDate/timezone combination is invalid');
  }

  const actualStartDate = DateTime.fromSeconds(periodStartSecond, { zone: timezone }).toISODate();
  if (actualStartDate !== workDate) {
    throw new Error('workDate must equal the local date of the first work interval');
  }
}

function assertMealsDoNotOverlapWork(
  workIntervals: readonly NormalizedInterval[],
  meals: readonly NormalizedInterval[],
  periodStartSecond: number,
): void {
  for (const meal of meals) {
    if (meal.startSecond < periodStartSecond) {
      throw new Error(`meal interval ${meal.id} cannot start before the work period`);
    }
    for (const work of workIntervals) {
      if (meal.startSecond < work.endSecond && work.startSecond < meal.endSecond) {
        throw new Error(`meal interval ${meal.id} overlaps work interval ${work.id}`);
      }
    }
  }
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function allPlantIds(work: readonly NormalizedInterval[], meals: readonly NormalizedInterval[]): string[] {
  return sortedUnique(
    [...work, ...meals].flatMap((interval) => (interval.plantId === null ? [] : [interval.plantId])),
  );
}

function uncoveredGapFacts(
  work: readonly NormalizedInterval[],
  meals: readonly NormalizedInterval[],
): { uncoveredSeconds: number; relatedIntervalIds: string[]; plantIds: string[] } {
  let uncoveredSeconds = 0;
  const relatedIntervalIds: string[] = [];
  const plantIds: string[] = [];

  for (let index = 1; index < work.length; index += 1) {
    const prior = work[index - 1]!;
    const current = work[index]!;
    if (current.startSecond === prior.endSecond) continue;

    const gapStart = prior.endSecond;
    const gapEnd = current.startSecond;
    let explainedSeconds = 0;
    const explainingMeals: string[] = [];

    for (const meal of meals) {
      const coveredStart = Math.max(gapStart, meal.startSecond);
      const coveredEnd = Math.min(gapEnd, meal.endSecond);
      if (coveredEnd > coveredStart) {
        explainedSeconds += coveredEnd - coveredStart;
        explainingMeals.push(meal.id);
      }
    }

    const unexplained = gapEnd - gapStart - explainedSeconds;
    if (unexplained <= 0) continue;
    uncoveredSeconds += unexplained;
    relatedIntervalIds.push(prior.id, current.id, ...explainingMeals);
    if (prior.plantId !== null) plantIds.push(prior.plantId);
    if (current.plantId !== null) plantIds.push(current.plantId);
  }

  return {
    uncoveredSeconds,
    relatedIntervalIds: sortedUnique(relatedIntervalIds),
    plantIds: sortedUnique(plantIds),
  };
}

function warningKey(workDate: string, code: MealComplianceWarningCode): string {
  return `${workDate}:${code}`;
}

/**
 * Screens one employee workday. Every returned warning is unique by `key` and
 * follows a fixed ordering, independent of the caller's interval ordering.
 */
export function screenCaliforniaMealCompliance(input: MealComplianceInput): MealComplianceResult {
  const ids = new Set<string>();
  const work = normalizeIntervals(input.workIntervals, 'work', ids);
  if (work.length === 0) throw new Error('at least one work interval is required');
  const meals = normalizeIntervals(input.mealIntervals, 'meal', ids);

  const periodStartSecond = work[0]!.startSecond;
  validateWorkDateAndTimezone(input.workDate, input.timezone, periodStartSecond);
  assertMealsDoNotOverlapWork(work, meals, periodStartSecond);

  const totalWorkedSeconds = work.reduce(
    (total, interval) => total + interval.endSecond - interval.startSecond,
    0,
  );
  if (!Number.isSafeInteger(totalWorkedSeconds)) throw new Error('total worked seconds exceeds safe range');

  const screenedMeals: ScreenedMealInterval[] = meals.map((meal, index) => ({
    id: meal.id,
    ordinal: index + 1,
    start: new Date(meal.startSecond * 1_000).toISOString(),
    end: new Date(meal.endSecond * 1_000).toISOString(),
    durationSeconds: meal.endSecond - meal.startSecond,
    elapsedFromPeriodStartSeconds: meal.startSecond - periodStartSecond,
    plantId: meal.plantId,
  }));

  const warnings = new Map<string, MealComplianceWarning>();
  const plants = allPlantIds(work, meals);
  const addWarning = (
    code: MealComplianceWarningCode,
    mealNumber: 1 | 2 | null,
    meal: ScreenedMealInterval | undefined,
    thresholdSeconds: number,
    observedSeconds: number,
    relatedIntervalIds: readonly string[] = [],
    plantIds: readonly string[] = plants,
  ): void => {
    const key = warningKey(input.workDate, code);
    if (warnings.has(key)) return;
    warnings.set(key, {
      key,
      code,
      requiresReview: true,
      mealNumber,
      mealIntervalId: meal?.id ?? null,
      thresholdSeconds,
      observedSeconds,
      relatedIntervalIds: sortedUnique(meal ? [meal.id, ...relatedIntervalIds] : relatedIntervalIds),
      plantIds: sortedUnique(plantIds),
    });
  };

  const split = uncoveredGapFacts(work, meals);
  if (split.uncoveredSeconds > 0) {
    addWarning(
      'split_shift_policy_review',
      null,
      undefined,
      0,
      split.uncoveredSeconds,
      split.relatedIntervalIds,
      split.plantIds,
    );
  }

  const firstMeal = screenedMeals[0];
  if (totalWorkedSeconds > FIRST_MEAL_DEADLINE_SECONDS) {
    if (!firstMeal) {
      if (totalWorkedSeconds <= FIRST_MEAL_WAIVER_LIMIT_SECONDS) {
        addWarning(
          'first_meal_waiver_review',
          1,
          undefined,
          FIRST_MEAL_WAIVER_LIMIT_SECONDS,
          totalWorkedSeconds,
          work.map((interval) => interval.id),
        );
      } else {
        addWarning(
          'first_meal_missing',
          1,
          undefined,
          FIRST_MEAL_DEADLINE_SECONDS,
          totalWorkedSeconds,
          work.map((interval) => interval.id),
        );
      }
    } else {
      if (firstMeal.durationSeconds < MINIMUM_MEAL_SECONDS) {
        addWarning(
          'first_meal_short',
          1,
          firstMeal,
          MINIMUM_MEAL_SECONDS,
          firstMeal.durationSeconds,
        );
      }
      if (firstMeal.elapsedFromPeriodStartSeconds > FIRST_MEAL_DEADLINE_SECONDS) {
        addWarning(
          'first_meal_late',
          1,
          firstMeal,
          FIRST_MEAL_DEADLINE_SECONDS,
          firstMeal.elapsedFromPeriodStartSeconds,
        );
      }
    }
  }

  const secondMeal = screenedMeals[1];
  if (totalWorkedSeconds > SECOND_MEAL_DEADLINE_SECONDS) {
    if (!secondMeal) {
      const firstWasTakenAndNotWaived = firstMeal !== undefined && firstMeal.durationSeconds >= MINIMUM_MEAL_SECONDS;
      if (totalWorkedSeconds <= SECOND_MEAL_WAIVER_LIMIT_SECONDS && firstWasTakenAndNotWaived) {
        addWarning(
          'second_meal_waiver_review',
          2,
          undefined,
          SECOND_MEAL_WAIVER_LIMIT_SECONDS,
          totalWorkedSeconds,
          work.map((interval) => interval.id),
        );
      } else {
        addWarning(
          'second_meal_missing',
          2,
          undefined,
          SECOND_MEAL_DEADLINE_SECONDS,
          totalWorkedSeconds,
          work.map((interval) => interval.id),
        );
      }
    } else {
      if (secondMeal.durationSeconds < MINIMUM_MEAL_SECONDS) {
        addWarning(
          'second_meal_short',
          2,
          secondMeal,
          MINIMUM_MEAL_SECONDS,
          secondMeal.durationSeconds,
        );
      }
      if (secondMeal.elapsedFromPeriodStartSeconds > SECOND_MEAL_DEADLINE_SECONDS) {
        addWarning(
          'second_meal_late',
          2,
          secondMeal,
          SECOND_MEAL_DEADLINE_SECONDS,
          secondMeal.elapsedFromPeriodStartSeconds,
        );
      }
    }
  }

  const orderedWarnings = [...warnings.values()].sort(
    (a, b) => WARNING_ORDER[a.code] - WARNING_ORDER[b.code] || a.key.localeCompare(b.key),
  );

  return {
    workDate: input.workDate,
    timezone: input.timezone,
    periodStartedAt: new Date(periodStartSecond * 1_000).toISOString(),
    totalWorkedSeconds,
    meals: screenedMeals,
    warnings: orderedWarnings,
    requiresReview: orderedWarnings.length > 0,
  };
}
