/**
 * Pure punch-to-work-segment extraction.
 *
 * This module deliberately does not know about schedules, tardiness, absences,
 * overtime, or persistence. It receives the non-voided clock punches for one
 * employee, turns only closed portions of work into elapsed-time chunks, and
 * reports every ambiguity that must be resolved before payroll can close.
 *
 * Durations use epoch seconds (timestamps are truncated to their containing
 * second) so every downstream calculation is deterministic and integer-only.
 */
import { DateTime } from 'luxon';

export const CALIFORNIA_WORKDAY_TIMEZONE = 'America/Los_Angeles';

export type WorkSegmentPunchType = 'shift_in' | 'shift_out' | 'meal_out' | 'meal_in';

export interface WorkSegmentPunch {
  id: string;
  type: WorkSegmentPunchType;
  time: Date | string;
  plantId: string;
}

/**
 * Structurally compatible with CaliforniaWorkChunk. Extra interval fields
 * preserve the audit trail needed by timecards and overlap review.
 */
export interface ClockWorkChunk {
  id: string;
  workDate: string;
  durationSeconds: number;
  plantId: string;
  source: 'clock';
  order: number;
  start: string;
  end: string;
  startPunchId: string;
  endPunchId: string;
}

export type WorkSegmentIssueType =
  | 'missing_shift_out'
  | 'missing_meal_in'
  | 'out_of_sequence'
  | 'overlap_between_plants';

export interface WorkSegmentIssue {
  type: WorkSegmentIssueType;
  blocking: true;
  detail: string;
  punchId: string | null;
  relatedPunchIds: string[];
  plantIds: string[];
  start: string | null;
  end: string | null;
  overlapSeconds?: number;
}

export interface WorkSegmentResult {
  chunks: ClockWorkChunk[];
  issues: WorkSegmentIssue[];
  hasBlockingIssues: boolean;
  totalWorkedSeconds: number;
}

interface NormalizedPunch extends Omit<WorkSegmentPunch, 'time'> {
  epochSecond: number;
  inputOrder: number;
}

interface RawInterval {
  plantId: string;
  startSecond: number;
  endSecond: number;
  startPunchId: string;
  endPunchId: string;
}

type PlantState =
  | { name: 'out' }
  | {
      name: 'in';
      shiftIn: NormalizedPunch;
      workStart: NormalizedPunch;
    }
  | {
      name: 'meal';
      shiftIn: NormalizedPunch;
      mealOut: NormalizedPunch;
    };

function iso(second: number): string {
  return new Date(second * 1_000).toISOString();
}

function issue(
  type: WorkSegmentIssueType,
  detail: string,
  options: Partial<Omit<WorkSegmentIssue, 'type' | 'blocking' | 'detail'>> = {},
): WorkSegmentIssue {
  return {
    type,
    blocking: true,
    detail,
    punchId: options.punchId ?? null,
    relatedPunchIds: options.relatedPunchIds ?? [],
    plantIds: options.plantIds ?? [],
    start: options.start ?? null,
    end: options.end ?? null,
    ...(options.overlapSeconds === undefined ? {} : { overlapSeconds: options.overlapSeconds }),
  };
}

function normalizePunches(input: readonly WorkSegmentPunch[]): {
  punches: NormalizedPunch[];
  issues: WorkSegmentIssue[];
} {
  const ids = new Set<string>();
  const issues: WorkSegmentIssue[] = [];
  const punches: NormalizedPunch[] = [];
  let priorMillisecond = Number.NEGATIVE_INFINITY;

  for (const [inputOrder, punch] of input.entries()) {
    if (!punch.id.trim()) throw new Error('punch id is required');
    if (ids.has(punch.id)) throw new Error(`duplicate punch id: ${punch.id}`);
    ids.add(punch.id);
    if (!punch.plantId.trim()) throw new Error(`punch ${punch.id} plantId is required`);

    const parsed = punch.time instanceof Date ? new Date(punch.time.getTime()) : new Date(punch.time);
    const millisecond = parsed.getTime();
    if (!Number.isFinite(millisecond)) throw new Error(`punch ${punch.id} time is invalid`);

    if (millisecond < priorMillisecond) {
      issues.push(
        issue('out_of_sequence', `Punch ${punch.id} is not in chronological input order`, {
          punchId: punch.id,
          relatedPunchIds: [punch.id],
          plantIds: [punch.plantId],
          start: parsed.toISOString(),
        }),
      );
    }
    priorMillisecond = millisecond;
    punches.push({ ...punch, epochSecond: Math.floor(millisecond / 1_000), inputOrder });
  }

  punches.sort((a, b) => a.epochSecond - b.epochSecond || a.inputOrder - b.inputOrder);
  return { punches, issues };
}

