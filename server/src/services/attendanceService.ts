/**
 * Pegamento entre el log de checadas y el motor de cálculo puro.
 * Todo se deriva de `punches` no anuladas; nada se almacena.
 */
import { DateTime } from 'luxon';
import { query } from '../db.js';
import { computeDay, type EnginePunch } from './calcEngine.js';
import { classifyCaliforniaOvertime, type CaliforniaWorkChunk } from './californiaOvertime.js';
import { buildWorkSegments, type WorkSegmentIssue } from './workSegments.js';
import { getSettings } from './settingsService.js';
import type {
  DayCalc,
  DayDetailPunch,
  DayDetailRow,
  ManualTimeEntry,
  PunchType,
  WeekEmployeeCalc,
} from '../types.js';

interface PunchDbRow {
  id: string;
  employee_id: string;
  punch_type: PunchType;
  punched_at: Date;
  work_date: string;
}

interface SegmentPunchDbRow {
  id: string;
  employee_id: string;
  punch_type: PunchType;
  punched_at: Date;
  plant_id: string;
}

interface ManualTimeDbRow {
  id: string;
  employee_id: string;
  plant_id: string;
  work_date: string;
  duration_seconds: string | number;
  created_at: Date;
}

interface EmployeeInfo {
  id: string;
  employee_number: number;
  full_name: string;
  social_security: string | null;
  active: boolean;
  hired_at: string | null;
  deactivated_at: string | null;
  shift_start: string | null;
  shift_name: string | null;
  tolerance_minutes: number | null;
}

async function fetchEmployees(organizationId: string): Promise<Map<string, EmployeeInfo>> {
  const rows = await query<EmployeeInfo>(
    `SELECT e.id, e.employee_number, e.full_name, e.social_security, e.active,
            e.hired_at, e.deactivated_at,
            s.start_time AS shift_start, s.name AS shift_name, s.tolerance_minutes
     FROM employees e
     LEFT JOIN shifts s ON s.id = e.default_shift_id
     WHERE e.organization_id = $1`,
    [organizationId]
  );
  return new Map(rows.map((r) => [r.id, r]));
}

async function fetchPunches(
  organizationId: string,
  fromDate: string,
  toDate: string,
  timezone: string,
  plantIds?: string[]
): Promise<PunchDbRow[]> {
  return query<PunchDbRow>(
    `SELECT p.id, p.employee_id, p.punch_type, p.punched_at,
            (p.punched_at AT TIME ZONE $3)::date::text AS work_date
     FROM punches p
     WHERE NOT p.voided
       AND p.organization_id = $4
       AND ($5::uuid[] IS NULL OR p.plant_id = ANY($5::uuid[]))
       AND (p.punched_at AT TIME ZONE $3)::date BETWEEN $1::date AND $2::date
     ORDER BY p.punched_at`,
    [fromDate, toDate, timezone, organizationId, plantIds ?? null]
  );
}

async function fetchSegmentPunches(
  organizationId: string,
  weekStart: string,
  weekEnd: string,
  timezone: string
): Promise<SegmentPunchDbRow[]> {
  return query<SegmentPunchDbRow>(
    `SELECT id, employee_id, punch_type, punched_at, plant_id
     FROM punches
     WHERE organization_id = $1 AND NOT voided
       AND (punched_at AT TIME ZONE $4)::date
           BETWEEN ($2::date - 1) AND ($3::date + 1)
     ORDER BY employee_id, punched_at, created_at, id`,
    [organizationId, weekStart, weekEnd, timezone]
  );
}

function issueTouchesWeek(
  issue: WorkSegmentIssue,
  weekStart: string,
  weekEnd: string,
  timezone: string
): boolean {
  const localDate = (iso: string | null): string | null =>
    iso ? DateTime.fromISO(iso, { setZone: true }).setZone(timezone).toISODate() : null;
  const start = localDate(issue.start);
  const end = localDate(issue.end);
  if (start && start > weekEnd) return false;
  if (end && end < weekStart) return false;
  return !start || start >= weekStart || !end || end >= weekStart;
}

