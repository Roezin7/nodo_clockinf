/**
 * Pure California overtime classifier for the standard non-exempt schedule.
 *
 * The caller is responsible for turning punches into non-overlapping work
 * chunks and subtracting unpaid meals. This module deliberately works in
 * whole seconds so payroll classification never depends on display rounding.
 *
 * Policy implemented here:
 * - Workweek: seven dates beginning on the supplied Sunday.
 * - Days 1-6: first 8h regular candidates, >8h through 12h at 1.5x,
 *   and >12h at 2x.
 * - Seventh consecutive worked day in that workweek: first 8h at 1.5x,
 *   then 2x.
 * - After daily classification, regular candidates beyond 40h become 1.5x.
 * - No pyramiding: every second belongs to exactly one pay bucket.
 *
 * This policy does not cover alternative workweeks, collective-bargaining
 * exceptions, exempt employees, or other industry-specific exceptions.
 */

export const CALIFORNIA_HOUR_SECONDS = 60 * 60;
export const CALIFORNIA_DAILY_REGULAR_SECONDS = 8 * CALIFORNIA_HOUR_SECONDS;
export const CALIFORNIA_DAILY_DOUBLE_SECONDS = 12 * CALIFORNIA_HOUR_SECONDS;
export const CALIFORNIA_WEEKLY_REGULAR_SECONDS = 40 * CALIFORNIA_HOUR_SECONDS;

export type CaliforniaWorkSource = 'clock' | 'manual';
export type CaliforniaPayBucket = 'regular' | 'overtime_1_5' | 'double_time';

/**
 * A net-work duration already assigned to a California workday.
 *
 * `order` gives deterministic ordering among chunks of the same source and
 * date. Clock chunks always precede duration-only manual credits; this makes a
 * manual credit behave as time appended to the selected workday. A corrected
 * punch with a real start/end should be converted to a clock chunk instead.
 */
export interface CaliforniaWorkChunk {
  id: string;
  workDate: string;
  durationSeconds: number;
  plantId: string;
  source: CaliforniaWorkSource;
  order: number;
}

export interface CaliforniaBucketTotals {
  regularSeconds: number;
  overtime15Seconds: number;
  doubleTimeSeconds: number;
}

export interface CaliforniaClassifiedPart extends CaliforniaWorkChunk {
  bucket: CaliforniaPayBucket;
  /** Cumulative worked-time offset in the workday, not a wall-clock time. */
  dayWorkedSecondStart: number;
  /** Exclusive cumulative worked-time offset in the workday. */
  dayWorkedSecondEnd: number;
}

export interface CaliforniaDayClassification {
  workDate: string;
  worked: boolean;
  isSeventhConsecutiveDay: boolean;
  totalWorkedSeconds: number;
  totals: CaliforniaBucketTotals;
  byPlant: Record<string, CaliforniaBucketTotals>;
  bySource: Record<CaliforniaWorkSource, CaliforniaBucketTotals>;
  parts: CaliforniaClassifiedPart[];
}

export interface CaliforniaWeekClassification {
  weekStart: string;
  weekEnd: string;
  totalWorkedSeconds: number;
  totals: CaliforniaBucketTotals;
  byPlant: Record<string, CaliforniaBucketTotals>;
  bySource: Record<CaliforniaWorkSource, CaliforniaBucketTotals>;
  days: CaliforniaDayClassification[];
  parts: CaliforniaClassifiedPart[];
}

export interface CaliforniaOvertimeInput {
  /** ISO date for the Sunday beginning the workweek. */
  weekStart: string;
  chunks: readonly CaliforniaWorkChunk[];
}

type InternalBucket = CaliforniaPayBucket | 'regular_candidate';

interface InternalPart extends CaliforniaWorkChunk {
  bucket: InternalBucket;
  dayWorkedSecondStart: number;
  dayWorkedSecondEnd: number;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function parseIsoDate(value: string, label: string): Date {
  if (!ISO_DATE.test(value)) {
    throw new Error(`${label} must be an ISO date (YYYY-MM-DD)`);
  }

  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`${label} must be a valid ISO date`);
  }
  return parsed;
}

function addUtcDays(date: Date, days: number): string {
  const copy = new Date(date.getTime());
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy.toISOString().slice(0, 10);
}

function emptyTotals(): CaliforniaBucketTotals {
  return { regularSeconds: 0, overtime15Seconds: 0, doubleTimeSeconds: 0 };
}

