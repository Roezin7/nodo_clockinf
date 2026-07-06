/**
 * Pegamento entre el log de checadas y el motor de cálculo puro.
 * Todo se deriva de `punches` no anuladas; nada se almacena.
 */
import { DateTime } from 'luxon';
import { query } from '../db.js';
import { computeDay, reconcileWeekOvertime, type EnginePunch } from './calcEngine.js';
import { getSettings } from './settingsService.js';
import type { DayCalc, DayDetailPunch, DayDetailRow, PunchType, WeekEmployeeCalc } from '../types.js';

interface PunchDbRow {
  id: string;
  employee_id: string;
  punch_type: PunchType;
  punched_at: Date;
  work_date: string;
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

async function fetchEmployees(): Promise<Map<string, EmployeeInfo>> {
  const rows = await query<EmployeeInfo>(
    `SELECT e.id, e.employee_number, e.full_name, e.social_security, e.active,
            e.hired_at, e.deactivated_at,
            s.start_time AS shift_start, s.name AS shift_name, s.tolerance_minutes
     FROM employees e
     LEFT JOIN shifts s ON s.id = e.default_shift_id`
  );
  return new Map(rows.map((r) => [r.id, r]));
}

async function fetchPunches(fromDate: string, toDate: string, timezone: string): Promise<PunchDbRow[]> {
  return query<PunchDbRow>(
    `SELECT p.id, p.employee_id, p.punch_type, p.punched_at,
            (p.punched_at AT TIME ZONE $3)::date::text AS work_date
     FROM punches p
     WHERE NOT p.voided
       AND (p.punched_at AT TIME ZONE $3)::date BETWEEN $1::date AND $2::date
     ORDER BY p.punched_at`,
    [fromDate, toDate, timezone]
  );
}

/** Cálculo de un día local de planta para todos los empleados con checadas. */
export async function computeDayAll(workDate: string): Promise<DayCalc[]> {
  const settings = await getSettings();
  const [punches, employees] = await Promise.all([
    fetchPunches(workDate, workDate, settings.timezone),
    fetchEmployees(),
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
export async function dayDetail(workDate: string): Promise<DayDetailRow[]> {
  const settings = await getSettings();
  const [allPunches, employees, assignments] = await Promise.all([
    query<PunchDbRow & { source: string; voided: boolean; correction_reason: string | null; punch_area: string | null }>(
      `SELECT p.id, p.employee_id, p.punch_type, p.punched_at, p.source, p.voided,
              p.correction_reason, a.name AS punch_area,
              (p.punched_at AT TIME ZONE $2)::date::text AS work_date
       FROM punches p
       LEFT JOIN areas a ON a.id = p.area_id
       WHERE (p.punched_at AT TIME ZONE $2)::date = $1::date
       ORDER BY p.punched_at`,
      [workDate, settings.timezone]
    ),
    fetchEmployees(),
    query<{ employee_id: string; area_name: string }>(
      `SELECT d.employee_id, a.name AS area_name
       FROM daily_area_assignments d
       JOIN areas a ON a.id = d.area_id
       WHERE d.work_date = $1::date`,
      [workDate]
    ),
  ]);

  const areaByEmployee = new Map(assignments.map((r) => [r.employee_id, r.area_name]));

  const byEmployee = new Map<string, typeof allPunches>();
  for (const p of allPunches) {
    const list = byEmployee.get(p.employee_id) ?? [];
    list.push(p);
    byEmployee.set(p.employee_id, list);
  }

  const rows: DayDetailRow[] = [];
  for (const [employeeId, empPunches] of byEmployee) {
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
    rows.push({
      employee_id: employeeId,
      employee_number: emp.employee_number,
      full_name: emp.full_name,
      shift_name: emp.shift_name,
      area_name: areaByEmployee.get(employeeId) ?? lastPunchArea,
      calc,
      punches: empPunches.map((p) => ({
        id: p.id,
        punch_type: p.punch_type,
        punched_at: p.punched_at.toISOString(),
        source: p.source,
        voided: p.voided,
        correction_reason: p.correction_reason,
        area_name: p.punch_area,
      })),
    });
  }

  rows.sort((a, b) => a.employee_number - b.employee_number);
  return rows;
}

export interface WeekComputation {
  week_start: string;
  week_end: string;
  employees: WeekEmployeeCalc[];
  anomaly_count: number;
}

/** Cálculo semanal completo con reconciliación de OT y faltas. */
export async function computeWeek(weekStart: string): Promise<WeekComputation> {
  const settings = await getSettings();
  const start = DateTime.fromISO(weekStart, { zone: settings.timezone });
  const weekEnd = start.plus({ days: 6 }).toISODate()!;
  const [punches, employees] = await Promise.all([
    fetchPunches(weekStart, weekEnd, settings.timezone),
    fetchEmployees(),
  ]);

  const dates: string[] = Array.from({ length: 7 }, (_, i) => start.plus({ days: i }).toISODate()!);
  const today = DateTime.now().setZone(settings.timezone).toISODate()!;

  // Agrupar checadas por empleado × día
  const byEmpDay = new Map<string, Map<string, EnginePunch[]>>();
  for (const p of punches) {
    const days = byEmpDay.get(p.employee_id) ?? new Map<string, EnginePunch[]>();
    const list = days.get(p.work_date) ?? [];
    list.push({ id: p.id, punch_type: p.punch_type, punched_at: p.punched_at });
    days.set(p.work_date, list);
    byEmpDay.set(p.employee_id, days);
  }

  // Empleados a reportar: con checadas en la semana, o activos durante la semana
  const relevant = new Set<string>(byEmpDay.keys());
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
    const days: DayCalc[] = [];

    for (const date of dates) {
      const dayPunches = byEmpDay.get(employeeId)?.get(date);
      if (!dayPunches) continue;
      days.push(
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

    const { regular_minutes, overtime_minutes } = reconcileWeekOvertime(
      days.map((d) => d.worked_minutes),
      settings.daily_ot_threshold_minutes,
      settings.weekly_ot_threshold_minutes
    );

    // Faltas: día laborable (settings.work_days, ISO 1=lunes) ya transcurrido,
    // dentro del periodo activo del empleado, sin ninguna checada.
    const punchedDates = new Set(days.map((d) => d.work_date));
    let absences = 0;
    for (const date of dates) {
      if (date > today) continue;
      const weekday = DateTime.fromISO(date).weekday;
      if (!settings.work_days.includes(weekday)) continue;
      if (emp.hired_at && date < emp.hired_at) continue;
      if (emp.deactivated_at && date > emp.deactivated_at) continue;
      if (!punchedDates.has(date)) absences += 1;
    }

    anomalyCount += days.reduce((n, d) => n + d.anomalies.length, 0);

    result.push({
      employee_id: employeeId,
      employee_number: emp.employee_number,
      full_name: emp.full_name,
      social_security: emp.social_security,
      days_worked: days.filter((d) => d.worked_minutes > 0).length,
      regular_minutes,
      overtime_minutes,
      lates: days.filter((d) => d.late).length,
      absences,
      total_minutes: regular_minutes + overtime_minutes,
      days,
    });
  }

  result.sort((a, b) => a.employee_number - b.employee_number);
  return { week_start: weekStart, week_end: weekEnd, employees: result, anomaly_count: anomalyCount };
}