/** Cálculo de un día local de planta para todos los empleados con checadas. */
export async function computeDayAll(
  organizationId: string,
  workDate: string,
  plantIds?: string[]
): Promise<DayCalc[]> {
  const settings = await getSettings(organizationId);
  const [punches, employees] = await Promise.all([
    fetchPunches(organizationId, workDate, workDate, settings.timezone, plantIds),
    fetchEmployees(organizationId),
  ]);

  const byEmployee = new Map<string, EnginePunch[]>();
  for (const p of punches) {
    const list = byEmployee.get(p.employee_id) ?? [];
    list.push({ id: p.id, punch_type: p.punch_type, punched_at: p.punched_at });
    byEmployee.set(p.employee_id, list);
  }

  const results: DayCalc[] = [];
  for (const [employeeId, empPunches] of byEmployee) {
    const emp = employees.get(employeeId);
    results.push(
      computeDay(empPunches, {
        employeeId,
        workDate,
        timezone: settings.timezone,
        shiftStart: emp?.shift_start ?? null,
        toleranceMinutes: emp?.tolerance_minutes ?? 5,
        duplicateWindowMinutes: settings.duplicate_window_minutes,
      })
    );
  }
  return results;
}

export type { DayDetailPunch, DayDetailRow };

/**
 * Detalle de un día: por empleado, sus checadas (incluidas anuladas, para
 * transparencia) y el cálculo derivado de las vigentes.
 */
export async function dayDetail(
  organizationId: string,
  workDate: string,
  plantIds?: string[]
): Promise<DayDetailRow[]> {
  const settings = await getSettings(organizationId);
  const [allPunches, employees, assignments, manualEntries] = await Promise.all([
    query<PunchDbRow & {
      source: string;
      voided: boolean;
      correction_reason: string | null;
      punch_area: string | null;
      plant_id: string;
      plant_name: string;
    }>(
      `SELECT p.id, p.employee_id, p.punch_type, p.punched_at, p.source, p.voided,
              p.correction_reason, a.name AS punch_area, p.plant_id, pl.name AS plant_name,
              (p.punched_at AT TIME ZONE $2)::date::text AS work_date
       FROM punches p
       LEFT JOIN areas a ON a.id = p.area_id
       JOIN plants pl ON pl.id = p.plant_id
       WHERE p.organization_id = $3
         AND ($4::uuid[] IS NULL OR p.plant_id = ANY($4::uuid[]))
         AND (p.punched_at AT TIME ZONE $2)::date = $1::date
       ORDER BY p.punched_at`,
      [workDate, settings.timezone, organizationId, plantIds ?? null]
    ),
    fetchEmployees(organizationId),
    query<{ employee_id: string; area_name: string }>(
      `SELECT d.employee_id, a.name AS area_name
       FROM daily_area_assignments d
       JOIN areas a ON a.id = d.area_id
       WHERE d.work_date = $1::date AND d.organization_id = $2
         AND ($3::uuid[] IS NULL OR d.plant_id = ANY($3::uuid[]))`,
      [workDate, organizationId, plantIds ?? null]
    ),
    query<ManualTimeEntry>(
      `SELECT m.id, m.employee_id, m.plant_id, p.name AS plant_name, m.work_date,
              m.duration_seconds::double precision, m.reason, m.created_by,
              u.name AS created_by_name, m.created_at, m.voided_at,
              m.voided_by, m.void_reason
       FROM manual_time_entries m
       JOIN plants p ON p.id = m.plant_id
       JOIN users u ON u.id = m.created_by
       WHERE m.organization_id = $1 AND m.work_date = $2::date
         AND ($3::uuid[] IS NULL OR m.plant_id = ANY($3::uuid[]))
       ORDER BY m.created_at`,
      [organizationId, workDate, plantIds ?? null]
    ),
  ]);

  const areaByEmployee = new Map(assignments.map((r) => [r.employee_id, r.area_name]));

  const byEmployee = new Map<string, typeof allPunches>();
  for (const p of allPunches) {
    const list = byEmployee.get(p.employee_id) ?? [];
    list.push(p);
    byEmployee.set(p.employee_id, list);
  }

  const manualByEmployee = new Map<string, ManualTimeEntry[]>();
  for (const entry of manualEntries) {
    const list = manualByEmployee.get(entry.employee_id) ?? [];
    list.push(entry);
    manualByEmployee.set(entry.employee_id, list);
  }

  const rows: DayDetailRow[] = [];
  const employeeIds = new Set([...byEmployee.keys(), ...manualByEmployee.keys()]);
  for (const employeeId of employeeIds) {
    const empPunches = byEmployee.get(employeeId) ?? [];
    const emp = employees.get(employeeId);
    if (!emp) continue;
    const valid = empPunches.filter((p) => !p.voided);
    const calc = computeDay(
      valid.map((p) => ({ id: p.id, punch_type: p.punch_type, punched_at: p.punched_at })),
      {
        employeeId,
        workDate,
        timezone: settings.timezone,
        shiftStart: emp.shift_start,
        toleranceMinutes: emp.tolerance_minutes ?? 5,
        duplicateWindowMinutes: settings.duplicate_window_minutes,
      }
    );
    // Área del día: asignación explícita, o la de la última checada que la traiga
    const lastPunchArea = [...valid].reverse().find((p) => p.punch_area)?.punch_area ?? null;
    const employeeManual = manualByEmployee.get(employeeId) ?? [];
    const manualSeconds = employeeManual
      .filter((entry) => !entry.voided_at)
      .reduce((sum, entry) => sum + Number(entry.duration_seconds), 0);
    if (!valid.length && manualSeconds > 0) calc.complete = true;
    rows.push({
      employee_id: employeeId,
      employee_number: emp.employee_number,
      full_name: emp.full_name,
      shift_name: emp.shift_name,
      area_name: areaByEmployee.get(employeeId) ?? lastPunchArea,
      calc,
      manual_time: employeeManual,
      manual_seconds: manualSeconds,
      total_seconds: calc.worked_seconds + manualSeconds,
      punches: empPunches.map((p) => ({
        id: p.id,
        punch_type: p.punch_type,
        punched_at: p.punched_at.toISOString(),
        source: p.source,
        voided: p.voided,
        correction_reason: p.correction_reason,
        area_name: p.punch_area,
        plant_id: p.plant_id,
        plant_name: p.plant_name,
      })),
    });
  }

  rows.sort((a, b) => a.employee_number - b.employee_number);
  return rows;
}

