import crypto from 'node:crypto';
import { DateTime } from 'luxon';
import type { PoolClient } from 'pg';
import { canonicalJson, weekBoundsForDate } from './payPeriodService.js';
import { deviceHealthReasons } from './deviceHealth.js';
import {
  screenCaliforniaMealCompliance,
  type MealComplianceMealInterval,
} from './mealCompliance.js';
import {
  buildWorkSegments,
  type ClockWorkChunk,
  type WorkSegmentIssue,
} from './workSegments.js';

export const OPERATIONAL_EXCEPTION_CODES = [
  'missing_shift_out',
  'missing_meal_in',
  'out_of_sequence',
  'overlap_between_plants',
  'negative_duration',
  'invalid_manual_time',
  'split_shift_policy_review',
  'first_meal_waiver_review',
  'first_meal_missing',
  'first_meal_short',
  'first_meal_late',
  'second_meal_waiver_review',
  'second_meal_missing',
  'second_meal_short',
  'second_meal_late',
  'identity_review',
  'device_unhealthy',
] as const;

export type OperationalExceptionCode = (typeof OPERATIONAL_EXCEPTION_CODES)[number];
export type OperationalExceptionSeverity = 'blocker' | 'warning';
export type OperationalExceptionSourceType =
  | 'punch_sequence'
  | 'employee_workday'
  | 'manual_time'
  | 'identity_session'
  | 'device';
export type OperationalExceptionStatus = 'open' | 'acknowledged' | 'resolved';

export interface OperationalPunchInput {
  id: string;
  employeeId: string;
  punchType: 'shift_in' | 'shift_out' | 'meal_out' | 'meal_in';
  punchedAt: Date | string;
  plantId: string;
  /** Scheduled end for this shift-in, when the employee has a default shift. */
  expectedShiftEndAt?: Date | string | null;
}

export interface OperationalExceptionCandidate {
  organizationId: string;
  dedupeKey: string;
  code: OperationalExceptionCode;
  severity: OperationalExceptionSeverity;
  sourceType: OperationalExceptionSourceType;
  sourceKey: string;
  sourceFingerprint: string;
  employeeId: string | null;
  workDate: string | null;
  occurredAt: string;
  plantIds: string[];
  title: string;
  details: Record<string, unknown>;
}

export interface DeriveOperationalExceptionsInput {
  organizationId: string;
  fromDate: string;
  toDate: string;
  timezone: string;
  now?: Date;
  /** Live queues use grace; finalization must set this false. */
  applyOpenSequenceGrace?: boolean;
}