function addToTotals(totals: CaliforniaBucketTotals, bucket: CaliforniaPayBucket, seconds: number): void {
  switch (bucket) {
    case 'regular':
      totals.regularSeconds += seconds;
      break;
    case 'overtime_1_5':
      totals.overtime15Seconds += seconds;
      break;
    case 'double_time':
      totals.doubleTimeSeconds += seconds;
      break;
  }
}

function totalsFor(record: Record<string, CaliforniaBucketTotals>, key: string): CaliforniaBucketTotals {
  const existing = record[key];
  if (existing) return existing;
  const created = emptyTotals();
  record[key] = created;
  return created;
}

function sourceTotals(): Record<CaliforniaWorkSource, CaliforniaBucketTotals> {
  return { clock: emptyTotals(), manual: emptyTotals() };
}

function compareChunks(a: CaliforniaWorkChunk, b: CaliforniaWorkChunk): number {
  const sourceDifference = Number(a.source === 'manual') - Number(b.source === 'manual');
  if (sourceDifference !== 0) return sourceDifference;
  if (a.order !== b.order) return a.order - b.order;
  return a.id.localeCompare(b.id);
}

function validateChunk(chunk: CaliforniaWorkChunk, allowedDates: ReadonlySet<string>, ids: Set<string>): void {
  if (!chunk.id.trim()) throw new Error('chunk id is required');
  if (ids.has(chunk.id)) throw new Error(`duplicate chunk id: ${chunk.id}`);
  ids.add(chunk.id);

  parseIsoDate(chunk.workDate, `chunk ${chunk.id} workDate`);
  if (!allowedDates.has(chunk.workDate)) {
    throw new Error(`chunk ${chunk.id} is outside the supplied workweek`);
  }
  if (!Number.isSafeInteger(chunk.durationSeconds) || chunk.durationSeconds <= 0) {
    throw new Error(`chunk ${chunk.id} durationSeconds must be a positive whole number`);
  }
  if (!chunk.plantId.trim()) throw new Error(`chunk ${chunk.id} plantId is required`);
  if (chunk.source !== 'clock' && chunk.source !== 'manual') {
    throw new Error(`chunk ${chunk.id} has an unsupported source`);
  }
  if (!Number.isSafeInteger(chunk.order)) {
    throw new Error(`chunk ${chunk.id} order must be a safe integer`);
  }
}

function appendInternalPart(
  parts: InternalPart[],
  chunk: CaliforniaWorkChunk,
  bucket: InternalBucket,
  start: number,
  seconds: number,
): void {
  if (seconds <= 0) return;
  parts.push({
    ...chunk,
    durationSeconds: seconds,
    bucket,
    dayWorkedSecondStart: start,
    dayWorkedSecondEnd: start + seconds,
  });
}

function classifyDailyChunk(
  parts: InternalPart[],
  chunk: CaliforniaWorkChunk,
  dayWorkedSeconds: number,
  seventhConsecutiveDay: boolean,
): void {
  let remaining = chunk.durationSeconds;
  let cursor = dayWorkedSeconds;

  const takeUntil = (limit: number, bucket: InternalBucket): void => {
    const seconds = Math.min(remaining, Math.max(0, limit - cursor));
    appendInternalPart(parts, chunk, bucket, cursor, seconds);
    cursor += seconds;
    remaining -= seconds;
  };

  if (seventhConsecutiveDay) {
    takeUntil(CALIFORNIA_DAILY_REGULAR_SECONDS, 'overtime_1_5');
    appendInternalPart(parts, chunk, 'double_time', cursor, remaining);
    return;
  }

  takeUntil(CALIFORNIA_DAILY_REGULAR_SECONDS, 'regular_candidate');
  takeUntil(CALIFORNIA_DAILY_DOUBLE_SECONDS, 'overtime_1_5');
  appendInternalPart(parts, chunk, 'double_time', cursor, remaining);
}

