import { Router } from 'express';
import { DateTime } from 'luxon';
import ExcelJS from 'exceljs';
import { z } from 'zod';
import { query, queryOne } from '../db.js';
import { badRequest, conflict } from '../errors.js';
import {
  requireAuth,
  requireAdmin,
  requireOrganization,
  requireRole,
} from '../middleware/auth.js';
import { computeWeek, type WeekComputation } from '../services/attendanceService.js';
import { getSettings } from '../services/settingsService.js';
import type { WeekEmployeeCalc } from '../types.js';

export const reportsRouter = Router();
reportsRouter.use(requireAuth, requireRole('admin', 'accountant'));

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Normaliza cualquier fecha al inicio de su semana según settings.week_start_day. */
async function normalizeWeekStart(organizationId: string, date: string): Promise<string> {
  const settings = await getSettings(organizationId);
  const d = DateTime.fromISO(date, { zone: settings.timezone });
  const diff = (d.weekday - settings.week_start_day + 7) % 7;
  return d.minus({ days: diff }).toISODate()!;
}

interface FinalReportRow {
  id: string;
  week_start: string;
  week_end: string;
  generated_at: Date;
  status: string;
  data: WeekComputation;
  generated_by_name: string;
}

async function getFinalReport(organizationId: string, weekStart: string): Promise<FinalReportRow | null> {
  return queryOne<FinalReportRow>(
    `SELECT w.*, u.name AS generated_by_name
     FROM weekly_reports w JOIN users u ON u.id = w.generated_by
     WHERE w.organization_id = $1 AND w.week_start = $2::date AND w.status = 'final'`,
    [organizationId, weekStart]
  );
}

function hoursOnly(computation: WeekComputation): WeekComputation {
  return {
    ...computation,
    policy: 'CA_STANDARD_8_40',
    employees: computation.employees.map((employee) => {
      const regularSeconds = employee.regular_seconds ?? employee.regular_minutes * 60;
      const overtimeSeconds = employee.overtime_seconds ?? employee.overtime_minutes * 60;
      const doubleTimeSeconds = employee.double_time_seconds ?? 0;
      const totalSeconds = employee.total_seconds ?? employee.total_minutes * 60;
      const manualSeconds = employee.manual_seconds ?? 0;
      const clockedSeconds = employee.clocked_seconds ?? totalSeconds - manualSeconds;
      return {
        ...employee,
        regular_seconds: regularSeconds,
        overtime_seconds: overtimeSeconds,
        double_time_seconds: doubleTimeSeconds,
        total_seconds: totalSeconds,
        manual_seconds: manualSeconds,
        clocked_seconds: clockedSeconds,
        double_time_minutes: doubleTimeSeconds / 60,
        manual_minutes: manualSeconds / 60,
        clocked_minutes: clockedSeconds / 60,
        social_security: null,
        lates: 0,
        absences: 0,
        days: employee.days.map((day) => ({
          ...day,
          meal_seconds: day.meal_seconds ?? day.meal_minutes * 60,
          worked_seconds: day.worked_seconds ?? day.worked_minutes * 60,
          late: false,
          late_minutes: 0,
        })),
      };
    }),
  };
}

reportsRouter.get('/week/:weekStart', async (req, res) => {
  if (!DATE_RE.test(req.params.weekStart)) throw badRequest('Fecha inválida');
  const organizationId = requireOrganization(req);
  const weekStart = await normalizeWeekStart(organizationId, req.params.weekStart);

  const final = await getFinalReport(organizationId, weekStart);
  if (final) {
    res.json({
      ...hoursOnly(final.data),
      status: 'final',
      finalized_at: final.generated_at,
      finalized_by: final.generated_by_name,
    });
    return;
  }
  const computation = await computeWeek(organizationId, weekStart);
  res.json({ ...hoursOnly(computation), status: 'draft' });
});

/**
 * Cierre de semana: snapshot inmutable para el contador. No se permite cerrar
 * con anomalías sin resolver.
 */
reportsRouter.post('/week/:weekStart/finalize', requireAdmin, async (req, res) => {
  const param = String(req.params.weekStart);
  if (!DATE_RE.test(param)) throw badRequest('Fecha inválida');
  const organizationId = requireOrganization(req);
  const weekStart = await normalizeWeekStart(organizationId, param);

  if (await getFinalReport(organizationId, weekStart)) throw conflict('Esta semana ya está cerrada');

  const computation = await computeWeek(organizationId, weekStart);
  if (computation.anomaly_count > 0) {
    throw conflict(
      `No se puede cerrar: hay ${computation.anomaly_count} anomalía(s) sin resolver. Corrígelas en Asistencia.`,
      'anomalies_pending'
    );
  }

  const row = await queryOne<{ id: string }>(
    `INSERT INTO weekly_reports (organization_id, week_start, week_end, generated_by, data, status)
     VALUES ($1, $2::date, $3::date, $4, $5, 'final')
     RETURNING id`,
    [organizationId, weekStart, computation.week_end, req.user!.id, JSON.stringify(computation)]
  );
  res.status(201).json({ ok: true, id: row!.id, week_start: weekStart });
});