function appendInterval(
  intervals: RawInterval[],
  issues: WorkSegmentIssue[],
  start: NormalizedPunch,
  end: NormalizedPunch,
): void {
  if (end.epochSecond <= start.epochSecond) {
    issues.push(
      issue('out_of_sequence', `${end.type} must occur after ${start.type}`, {
        punchId: end.id,
        relatedPunchIds: [start.id, end.id],
        plantIds: [start.plantId],
        start: iso(start.epochSecond),
        end: iso(end.epochSecond),
      }),
    );
    return;
  }

  intervals.push({
    plantId: start.plantId,
    startSecond: start.epochSecond,
    endSecond: end.epochSecond,
    startPunchId: start.id,
    endPunchId: end.id,
  });
}

function buildIntervals(punches: readonly NormalizedPunch[], initialIssues: WorkSegmentIssue[]): {
  intervals: RawInterval[];
  issues: WorkSegmentIssue[];
} {
  const issues = [...initialIssues];
  const intervals: RawInterval[] = [];
  const states = new Map<string, PlantState>();

  for (const punch of punches) {
    const state = states.get(punch.plantId) ?? { name: 'out' as const };

    switch (punch.type) {
      case 'shift_in':
        if (state.name !== 'out') {
          issues.push(
            issue('out_of_sequence', `shift_in while plant ${punch.plantId} is ${state.name}`, {
              punchId: punch.id,
              relatedPunchIds: [state.shiftIn.id, punch.id],
              plantIds: [punch.plantId],
              start: iso(state.shiftIn.epochSecond),
              end: iso(punch.epochSecond),
            }),
          );
          break;
        }
        states.set(punch.plantId, { name: 'in', shiftIn: punch, workStart: punch });
        break;

      case 'meal_out':
        if (state.name !== 'in') {
          issues.push(
            issue('out_of_sequence', `meal_out while plant ${punch.plantId} is ${state.name}`, {
              punchId: punch.id,
              relatedPunchIds: [punch.id],
              plantIds: [punch.plantId],
              start: iso(punch.epochSecond),
            }),
          );
          break;
        }
        appendInterval(intervals, issues, state.workStart, punch);
        states.set(punch.plantId, { name: 'meal', shiftIn: state.shiftIn, mealOut: punch });
        break;

      case 'meal_in':
        if (state.name !== 'meal') {
          issues.push(
            issue('out_of_sequence', `meal_in while plant ${punch.plantId} is ${state.name}`, {
              punchId: punch.id,
              relatedPunchIds: [punch.id],
              plantIds: [punch.plantId],
              start: iso(punch.epochSecond),
            }),
          );
          break;
        }
        if (punch.epochSecond <= state.mealOut.epochSecond) {
          issues.push(
            issue('out_of_sequence', 'meal_in must occur after meal_out', {
              punchId: punch.id,
              relatedPunchIds: [state.mealOut.id, punch.id],
              plantIds: [punch.plantId],
              start: iso(state.mealOut.epochSecond),
              end: iso(punch.epochSecond),
            }),
          );
          break;
        }
        states.set(punch.plantId, { name: 'in', shiftIn: state.shiftIn, workStart: punch });
        break;

      case 'shift_out':
        if (state.name === 'out') {
          issues.push(
            issue('out_of_sequence', `shift_out without shift_in at plant ${punch.plantId}`, {
              punchId: punch.id,
              relatedPunchIds: [punch.id],
              plantIds: [punch.plantId],
              start: iso(punch.epochSecond),
            }),
          );
          break;
        }
        if (state.name === 'meal') {
          issues.push(
            issue('missing_meal_in', `shift_out occurred before meal_in at plant ${punch.plantId}`, {
              punchId: punch.id,
              relatedPunchIds: [state.mealOut.id, punch.id],
              plantIds: [punch.plantId],
              start: iso(state.mealOut.epochSecond),
              end: iso(punch.epochSecond),
            }),
          );
          states.set(punch.plantId, { name: 'out' });
          break;
        }
        appendInterval(intervals, issues, state.workStart, punch);
        states.set(punch.plantId, { name: 'out' });
        break;
    }
  }

  for (const [plantId, state] of states) {
    if (state.name === 'out') continue;
    if (state.name === 'meal') {
      issues.push(
        issue('missing_meal_in', `Missing meal_in at plant ${plantId}`, {
          punchId: state.mealOut.id,
          relatedPunchIds: [state.mealOut.id],
          plantIds: [plantId],
          start: iso(state.mealOut.epochSecond),
        }),
      );
    }
    issues.push(
      issue('missing_shift_out', `Missing shift_out at plant ${plantId}`, {
        punchId: state.shiftIn.id,
        relatedPunchIds: [state.shiftIn.id],
        plantIds: [plantId],
        start: iso(state.shiftIn.epochSecond),
      }),
    );
  }

  intervals.sort(
    (a, b) =>
      a.startSecond - b.startSecond ||
      a.endSecond - b.endSecond ||
      a.plantId.localeCompare(b.plantId) ||
      a.startPunchId.localeCompare(b.startPunchId),
  );
  return { intervals, issues };
}