function reconcileWeekly(parts: readonly InternalPart[]): CaliforniaClassifiedPart[] {
  const classified: CaliforniaClassifiedPart[] = [];
  let regularAccepted = 0;

  for (const part of parts) {
    if (part.bucket !== 'regular_candidate') {
      classified.push({ ...part, bucket: part.bucket });
      continue;
    }

    const regularSeconds = Math.min(
      part.durationSeconds,
      Math.max(0, CALIFORNIA_WEEKLY_REGULAR_SECONDS - regularAccepted),
    );

    if (regularSeconds > 0) {
      classified.push({
        ...part,
        durationSeconds: regularSeconds,
        bucket: 'regular',
        dayWorkedSecondEnd: part.dayWorkedSecondStart + regularSeconds,
      });
      regularAccepted += regularSeconds;
    }

    const overtimeSeconds = part.durationSeconds - regularSeconds;
    if (overtimeSeconds > 0) {
      classified.push({
        ...part,
        durationSeconds: overtimeSeconds,
        bucket: 'overtime_1_5',
        dayWorkedSecondStart: part.dayWorkedSecondStart + regularSeconds,
      });
    }
  }

  return classified;
}

function buildDay(
  workDate: string,
  index: number,
  seventhConsecutiveDay: boolean,
  parts: CaliforniaClassifiedPart[],
): CaliforniaDayClassification {
  const dayParts = parts.filter((part) => part.workDate === workDate);
  const totals = emptyTotals();
  const byPlant: Record<string, CaliforniaBucketTotals> = {};
  const bySource = sourceTotals();
  let totalWorkedSeconds = 0;

  for (const part of dayParts) {
    totalWorkedSeconds += part.durationSeconds;
    addToTotals(totals, part.bucket, part.durationSeconds);
    addToTotals(totalsFor(byPlant, part.plantId), part.bucket, part.durationSeconds);
    addToTotals(bySource[part.source], part.bucket, part.durationSeconds);
  }

  return {
    workDate,
    worked: totalWorkedSeconds > 0,
    isSeventhConsecutiveDay: index === 6 && seventhConsecutiveDay,
    totalWorkedSeconds,
    totals,
    byPlant,
    bySource,
    parts: dayParts,
  };
}

/** Classifies one employee's net worked time for one California workweek. */
export function classifyCaliforniaOvertime(input: CaliforniaOvertimeInput): CaliforniaWeekClassification {
  const start = parseIsoDate(input.weekStart, 'weekStart');
  if (start.getUTCDay() !== 0) {
    throw new Error('weekStart must be a Sunday');
  }

  const dates = Array.from({ length: 7 }, (_, index) => addUtcDays(start, index));
  const allowedDates = new Set(dates);
  const ids = new Set<string>();
  const chunksByDate = new Map<string, CaliforniaWorkChunk[]>(dates.map((date) => [date, []]));

  for (const chunk of input.chunks) {
    validateChunk(chunk, allowedDates, ids);
    chunksByDate.get(chunk.workDate)!.push({ ...chunk });
  }

  for (const chunks of chunksByDate.values()) chunks.sort(compareChunks);

  const workedEveryDay = dates.every((date) => {
    const chunks = chunksByDate.get(date)!;
    return chunks.some((chunk) => chunk.durationSeconds > 0);
  });

  const dailyParts: InternalPart[] = [];
  dates.forEach((date, dayIndex) => {
    let dayWorkedSeconds = 0;
    const seventhConsecutiveDay = dayIndex === 6 && workedEveryDay;
    for (const chunk of chunksByDate.get(date)!) {
      classifyDailyChunk(dailyParts, chunk, dayWorkedSeconds, seventhConsecutiveDay);
      dayWorkedSeconds += chunk.durationSeconds;
    }
  });

  const parts = reconcileWeekly(dailyParts);
  const totals = emptyTotals();
  const byPlant: Record<string, CaliforniaBucketTotals> = {};
  const bySource = sourceTotals();
  let totalWorkedSeconds = 0;

  for (const part of parts) {
    totalWorkedSeconds += part.durationSeconds;
    addToTotals(totals, part.bucket, part.durationSeconds);
    addToTotals(totalsFor(byPlant, part.plantId), part.bucket, part.durationSeconds);
    addToTotals(bySource[part.source], part.bucket, part.durationSeconds);
  }

  const inputSeconds = input.chunks.reduce((sum, chunk) => sum + chunk.durationSeconds, 0);
  if (totalWorkedSeconds !== inputSeconds) {
    throw new Error('California overtime invariant failed: classified time does not equal input time');
  }

  return {
    weekStart: dates[0]!,
    weekEnd: dates[6]!,
    totalWorkedSeconds,
    totals,
    byPlant,
    bySource,
    days: dates.map((date, index) => buildDay(date, index, workedEveryDay, parts)),
    parts,
  };
}