export interface ReconcileOperationalExceptionsResult {
  candidateCount: number;
  opened: number;
  reopened: number;
  refreshed: number;
  resolved: number;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CALIFORNIA_TIMEZONE = 'America/Los_Angeles';
// Una secuencia abierta durante la jornada no es todavía una omisión. La
// asistencia en vivo ya muestra quién sigue dentro; la bandeja de incidencias
// se reserva para aperturas que razonablemente quedaron olvidadas.
const UNSCHEDULED_OPEN_SHIFT_GRACE_SECONDS = 16 * 60 * 60;
const SCHEDULED_SHIFT_OUT_GRACE_SECONDS = 60 * 60;
const OPEN_MEAL_GRACE_SECONDS = 2 * 60 * 60;

const TITLES: Record<OperationalExceptionCode, string> = {
  missing_shift_out: 'Falta checada de salida',
  missing_meal_in: 'Falta regreso de comida',
  out_of_sequence: 'Checadas fuera de secuencia',
  overlap_between_plants: 'Horas traslapadas entre plantas',
  negative_duration: 'Intervalo con duración inválida',
  invalid_manual_time: 'Horas manuales inválidas',
  split_shift_policy_review: 'Turno dividido requiere revisión',
  first_meal_waiver_review: 'Primera comida requiere revisar exención',
  first_meal_missing: 'Primera comida no registrada',
  first_meal_short: 'Primera comida menor a 30 minutos',
  first_meal_late: 'Primera comida tardía',
  second_meal_waiver_review: 'Segunda comida requiere revisar exención',
  second_meal_missing: 'Segunda comida no registrada',
  second_meal_short: 'Segunda comida menor a 30 minutos',
  second_meal_late: 'Segunda comida tardía',
  identity_review: 'Identidad facial pendiente de revisión',
  device_unhealthy: 'Checador requiere atención',
};

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function canonicalExceptionDedupeKey(
  code: OperationalExceptionCode,
  sourceType: OperationalExceptionSourceType,
  sourceKey: string,
): string {
  if (!sourceKey.trim()) throw new Error('exception sourceKey is required');
  return sha256(`operational-exception:v1|${code}|${sourceType}|${sourceKey}`);
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function iso(value: Date | string): string {
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error('invalid exception timestamp');
  return parsed.toISOString();
}

function assertRange(fromDate: string, toDate: string, timezone: string): void {
  if (!DATE_RE.test(fromDate) || !DATE_RE.test(toDate)) {
    throw new Error('operational exception dates must use YYYY-MM-DD');
  }
  if (timezone !== CALIFORNIA_TIMEZONE) {
    throw new Error(`operational exception screening requires ${CALIFORNIA_TIMEZONE}`);
  }
  const from = DateTime.fromISO(fromDate, { zone: timezone });
  const to = DateTime.fromISO(toDate, { zone: timezone });
  if (!from.isValid || !to.isValid || from.toISODate() !== fromDate || to.toISODate() !== toDate) {
    throw new Error('operational exception date range is invalid');
  }
  if (from.toMillis() > to.toMillis()) throw new Error('fromDate must not be after toDate');
}

function dateInRange(date: string | null, fromDate: string, toDate: string): boolean {
  return date !== null && date >= fromDate && date <= toDate;
}

function localDate(value: Date | string, timezone: string): string {
  const date = DateTime.fromJSDate(new Date(value)).setZone(timezone).toISODate();
  if (!date) throw new Error('could not derive local work date');
  return date;
}

interface CandidateFields {
  organizationId: string;
  code: OperationalExceptionCode;
  severity: OperationalExceptionSeverity;
  sourceType: OperationalExceptionSourceType;
  sourceKey: string;
  employeeId?: string | null;
  workDate?: string | null;
  occurredAt: Date | string;
  plantIds: readonly string[];
  details?: Record<string, unknown>;
  /** Stable semantic facts for noisy projections such as device heartbeat. */
  fingerprintFacts?: Record<string, unknown>;
}

function candidate(fields: CandidateFields): OperationalExceptionCandidate {
  const plantIds = sortedUnique(fields.plantIds);
  const details = fields.details ?? {};
  const occurredAt = iso(fields.occurredAt);
  const sourceFingerprint = sha256(
    canonicalJson({
      code: fields.code,
      severity: fields.severity,
      sourceType: fields.sourceType,
      sourceKey: fields.sourceKey,
      employeeId: fields.employeeId ?? null,
      workDate: fields.workDate ?? null,
      plantIds,
      ...(fields.fingerprintFacts
        ? { fingerprintFacts: fields.fingerprintFacts }
        : { occurredAt, details }),
    }),
  );
  return {
    organizationId: fields.organizationId,
    dedupeKey: canonicalExceptionDedupeKey(fields.code, fields.sourceType, fields.sourceKey),
    code: fields.code,
    severity: fields.severity,
    sourceType: fields.sourceType,
    sourceKey: fields.sourceKey,
    sourceFingerprint,
    employeeId: fields.employeeId ?? null,
    workDate: fields.workDate ?? null,
    occurredAt,
    plantIds,
    title: TITLES[fields.code],
    details,
  };
}

function issueDate(
  issue: WorkSegmentIssue,
  punchById: ReadonlyMap<string, OperationalPunchInput>,
  timezone: string,
): string | null {
  if (issue.start) return localDate(issue.start, timezone);
  const relatedId = issue.punchId ?? issue.relatedPunchIds[0];
  const related = relatedId ? punchById.get(relatedId) : undefined;
  return related ? localDate(related.punchedAt, timezone) : null;
}

function issueOccurredAt(
  issue: WorkSegmentIssue,
  punchById: ReadonlyMap<string, OperationalPunchInput>,
  workDate: string,
  timezone: string,
): string {
  if (issue.start) return iso(issue.start);
  const relatedId = issue.punchId ?? issue.relatedPunchIds[0];
  const related = relatedId ? punchById.get(relatedId) : undefined;
  if (related) return iso(related.punchedAt);
  return DateTime.fromISO(`${workDate}T00:00:00`, { zone: timezone }).toUTC().toISO()!;
}

function structuralCandidate(
  organizationId: string,
  employeeId: string,
  issue: WorkSegmentIssue,
  punchById: ReadonlyMap<string, OperationalPunchInput>,
  fromDate: string,
  toDate: string,
  timezone: string,
): OperationalExceptionCandidate[] {
  const workDate = issueDate(issue, punchById, timezone);
  if (!dateInRange(workDate, fromDate, toDate)) return [];
  const relatedPunchIds = sortedUnique(
    [...issue.relatedPunchIds, ...(issue.punchId ? [issue.punchId] : [])],
  );
  const sourceKey = `${employeeId}:${issue.type}:${relatedPunchIds.join(',')}:${issue.start ?? ''}`;
  const base = candidate({
    organizationId,
    code: issue.type,
    severity: 'blocker',
    sourceType: 'punch_sequence',
    sourceKey,
    employeeId,
    workDate,
    occurredAt: issueOccurredAt(issue, punchById, workDate!, timezone),
    plantIds: issue.plantIds,
    details: {
      detail: issue.detail,
      punch_id: issue.punchId,
      related_punch_ids: relatedPunchIds,
      start: issue.start,
      end: issue.end,
      ...(issue.overlapSeconds === undefined ? {} : { overlap_seconds: issue.overlapSeconds }),
    },
  });

  if (
    issue.type === 'out_of_sequence' &&
    issue.start !== null &&
    issue.end !== null &&
    new Date(issue.end).getTime() <= new Date(issue.start).getTime()
  ) {
    return [
      base,
      candidate({
        organizationId,
        code: 'negative_duration',
        severity: 'blocker',
        sourceType: 'punch_sequence',
        sourceKey: `${employeeId}:negative:${relatedPunchIds.join(',')}`,
        employeeId,
        workDate,
        occurredAt: issue.start,
        plantIds: issue.plantIds,
        details: {
          related_punch_ids: relatedPunchIds,
          start: issue.start,
          end: issue.end,
        },
      }),
    ];
  }
  return [base];
}

interface MealPairState {
  shiftWorkDate: string;
  pendingMeal: OperationalPunchInput | null;
}

interface PairedMealPeriods {
  mealsByDate: Map<string, MealComplianceMealInterval[]>;
  workDateByStartPunch: Map<string, string>;
}

function pairMeals(
  punches: readonly OperationalPunchInput[],
  timezone: string,
): PairedMealPeriods {
  const stateByPlant = new Map<string, MealPairState>();
  const mealsByDate = new Map<string, MealComplianceMealInterval[]>();
  // Work chunks begin at either shift_in or meal_in. Preserve the owning
  // shift date for both so civil-midnight OT splits do not split meal review.
  const workDateByStartPunch = new Map<string, string>();

  for (const punch of punches) {
    switch (punch.punchType) {
      case 'shift_in':
        if (!stateByPlant.has(punch.plantId)) {
          const shiftWorkDate = localDate(punch.punchedAt, timezone);
          stateByPlant.set(punch.plantId, {
            shiftWorkDate,
            pendingMeal: null,
          });
          workDateByStartPunch.set(punch.id, shiftWorkDate);
        }
        break;
      case 'meal_out': {
        const state = stateByPlant.get(punch.plantId);
        if (state && !state.pendingMeal) state.pendingMeal = punch;
        break;
      }
      case 'meal_in': {
        const state = stateByPlant.get(punch.plantId);
        if (!state?.pendingMeal) break;
        const values = mealsByDate.get(state.shiftWorkDate) ?? [];
        values.push({
          id: `meal:${state.pendingMeal.id}:${punch.id}`,
          start: state.pendingMeal.punchedAt,
          end: punch.punchedAt,
          plantId: punch.plantId,
        });
        mealsByDate.set(state.shiftWorkDate, values);
        workDateByStartPunch.set(punch.id, state.shiftWorkDate);
        state.pendingMeal = null;
        break;
      }
      case 'shift_out':
        stateByPlant.delete(punch.plantId);
        break;
    }
  }
  return { mealsByDate, workDateByStartPunch };
}

function mealCandidates(
  organizationId: string,
  employeeId: string,
  chunks: readonly ClockWorkChunk[],
  structuralIssueDates: ReadonlySet<string>,
  mealsByDate: ReadonlyMap<string, MealComplianceMealInterval[]>,
  workDateByStartPunch: ReadonlyMap<string, string>,
  fromDate: string,
  toDate: string,
  timezone: string,
): OperationalExceptionCandidate[] {
  const chunksByDate = new Map<string, ClockWorkChunk[]>();
  for (const chunk of chunks) {
    // buildWorkSegments splits payable chunks at civil midnight for daily OT.
    // Meal rules follow the continuous work period instead. Both halves of an
    // overnight interval retain the same shift-in punch, so own them by that
    // punch's local date and preserve the meal recorded after midnight.
    const periodWorkDate = workDateByStartPunch.get(chunk.startPunchId) ?? chunk.workDate;
    if (!dateInRange(periodWorkDate, fromDate, toDate)) continue;
    const values = chunksByDate.get(periodWorkDate) ?? [];
    values.push(chunk);
    chunksByDate.set(periodWorkDate, values);
  }

  const result: OperationalExceptionCandidate[] = [];
  for (const [workDate, dayChunks] of chunksByDate) {
    // Meal screening is not a repair mechanism. Structural ambiguity must be
    // corrected first instead of guessing a compliance result from bad time.
    if (structuralIssueDates.has(workDate) || dayChunks.length === 0) continue;
    const sortedChunks = [...dayChunks].sort((left, right) => left.start.localeCompare(right.start));
    const firstStart = sortedChunks[0]!.start;
    const lastEnd = sortedChunks.reduce(
      (latest, chunk) => (chunk.end > latest ? chunk.end : latest),
      sortedChunks[0]!.end,
    );
    const meals = (mealsByDate.get(workDate) ?? []).filter((meal) => {
      const start = iso(meal.start);
      const end = iso(meal.end);
      return start >= firstStart && end <= lastEnd && end > start;
    });

    let screened;
    try {
      screened = screenCaliforniaMealCompliance({
        workDate,
        timezone,
        workIntervals: sortedChunks.map((chunk) => ({
          id: chunk.id,
          start: chunk.start,
          end: chunk.end,
          plantId: chunk.plantId,
        })),
        mealIntervals: meals,
      });
    } catch (error) {
      result.push(
        candidate({
          organizationId,
          code: 'out_of_sequence',
          severity: 'blocker',
          sourceType: 'employee_workday',
          sourceKey: `${employeeId}:${workDate}:meal-screen-input`,
          employeeId,
          workDate,
          occurredAt: firstStart,
          plantIds: sortedChunks.map((chunk) => chunk.plantId),
          details: {
            screening_error: error instanceof Error ? error.message : 'invalid meal screening input',
            work_interval_ids: sortedChunks.map((chunk) => chunk.id),
            meal_interval_ids: meals.map((meal) => meal.id),
          },
        }),
      );
      continue;
    }

    for (const warning of screened.warnings) {
      const meal = screened.meals.find((entry) => entry.id === warning.mealIntervalId);
      result.push(
        candidate({
          organizationId,
          code: warning.code,
          severity: 'warning',
          sourceType: 'employee_workday',
          sourceKey: `${employeeId}:${warning.key}`,
          employeeId,
          workDate,
          occurredAt: meal?.start ?? screened.periodStartedAt,
          plantIds: warning.plantIds,
          details: {
            meal_number: warning.mealNumber,
            meal_interval_id: warning.mealIntervalId,
            threshold_seconds: warning.thresholdSeconds,
            observed_seconds: warning.observedSeconds,
            related_interval_ids: warning.relatedIntervalIds,
            total_worked_seconds: screened.totalWorkedSeconds,
            screening_only: true,
          },
        }),
      );
    }
  }
  return result;
}

/**
 * Pure punch projection used by unit tests and by the database derivation.
 * It returns facts only and never writes, voids, or creates payable time.
 */
export function derivePunchExceptionCandidates(input: {
  organizationId: string;
  fromDate: string;
  toDate: string;
  timezone: string;
  punches: readonly OperationalPunchInput[];
  now?: Date;
  applyOpenSequenceGrace?: boolean;
}): OperationalExceptionCandidate[] {
  assertRange(input.fromDate, input.toDate, input.timezone);
  const byEmployee = new Map<string, OperationalPunchInput[]>();
  for (const punch of input.punches) {
    const values = byEmployee.get(punch.employeeId) ?? [];
    values.push(punch);
    byEmployee.set(punch.employeeId, values);
  }

  const result: OperationalExceptionCandidate[] = [];
  for (const [employeeId, unsorted] of byEmployee) {
    const punches = [...unsorted].sort(
      (left, right) =>
        new Date(left.punchedAt).getTime() - new Date(right.punchedAt).getTime() ||
        left.id.localeCompare(right.id),
    );
    const punchById = new Map(punches.map((punch) => [punch.id, punch]));
    const segments = buildWorkSegments(
      punches.map((punch) => ({
        id: punch.id,
        type: punch.punchType,
        time: punch.punchedAt,
        plantId: punch.plantId,
      })),
    );
    const structuralIssueDates = new Set<string>();
    for (const issue of segments.issues) {
      if (input.applyOpenSequenceGrace !== false && issue.end === null && issue.start) {
        const nowMs = (input.now ?? new Date()).getTime();
        const startMs = new Date(issue.start).getTime();
        const elapsedSeconds = Math.floor(
          (nowMs - startMs) / 1_000,
        );
        if (issue.type === 'missing_shift_out') {
          const relatedId = issue.punchId ?? issue.relatedPunchIds[0];
          const expectedValue = relatedId ? punchById.get(relatedId)?.expectedShiftEndAt : null;
          const expectedMs = expectedValue ? new Date(expectedValue).getTime() : Number.NaN;
          if (Number.isFinite(expectedMs) && expectedMs > startMs) {
            if (nowMs < expectedMs + SCHEDULED_SHIFT_OUT_GRACE_SECONDS * 1_000) continue;
          } else if (elapsedSeconds < UNSCHEDULED_OPEN_SHIFT_GRACE_SECONDS) {
            continue;
          }
        } else if (issue.type === 'missing_meal_in' && elapsedSeconds < OPEN_MEAL_GRACE_SECONDS) {
          continue;
        }
      }
      const date = issueDate(issue, punchById, input.timezone);
      if (date) structuralIssueDates.add(date);
      result.push(
        ...structuralCandidate(
          input.organizationId,
          employeeId,
          issue,
          punchById,
          input.fromDate,
          input.toDate,
          input.timezone,
        ),
      );
    }
    const pairedMeals = pairMeals(punches, input.timezone);
    result.push(
      ...mealCandidates(
        input.organizationId,
        employeeId,
        segments.chunks,
        structuralIssueDates,
        pairedMeals.mealsByDate,
        pairedMeals.workDateByStartPunch,
        input.fromDate,
        input.toDate,
        input.timezone,
      ),
    );
  }
  return dedupeAndSortCandidates(result);
}

function dedupeAndSortCandidates(
  values: readonly OperationalExceptionCandidate[],
): OperationalExceptionCandidate[] {
  const byKey = new Map<string, OperationalExceptionCandidate>();
  for (const value of values) {
    const prior = byKey.get(value.dedupeKey);
    if (prior && prior.sourceFingerprint !== value.sourceFingerprint) {
      throw new Error(`conflicting operational exception candidate ${value.dedupeKey}`);
    }
    byKey.set(value.dedupeKey, value);
  }
  return [...byKey.values()].sort(
    (left, right) =>
      (left.workDate ?? '').localeCompare(right.workDate ?? '') ||
      left.occurredAt.localeCompare(right.occurredAt) ||
      left.dedupeKey.localeCompare(right.dedupeKey),
  );
}

interface PunchDbRow {
  id: string;
  employee_id: string;
  punch_type: OperationalPunchInput['punchType'];
  punched_at: Date;
  plant_id: string;
  expected_shift_end_at: Date | null;
}

async function derivePunchCandidatesFromDatabase(
  client: PoolClient,
  input: DeriveOperationalExceptionsInput,
): Promise<OperationalExceptionCandidate[]> {
  const result = await client.query<PunchDbRow>(
    `SELECT p.id, p.employee_id, p.punch_type, p.punched_at, p.plant_id,
            CASE
              WHEN p.punch_type = 'shift_in' AND s.id IS NOT NULL THEN
                (
                  (p.punched_at AT TIME ZONE $4)::date + s.end_time
                  + CASE WHEN s.end_time <= s.start_time
                         THEN interval '1 day' ELSE interval '0 days' END
                ) AT TIME ZONE $4
              ELSE NULL
            END AS expected_shift_end_at
     FROM punches p
     JOIN employees e
       ON e.id = p.employee_id AND e.organization_id = p.organization_id
     LEFT JOIN shifts s
       ON s.id = e.default_shift_id AND s.organization_id = e.organization_id
     WHERE p.organization_id = $1
       AND NOT p.voided
       AND (p.punched_at AT TIME ZONE $4)::date
           BETWEEN ($2::date - 1) AND ($3::date + 1)
     ORDER BY p.employee_id, p.punched_at, p.created_at, p.id`,
    [input.organizationId, input.fromDate, input.toDate, input.timezone],
  );
  return derivePunchExceptionCandidates({
    organizationId: input.organizationId,
    fromDate: input.fromDate,
    toDate: input.toDate,
    timezone: input.timezone,
    now: input.now,
    applyOpenSequenceGrace: input.applyOpenSequenceGrace,
    punches: result.rows.map((row) => ({
      id: row.id,
      employeeId: row.employee_id,
      punchType: row.punch_type,
      punchedAt: row.punched_at,
      plantId: row.plant_id,
      expectedShiftEndAt: row.expected_shift_end_at,
    })),
  });
}

interface IdentityReviewDbRow {
  session_id: string;
  punch_id: string;
  employee_id: string;
  plant_id: string;
  punched_at: Date;
  review_reason: string | null;
  similarity: string | number | null;
}

async function deriveIdentityCandidates(
  client: PoolClient,
  input: DeriveOperationalExceptionsInput,
): Promise<OperationalExceptionCandidate[]> {
  const result = await client.query<IdentityReviewDbRow>(
    `SELECT s.id AS session_id, p.id AS punch_id, p.employee_id, p.plant_id,
            p.punched_at, s.review_reason, s.similarity
     FROM punches p
     JOIN identity_sessions s
       ON s.id = p.identity_session_id
      AND s.organization_id = p.organization_id
     WHERE p.organization_id = $1
       AND NOT p.voided
       AND p.identity_status = 'identity_review'
       AND (p.punched_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date
     ORDER BY p.punched_at, p.id`,
    [input.organizationId, input.fromDate, input.toDate, input.timezone],
  );
  return result.rows.map((row) =>
    candidate({
      organizationId: input.organizationId,
      code: 'identity_review',
      severity: 'warning',
      sourceType: 'identity_session',
      sourceKey: row.session_id,
      employeeId: row.employee_id,
      workDate: localDate(row.punched_at, input.timezone),
      occurredAt: row.punched_at,
      plantIds: [row.plant_id],
      details: {
        identity_session_id: row.session_id,
        punch_id: row.punch_id,
        review_reason: row.review_reason,
        similarity: row.similarity === null ? null : Number(row.similarity),
      },
    }),
  );
}

interface InvalidManualTimeDbRow {
  id: string;
  employee_id: string;
  plant_id: string;
  work_date: string;
  duration_seconds: string | number;
  reason: string;
  created_by: string | null;
  created_at: Date;
}

async function deriveInvalidManualTimeCandidates(
  client: PoolClient,
  input: DeriveOperationalExceptionsInput,
): Promise<OperationalExceptionCandidate[]> {
  // Current constraints make this query normally empty. Keeping the direct
  // validation protects finalization if legacy/import data is loaded with
  // constraints temporarily disabled.
  const result = await client.query<InvalidManualTimeDbRow>(
    `SELECT id, employee_id, plant_id, work_date::text, duration_seconds,
            reason, created_by, created_at
     FROM manual_time_entries
     WHERE organization_id = $1
       AND voided_at IS NULL
       AND work_date BETWEEN $2::date AND $3::date
       AND (
         duration_seconds <= 0
         OR length(trim(reason)) < 3
         OR created_by IS NULL
       )
     ORDER BY work_date, id`,
    [input.organizationId, input.fromDate, input.toDate],
  );
  return result.rows.map((row) =>
    candidate({
      organizationId: input.organizationId,
      code: 'invalid_manual_time',
      severity: 'blocker',
      sourceType: 'manual_time',
      sourceKey: row.id,
      employeeId: row.employee_id,
      workDate: row.work_date,
      occurredAt: row.created_at,
      plantIds: [row.plant_id],
      details: {
        manual_time_entry_id: row.id,
        duration_seconds: Number(row.duration_seconds),
        reason_length: row.reason.trim().length,
        has_creator: row.created_by !== null,
      },
    }),
  );
}

interface DeviceDbRow {
  id: string;
  plant_id: string;
  name: string;
  created_at: Date;
  pending_event_count: number;
  rejected_event_count: number;
  last_heartbeat_at: Date | null;
  camera_status: 'unknown' | 'ready' | 'degraded' | 'unavailable';
  storage_status: 'unknown' | 'ready' | 'degraded' | 'unavailable';
  clock_skew_seconds: number | null;
  last_error: string | null;
}

async function deriveDeviceCandidates(
  client: PoolClient,
  input: DeriveOperationalExceptionsInput,
): Promise<OperationalExceptionCandidate[]> {
  const result = await client.query<DeviceDbRow>(
    `SELECT id, plant_id, name, created_at, pending_event_count,
            rejected_event_count, last_heartbeat_at, camera_status,
            storage_status, clock_skew_seconds, last_error
     FROM devices
     WHERE organization_id = $1 AND active AND enrolled_at IS NOT NULL
     ORDER BY plant_id, name, id`,
    [input.organizationId],
  );
  const now = input.now ?? new Date();
  return result.rows.flatMap((row) => {
    const reasons = deviceHealthReasons(row, now);
    if (row.camera_status !== 'ready') reasons.push(`Cámara: ${row.camera_status}`);
    if (row.storage_status === 'degraded') reasons.push('Almacenamiento local degradado');
    if (row.clock_skew_seconds !== null && Math.abs(row.clock_skew_seconds) > 300) {
      reasons.push('Reloj desviado más de 5 minutos');
    }
    if (row.last_error?.trim()) reasons.push('El dispositivo reportó un error');
    const uniqueReasons = sortedUnique(reasons);
    if (uniqueReasons.length === 0) return [];
    return [
      candidate({
        organizationId: input.organizationId,
        code: 'device_unhealthy',
        severity: 'warning',
        sourceType: 'device',
        sourceKey: row.id,
        occurredAt: row.last_heartbeat_at ?? row.created_at,
        plantIds: [row.plant_id],
        details: {
          device_id: row.id,
          device_name: row.name,
          reasons: uniqueReasons,
          pending_event_count: row.pending_event_count,
          rejected_event_count: row.rejected_event_count,
          last_heartbeat_at: row.last_heartbeat_at?.toISOString() ?? null,
          camera_status: row.camera_status,
          storage_status: row.storage_status,
          clock_skew_seconds: row.clock_skew_seconds,
          has_last_error: Boolean(row.last_error?.trim()),
        },
        // Heartbeat time and raw counters stay fresh in the projection but do
        // not append one immutable event per poll. A lifecycle refresh occurs
        // only when the semantic unhealthy reasons change.
        fingerprintFacts: { reasons: uniqueReasons },
      }),
    ];
  });
}

/** Direct source-of-truth derivation. This function performs no writes. */
export async function deriveOperationalExceptionCandidates(
  client: PoolClient,
  input: DeriveOperationalExceptionsInput,
): Promise<OperationalExceptionCandidate[]> {
  assertRange(input.fromDate, input.toDate, input.timezone);
  const values: OperationalExceptionCandidate[] = [];
  // A PoolClient cannot safely execute concurrent queries. Sequential reads
  // also keep a single transaction snapshot straightforward to reason about.
  values.push(...(await derivePunchCandidatesFromDatabase(client, input)));
  values.push(...(await deriveInvalidManualTimeCandidates(client, input)));
  values.push(...(await deriveIdentityCandidates(client, input)));
  values.push(...(await deriveDeviceCandidates(client, input)));
  return dedupeAndSortCandidates(values);
}

function eventSnapshot(value: OperationalExceptionCandidate): Record<string, unknown> {
  return {
    dedupe_key: value.dedupeKey,
    code: value.code,
    severity: value.severity,
    source_type: value.sourceType,
    source_key: value.sourceKey,
    source_fingerprint: value.sourceFingerprint,
    employee_id: value.employeeId,
    work_date: value.workDate,
    occurred_at: value.occurredAt,
    plant_ids: value.plantIds,
    title: value.title,
    details: value.details,
  };
}

async function replaceExceptionPlants(
  client: PoolClient,
  exceptionId: string,
  organizationId: string,
  plantIds: readonly string[],
): Promise<void> {
  await client.query(
    `DELETE FROM operational_exception_plants
     WHERE exception_id = $1 AND organization_id = $2`,
    [exceptionId, organizationId],
  );
  for (const plantId of sortedUnique(plantIds)) {
    await client.query(
      `INSERT INTO operational_exception_plants
         (exception_id, organization_id, plant_id)
       VALUES ($1, $2, $3)`,
      [exceptionId, organizationId, plantId],
    );
  }
}

async function insertLifecycleEvent(
  client: PoolClient,
  input: {
    organizationId: string;
    exceptionId: string;
    eventType: 'opened' | 'refreshed' | 'acknowledged' | 'resolved' | 'reopened';
    fromStatus: OperationalExceptionStatus | null;
    toStatus: OperationalExceptionStatus;
    actorUserId?: string | null;
    reason?: string | null;
    snapshot: Record<string, unknown>;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO operational_exception_events
       (organization_id, exception_id, sequence, event_type, from_status,
        to_status, actor_user_id, reason, snapshot)
     VALUES (
       $1, $2,
       (SELECT COALESCE(max(sequence), 0) + 1
        FROM operational_exception_events
        WHERE organization_id = $1 AND exception_id = $2),
       $3, $4, $5, $6, $7, $8::jsonb
     )`,
    [
      input.organizationId,
      input.exceptionId,
      input.eventType,
      input.fromStatus,
      input.toStatus,
      input.actorUserId ?? null,
      input.reason ?? null,
      JSON.stringify(input.snapshot),
    ],
  );
}

interface ExistingProjectionRow {
  id: string;
  status: OperationalExceptionStatus;
  severity: OperationalExceptionSeverity;
  source_fingerprint: string;
  resolved_by: string | null;
}

/**
 * Rebuilds the query projection and resolves disappeared source conditions.
 * Call inside a transaction. Source tables remain untouched.
 */
export async function reconcileOperationalExceptions(
  client: PoolClient,
  input: DeriveOperationalExceptionsInput,
): Promise<ReconcileOperationalExceptionsResult> {
  assertRange(input.fromDate, input.toDate, input.timezone);
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`, [
    input.organizationId,
    `operational-exceptions:${input.fromDate}:${input.toDate}`,
  ]);
  const candidates = await deriveOperationalExceptionCandidates(client, input);
  const summary: ReconcileOperationalExceptionsResult = {
    candidateCount: candidates.length,
    opened: 0,
    reopened: 0,
    refreshed: 0,
    resolved: 0,
  };

  for (const value of candidates) {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO operational_exceptions
         (organization_id, dedupe_key, code, severity, source_type, source_key,
          source_fingerprint, employee_id, work_date, occurred_at, title, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::date, $10, $11, $12::jsonb)
       ON CONFLICT (organization_id, dedupe_key) DO NOTHING
       RETURNING id`,
      [
        value.organizationId,
        value.dedupeKey,
        value.code,
        value.severity,
        value.sourceType,
        value.sourceKey,
        value.sourceFingerprint,
        value.employeeId,
        value.workDate,
        value.occurredAt,
        value.title,
        JSON.stringify(value.details),
      ],
    );

    if (inserted.rows[0]) {
      await replaceExceptionPlants(client, inserted.rows[0].id, value.organizationId, value.plantIds);
      await insertLifecycleEvent(client, {
        organizationId: value.organizationId,
        exceptionId: inserted.rows[0].id,
        eventType: 'opened',
        fromStatus: null,
        toStatus: 'open',
        snapshot: eventSnapshot(value),
      });
      summary.opened += 1;
      continue;
    }

    const locked = await client.query<ExistingProjectionRow>(
      `SELECT id, status, severity, source_fingerprint, resolved_by
       FROM operational_exceptions
       WHERE organization_id = $1 AND dedupe_key = $2
       FOR UPDATE`,
      [value.organizationId, value.dedupeKey],
    );
    const existing = locked.rows[0];
    if (!existing) throw new Error('operational exception conflict row disappeared');
    const wasResolved = existing.status === 'resolved';
    const changed = existing.source_fingerprint !== value.sourceFingerprint;

    // A human resolution of a warning is a durable review of the exact facts.
    // Keep it resolved while its fingerprint is unchanged; otherwise waiver
    // and split-shift reviews would reopen every minute. A structural blocker
    // always reopens while its source persists, keeping it visible before the
    // direct weekly close gate. An auto-resolved condition (`resolved_by IS
    // NULL`) also always reopens if its source returns.
    if (
      wasResolved &&
      existing.severity === 'warning' &&
      existing.resolved_by !== null &&
      !changed
    ) {
      await client.query(
        `UPDATE operational_exceptions
         SET occurred_at = $3, details = $4::jsonb,
             last_detected_at = now(), updated_at = now()
         WHERE id = $1 AND organization_id = $2`,
        [existing.id, value.organizationId, value.occurredAt, JSON.stringify(value.details)],
      );
      continue;
    }

    await client.query(
      `UPDATE operational_exceptions
       SET code = $3, severity = $4, source_type = $5, source_key = $6,
           source_fingerprint = $7, employee_id = $8, work_date = $9::date,
           occurred_at = $10, title = $11, details = $12::jsonb,
           status = CASE WHEN status = 'resolved' THEN 'open' ELSE status END,
           acknowledged_at = CASE WHEN status = 'resolved' THEN NULL ELSE acknowledged_at END,
           acknowledged_by = CASE WHEN status = 'resolved' THEN NULL ELSE acknowledged_by END,
           resolved_at = NULL, resolved_by = NULL, resolution_reason = NULL,
           last_detected_at = now(), updated_at = now()
       WHERE id = $1 AND organization_id = $2`,
      [
        existing.id,
        value.organizationId,
        value.code,
        value.severity,
        value.sourceType,
        value.sourceKey,
        value.sourceFingerprint,
        value.employeeId,
        value.workDate,
        value.occurredAt,
        value.title,
        JSON.stringify(value.details),
      ],
    );
    await replaceExceptionPlants(client, existing.id, value.organizationId, value.plantIds);

    if (wasResolved) {
      await insertLifecycleEvent(client, {
        organizationId: value.organizationId,
        exceptionId: existing.id,
        eventType: 'reopened',
        fromStatus: 'resolved',
        toStatus: 'open',
        reason: 'source_condition_still_present',
        snapshot: eventSnapshot(value),
      });
      summary.reopened += 1;
    } else if (changed) {
      await insertLifecycleEvent(client, {
        organizationId: value.organizationId,
        exceptionId: existing.id,
        eventType: 'refreshed',
        fromStatus: existing.status,
        toStatus: existing.status,
        snapshot: eventSnapshot(value),
      });
      summary.refreshed += 1;
    }
  }

  const keys = candidates.map((value) => value.dedupeKey);
  const disappeared = await client.query<{
    id: string;
    status: 'open' | 'acknowledged';
    code: OperationalExceptionCode;
    severity: OperationalExceptionSeverity;
    source_type: OperationalExceptionSourceType;
    source_key: string;
    source_fingerprint: string;
    employee_id: string | null;
    work_date: string | null;
    occurred_at: Date;
    title: string;
    details: Record<string, unknown>;
    plant_ids: string[];
  }>(
    `SELECT e.id, e.status, e.code, e.severity, e.source_type, e.source_key,
            e.source_fingerprint, e.employee_id, e.work_date::text,
            e.occurred_at, e.title, e.details,
            ARRAY(
              SELECT ep.plant_id::text
              FROM operational_exception_plants ep
              WHERE ep.exception_id = e.id AND ep.organization_id = e.organization_id
              ORDER BY ep.plant_id
            ) AS plant_ids
     FROM operational_exceptions e
     WHERE e.organization_id = $1
       AND e.status IN ('open', 'acknowledged')
       AND (e.source_type = 'device' OR e.work_date BETWEEN $2::date AND $3::date)
       AND NOT (e.dedupe_key::text = ANY($4::text[]))
     ORDER BY e.id
     FOR UPDATE OF e`,
    [input.organizationId, input.fromDate, input.toDate, keys],
  );

  for (const row of disappeared.rows) {
    await client.query(
      `UPDATE operational_exceptions
       SET status = 'resolved', resolved_at = now(), resolved_by = NULL,
           resolution_reason = 'source_condition_cleared', updated_at = now()
       WHERE id = $1 AND organization_id = $2`,
      [row.id, input.organizationId],
    );
    await insertLifecycleEvent(client, {
      organizationId: input.organizationId,
      exceptionId: row.id,
      eventType: 'resolved',
      fromStatus: row.status,
      toStatus: 'resolved',
      reason: 'source_condition_cleared',
      snapshot: {
        dedupe_key: canonicalExceptionDedupeKey(row.code, row.source_type, row.source_key),
        code: row.code,
        severity: row.severity,
        source_type: row.source_type,
        source_key: row.source_key,
        source_fingerprint: row.source_fingerprint,
        employee_id: row.employee_id,
        work_date: row.work_date,
        occurred_at: row.occurred_at.toISOString(),
        plant_ids: row.plant_ids,
        title: row.title,
        details: row.details,
      },
    });
    summary.resolved += 1;
  }
  return summary;
}

export async function transitionOperationalException(
  client: PoolClient,
  input: {
    organizationId: string;
    exceptionId: string;
    actorUserId: string;
    action: 'acknowledge' | 'resolve';
    reason: string;
  },
): Promise<{ id: string; status: OperationalExceptionStatus }> {
  if (input.reason.trim().length < 3) throw new Error('transition reason must have at least 3 characters');
  const locked = await client.query<{
    id: string;
    status: OperationalExceptionStatus;
    code: OperationalExceptionCode;
    severity: OperationalExceptionSeverity;
    source_type: OperationalExceptionSourceType;
    source_key: string;
    source_fingerprint: string;
    employee_id: string | null;
    work_date: string | null;
    occurred_at: Date;
    title: string;
    details: Record<string, unknown>;
    plant_ids: string[];
  }>(
    `SELECT e.id, e.status, e.code, e.severity, e.source_type, e.source_key,
            e.source_fingerprint, e.employee_id, e.work_date::text,
            e.occurred_at, e.title, e.details,
            ARRAY(
              SELECT ep.plant_id::text
              FROM operational_exception_plants ep
              WHERE ep.exception_id = e.id AND ep.organization_id = e.organization_id
              ORDER BY ep.plant_id
            ) AS plant_ids
     FROM operational_exceptions e
     WHERE e.id = $1 AND e.organization_id = $2
     FOR UPDATE OF e`,
    [input.exceptionId, input.organizationId],
  );
  const row = locked.rows[0];
  if (!row) throw new Error('operational_exception_not_found');

  const snapshot = {
    dedupe_key: canonicalExceptionDedupeKey(row.code, row.source_type, row.source_key),
    code: row.code,
    severity: row.severity,
    source_type: row.source_type,
    source_key: row.source_key,
    source_fingerprint: row.source_fingerprint,
    employee_id: row.employee_id,
    work_date: row.work_date,
    occurred_at: row.occurred_at.toISOString(),
    plant_ids: row.plant_ids,
    title: row.title,
    details: row.details,
  };

  if (input.action === 'acknowledge') {
    if (row.status !== 'open') throw new Error('operational_exception_transition_conflict');
    await client.query(
      `UPDATE operational_exceptions
       SET status = 'acknowledged', acknowledged_at = now(),
           acknowledged_by = $3, updated_at = now()
       WHERE id = $1 AND organization_id = $2`,
      [row.id, input.organizationId, input.actorUserId],
    );
    await insertLifecycleEvent(client, {
      organizationId: input.organizationId,
      exceptionId: row.id,
      eventType: 'acknowledged',
      fromStatus: 'open',
      toStatus: 'acknowledged',
      actorUserId: input.actorUserId,
      reason: input.reason.trim(),
      snapshot,
    });
    return { id: row.id, status: 'acknowledged' };
  }

  if (row.status === 'resolved') throw new Error('operational_exception_transition_conflict');
  await client.query(
    `UPDATE operational_exceptions
     SET status = 'resolved', resolved_at = now(), resolved_by = $3,
         resolution_reason = $4, updated_at = now()
     WHERE id = $1 AND organization_id = $2`,
    [row.id, input.organizationId, input.actorUserId, input.reason.trim()],
  );
  await insertLifecycleEvent(client, {
    organizationId: input.organizationId,
    exceptionId: row.id,
    eventType: 'resolved',
    fromStatus: row.status,
    toStatus: 'resolved',
    actorUserId: input.actorUserId,
    reason: input.reason.trim(),
    snapshot,
  });
  return { id: row.id, status: 'resolved' };
}

/**
 * Exact tenant/plant authorization for detail and lifecycle mutations. Admins
 * see the tenant; foremen must be assigned to every linked plant so one plant
 * cannot leak another plant's exception details.
 */
export async function canAccessOperationalException(
  client: PoolClient,
  input: {
    organizationId: string;
    exceptionId: string;
    userId: string;
    role: 'admin' | 'foreman';
    lock?: boolean;
  },
): Promise<boolean> {
  const result = await client.query<{ id: string }>(
    `SELECT e.id
     FROM operational_exceptions e
     WHERE e.id = $1 AND e.organization_id = $2
       AND (
         $4::text = 'admin'
         OR (
           EXISTS (
             SELECT 1 FROM operational_exception_plants linked
             WHERE linked.exception_id = e.id
               AND linked.organization_id = e.organization_id
           )
           AND NOT EXISTS (
             SELECT 1
             FROM operational_exception_plants denied
             WHERE denied.exception_id = e.id
               AND denied.organization_id = e.organization_id
               AND NOT EXISTS (
                 SELECT 1 FROM user_plant_access access
                 WHERE access.organization_id = denied.organization_id
                   AND access.plant_id = denied.plant_id
                   AND access.user_id = $3
               )
           )
         )
       )
     ${input.lock ? 'FOR UPDATE' : ''}`,
    [input.exceptionId, input.organizationId, input.userId, input.role],
  );
  return Boolean(result.rows[0]);
}

/**
 * Finalization gate from authoritative sources, never from the reconciled
 * operational_exceptions table. Must run inside a transaction. It obtains the
 * same advisory week lock used by pay-period mutations before reading.
 */
export async function deriveFinalizationBlockers(
  client: PoolClient,
  input: DeriveOperationalExceptionsInput,
): Promise<OperationalExceptionCandidate[]> {
  assertRange(input.fromDate, input.toDate, input.timezone);
  const bounds = weekBoundsForDate(input.fromDate, input.timezone);
  if (bounds.weekStart !== input.fromDate || bounds.weekEnd !== input.toDate) {
    throw new Error('finalization blocker range must be one Sunday-Saturday week');
  }
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`, [
    input.organizationId,
    bounds.weekStart,
  ]);
  const candidates = await deriveOperationalExceptionCandidates(client, {
    ...input,
    applyOpenSequenceGrace: false,
  });
  return candidates.filter((value) => value.severity === 'blocker');
}