function detectPlantOverlaps(intervals: readonly RawInterval[]): WorkSegmentIssue[] {
  const issues: WorkSegmentIssue[] = [];
  for (let leftIndex = 0; leftIndex < intervals.length; leftIndex += 1) {
    const left = intervals[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < intervals.length; rightIndex += 1) {
      const right = intervals[rightIndex]!;
      if (right.startSecond >= left.endSecond) break;
      if (left.plantId === right.plantId) continue;

      const overlapStart = Math.max(left.startSecond, right.startSecond);
      const overlapEnd = Math.min(left.endSecond, right.endSecond);
      if (overlapEnd <= overlapStart) continue;

      issues.push(
        issue('overlap_between_plants', `Work intervals overlap at plants ${left.plantId} and ${right.plantId}`, {
          relatedPunchIds: [left.startPunchId, left.endPunchId, right.startPunchId, right.endPunchId],
          plantIds: [left.plantId, right.plantId],
          start: iso(overlapStart),
          end: iso(overlapEnd),
          overlapSeconds: overlapEnd - overlapStart,
        }),
      );
    }
  }
  return issues;
}

function splitIntervalByWorkday(interval: RawInterval): Omit<ClockWorkChunk, 'id' | 'order'>[] {
  const chunks: Omit<ClockWorkChunk, 'id' | 'order'>[] = [];
  let cursor = interval.startSecond;

  while (cursor < interval.endSecond) {
    const local = DateTime.fromSeconds(cursor, { zone: CALIFORNIA_WORKDAY_TIMEZONE });
    const nextWorkday = local.startOf('day').plus({ days: 1 });
    const nextBoundarySecond = Math.floor(nextWorkday.toSeconds());
    const end = Math.min(interval.endSecond, nextBoundarySecond);
    if (end <= cursor) throw new Error('could not advance California workday boundary');

    chunks.push({
      workDate: local.toISODate()!,
      durationSeconds: end - cursor,
      plantId: interval.plantId,
      source: 'clock',
      start: iso(cursor),
      end: iso(end),
      startPunchId: interval.startPunchId,
      endPunchId: interval.endPunchId,
    });
    cursor = end;
  }

  return chunks;
}

/**
 * Converts chronological, valid/non-voided punches into net clock chunks.
 * Operational ambiguities are returned as blocking issues instead of being
 * guessed. Chunks may still contain the unambiguous portions of an incomplete
 * shift; callers must not close payroll while `hasBlockingIssues` is true.
 */
export function buildWorkSegments(input: readonly WorkSegmentPunch[]): WorkSegmentResult {
  const normalized = normalizePunches(input);
  const built = buildIntervals(normalized.punches, normalized.issues);
  const issues = [...built.issues, ...detectPlantOverlaps(built.intervals)];

  const unsortedChunks = built.intervals.flatMap(splitIntervalByWorkday);
  unsortedChunks.sort(
    (a, b) =>
      a.start.localeCompare(b.start) ||
      a.end.localeCompare(b.end) ||
      a.plantId.localeCompare(b.plantId) ||
      a.startPunchId.localeCompare(b.startPunchId),
  );

  const chunks: ClockWorkChunk[] = unsortedChunks.map((chunk, order) => ({
    ...chunk,
    id: `clock:${chunk.startPunchId}:${chunk.endPunchId}:${chunk.workDate}:${order}`,
    order,
  }));
  const totalWorkedSeconds = chunks.reduce((total, chunk) => total + chunk.durationSeconds, 0);

  return {
    chunks,
    issues,
    hasBlockingIssues: issues.length > 0,
    totalWorkedSeconds,
  };
}