reportsRouter.get('/weeks', async (req, res) => {
  res.json(
    await query(
      `SELECT w.id, w.week_start, w.week_end, w.status, w.generated_at, u.name AS generated_by_name
       FROM weekly_reports w JOIN users u ON u.id = w.generated_by
       WHERE w.organization_id = $1
       ORDER BY w.week_start DESC LIMIT 52`
      , [requireOrganization(req)]
    )
  );
});

// ---------- Export ----------

const hours = (min: number): number => Math.round((min / 60) * 10_000) / 10_000;
const secondsHours = (seconds: number | undefined, fallbackMinutes = 0): number =>
  Math.round(((seconds ?? fallbackMinutes * 60) / 3600) * 10_000) / 10_000;

function localTime(iso: string | null, timezone: string): string {
  if (!iso) return '';
  return DateTime.fromISO(iso).setZone(timezone).toFormat('HH:mm');
}

const SUMMARY_HEADERS = [
  '# Empleado', 'Nombre', 'Días trabajados', 'Hrs regulares', 'Hrs OT 1.5x',
  'Hrs double 2x', 'Horas manuales', 'Total hrs',
];

function summaryRow(e: WeekEmployeeCalc): (string | number)[] {
  return [
    e.employee_number,
    e.full_name,
    e.days_worked,
    secondsHours(e.regular_seconds, e.regular_minutes),
    secondsHours(e.overtime_seconds, e.overtime_minutes),
    secondsHours(e.double_time_seconds, e.double_time_minutes),
    secondsHours(e.manual_seconds, e.manual_minutes),
    secondsHours(e.total_seconds, e.total_minutes),
  ];
}

const DETAIL_HEADERS = [
  '# Empleado', 'Nombre', 'Fecha', 'Entrada', 'Salida', 'Comida (min)', 'Horas del día', 'Incompleto',
];

function detailRows(employees: WeekEmployeeCalc[], timezone: string): (string | number)[][] {
  const rows: (string | number)[][] = [];
  for (const e of employees) {
    for (const d of e.days) {
      rows.push([
        e.employee_number,
        e.full_name,
        d.work_date,
        localTime(d.shift_in, timezone),
        localTime(d.shift_out, timezone),
        d.meal_minutes,
        hours(d.worked_minutes),
        d.complete ? '' : 'SÍ',
      ]);
    }
  }
  return rows;
}

function toCsv(headers: string[], rows: (string | number)[][]): string {
  const esc = (v: string | number): string => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers, ...rows].map((r) => r.map(esc).join(',')).join('\r\n');
}

const exportSchema = z.object({
  format: z.enum(['xlsx', 'csv']).default('xlsx'),
  sheet: z.enum(['summary', 'detail']).default('summary'),
});

reportsRouter.get('/week/:weekStart/export', async (req, res) => {
  if (!DATE_RE.test(req.params.weekStart)) throw badRequest('Fecha inválida');
  const organizationId = requireOrganization(req);
  const weekStart = await normalizeWeekStart(organizationId, req.params.weekStart);
  const { format, sheet } = exportSchema.parse(req.query);

  const final = await getFinalReport(organizationId, weekStart);
  const computation = hoursOnly(final ? final.data : await computeWeek(organizationId, weekStart));
  const tz = (await getSettings(organizationId)).timezone;
  const suffix = final ? '' : '-BORRADOR';
  const base = `nomina-semana-${weekStart}${suffix}`;

  if (format === 'csv') {
    const csv =
      sheet === 'detail'
        ? toCsv(DETAIL_HEADERS, detailRows(computation.employees, tz))
        : toCsv(SUMMARY_HEADERS, computation.employees.map(summaryRow));
    res
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${base}-${sheet === 'detail' ? 'detalle' : 'resumen'}.csv"`)
      .send('﻿' + csv); // BOM para Excel en Windows
    return;
  }

  const wb = new ExcelJS.Workbook();
  const styleHeader = (ws: ExcelJS.Worksheet): void => {
    ws.getRow(1).font = { bold: true };
    ws.columns.forEach((col) => {
      let max = 10;
      col.eachCell?.({ includeEmpty: false }, (cell) => {
        max = Math.max(max, String(cell.value ?? '').length + 2);
      });
      col.width = Math.min(max, 34);
    });
  };

  const ws1 = wb.addWorksheet('Resumen');
  ws1.addRow(SUMMARY_HEADERS);
  for (const e of computation.employees) ws1.addRow(summaryRow(e));
  styleHeader(ws1);

  const ws2 = wb.addWorksheet('Detalle por día');
  ws2.addRow(DETAIL_HEADERS);
  for (const r of detailRows(computation.employees, tz)) ws2.addRow(r);
  styleHeader(ws2);

  res
    .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    .header('Content-Disposition', `attachment; filename="${base}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
});