export interface WeekComputation {
  week_start: string;
  week_end: string;
  policy: 'CA_STANDARD_8_40';
  employees: WeekEmployeeCalc[];
  anomaly_count: number;
}

/** Cálculo semanal exacto bajo la política inmutable CA_STANDARD_8_40. */
export async function computeWeek(
  organizationId: string,
  weekStart: string,
  plantIds?: string[]
): Promise<WeekComputation> {
  const settings = await getSettings(organizationId);
  const start = DateTime.fromISO(weekStart, { zone: settings.timezone });
  const weekEnd = start.plus({ days: 6 }).toISODate()!;
  const [punches, segmentPunches, manualEntries, employees] = await Promise.all([
    fetchPunches(organizationId, weekStart, weekEnd, settings.timezone, plantIds),
    fetchSegmentPunches(organizationId, weekStart, weekEnd, settings.timezone),
    query<ManualTimeDbRow>(
      `SELECT id, employee_id, plant_id, work_date, duration_seconds, created_at
       FROM manual_time_entries
       WHERE organization_id = $1 AND voided_at IS NULL
         AND work_date BETWEEN $2::date AND $3::date
       ORDER BY employee_id, work_date, created_at, id`,
      [organizationId, weekStart, weekEnd]
    ),
    fetchEmployees(organizationId),
  ]);

  const dates: string[] = Array.from({ length: 7 }, (_, i) => start.plus({ days: i }).toISODate()!);

  // Agrupar checadas por empleado × día
  const byEmpDay = new Map<string, Map<string, EnginePunch[]>>();
  for (const p of punches) {
    const days = byEmpDay.get(p.employee_id) ?? new Map<string, EnginePunch[]>();
    const list = days.get(p.work_date) ?? [];
    list.push({ id: p.id, punch_type: p.punch_type, punched_at: p.punched_at });
    days.set(p.work_date, list);
    byEmpDay.set(p.employee_id, days);
  }

  const segmentPunchesByEmployee = new Map<string, SegmentPunchDbRow[]>();
  for (const punch of segmentPunches) {
    const list = segmentPunchesByEmployee.get(punch.employee_id) ?? [];
    list.push(punch);
    segmentPunchesByEmployee.set(punch.employee_id, list);
  }
  const manualByEmployee = new Map<string, ManualTimeDbRow[]>();
  for (const entry of manualEntries) {
    const list = manualByEmployee.get(entry.employee_id) ?? [];
    list.push(entry);
    manualByEmployee.set(entry.employee_id, list);
  }

  // Empleados a reportar: con tiempo, o activos durante la semana.
  const relevant = new Set<string>([
    ...byEmpDay.keys(),
    ...segmentPunchesByEmployee.keys(),
    ...manualByEmployee.keys(),
  ]);
  for (const emp of employees.values()) {
    const hiredOk = !emp.hired_at || emp.hired_at <= weekEnd;
    const notDeactivated = !emp.deactivated_at || emp.deactivated_at >= weekStart;
    if (emp.active && hiredOk && notDeactivated) relevant.add(emp.id);
  }

  const result: WeekEmployeeCalc[] = [];
  let anomalyCount = 0;

  for (const employeeId of relevant) {
    const emp = employees.get(employeeId);
    if (!emp) continue;
    const legacyDays = new Map<string, DayCalc>();

    for (const date of dates) {
      const dayPunches = byEmpDay.get(employeeId)?.get(date);
      if (!dayPunches) continue;
      legacyDays.set(
        date,
        computeDay(dayPunches, {
          employeeId,
          workDate: date,
          timezone: settings.timezone,
          shiftStart: emp.shift_start,
          toleranceMinutes: emp.tolerance_minutes ?? 5,
          duplicateWindowMinutes: settings.duplicate_window_minutes,
        })
      );
    }

    const segments = buildWorkSegments(
      (segmentPunchesByEmployee.get(employeeId) ?? []).map((punch) => ({
        id: punch.id,
        type: punch.punch_type,
        time: punch.punched_at,
        plantId: punch.plant_id,
      }))
    );
    const clockChunks: CaliforniaWorkChunk[] = segments.chunks.filter(
      (chunk) => chunk.workDate >= weekStart && chunk.workDate <= weekEnd
    );
    const manualChunks: CaliforniaWorkChunk[] = (manualByEmployee.get(employeeId) ?? []).map(
      (entry, order) => ({
        id: `manual:${entry.id}`,
        workDate: entry.work_date,
        durationSeconds: Number(entry.duration_seconds),
        plantId: entry.plant_id,
        source: 'manual',
        order,
      })
    );
    const classification = classifyCaliforniaOvertime({
      weekStart,
      chunks: [...clockChunks, ...manualChunks],
    });

    const relevantIssues = segments.issues.filter((issue) =>
      issueTouchesWeek(issue, weekStart, weekEnd, settings.timezone)
    );
    anomalyCount += relevantIssues.length;

    const days: DayCalc[] = classification.days
      .filter((day) => day.totalWorkedSeconds > 0 || legacyDays.has(day.workDate))
      .map((day) => {
        const legacy = legacyDays.get(day.workDate) ??
          computeDay([], {
            employeeId,
            workDate: day.workDate,
            timezone: settings.timezone,
            shiftStart: null,
            duplicateWindowMinutes: settings.duplicate_window_minutes,
          });
        const hasClockPunches = byEmpDay.get(employeeId)?.has(day.workDate) ?? false;
        return {
          ...legacy,
          worked_seconds: day.totalWorkedSeconds,
          worked_minutes: day.totalWorkedSeconds / 60,
          complete: hasClockPunches ? legacy.complete : day.totalWorkedSeconds > 0,
        };
      });

    const regularSeconds = classification.totals.regularSeconds;
    const overtimeSeconds = classification.totals.overtime15Seconds;
    const doubleTimeSeconds = classification.totals.doubleTimeSeconds;
    const clockedSeconds = Object.values(classification.bySource.clock).reduce(
      (sum, seconds) => sum + seconds,
      0
    );
    const manualSeconds = Object.values(classification.bySource.manual).reduce(
      (sum, seconds) => sum + seconds,
      0
    );

    result.push({
      employee_id: employeeId,
      employee_number: emp.employee_number,
      full_name: emp.full_name,
      social_security: null,
      days_worked: classification.days.filter((day) => day.totalWorkedSeconds > 0).length,
      regular_minutes: regularSeconds / 60,
      overtime_minutes: overtimeSeconds / 60,
      double_time_minutes: doubleTimeSeconds / 60,
      clocked_minutes: clockedSeconds / 60,
      manual_minutes: manualSeconds / 60,
      regular_seconds: regularSeconds,
      overtime_seconds: overtimeSeconds,
      double_time_seconds: doubleTimeSeconds,
      clocked_seconds: clockedSeconds,
      manual_seconds: manualSeconds,
      total_seconds: classification.totalWorkedSeconds,
      lates: 0,
      absences: 0,
      total_minutes: classification.totalWorkedSeconds / 60,
      days,
    });
  }

  result.sort((a, b) => a.employee_number - b.employee_number);
  return {
    week_start: weekStart,
    week_end: weekEnd,
    policy: 'CA_STANDARD_8_40',
    employees: result,
    anomaly_count: anomalyCount,
  };
}
