import { Router } from 'express';
import { DateTime } from 'luxon';
import ExcelJS from 'exceljs';
import { z } from 'zod';
import { query, queryOne } from '../db.js';
import { badRequest, conflict } from '../errors.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { computeWeek, type WeekComputation } from '../services/attendanceService.js';
import { getSettings } from '../services/settingsService.js';
import type { WeekEmployeeCalc } from '../types.js';

export const reportsRouter = Router();
reportsRouter.use(requireAuth);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Normaliza cualquier fecha al inicio de su semana según settings.week_start_day. */
async function normalizeWeekStart(date: string): Promise<string> {
  const settings = await getSettings();
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

async function getFinalReport(weekStart: string): Promise<FinalReportRow | null> {
  return queryOne<FinalReportRow>(
    `SELECT w.*, u.name AS generated_by_name
     FROM weekly_reports w JOIN users u ON u.id = w.generated_by
     WHERE w.week_start = $1::date AND w.status = 'final'`,
    [weekStart]
  );
}

reportsRouter.get('/week/:weekStart', async (req, res) => {
  if (!DATE_RE.test(req.params.weekStart)) throw badRequest('Fecha inválida');
  const weekStart = await normalizeWeekStart(req.params.weekStart);

  const final = await getFinalReport(weekStart);
  if (final) {
    res.json({
      ...final.data,
      status: 'final',
      finalized_at: final.generated_at,
      finalized_by: final.generated_by_name,
    });
    return;
  }
  const computation = await computeWeek(weekStart);
  res.json({ ...computation, status: 'draft' });
});

/**
 * Cierre de semana: snapshot inmutable para el contador. No se permite cerrar
 * con anomalías sin resolver.
 */
reportsRouter.post('/week/:weekStart/finalize', requireAdmin, async (req, res) => {
  const param = String(req.params.weekStart);
  if (!DATE_RE.test(param)) throw badRequest('Fecha inválida');
  const weekStart = await normalizeWeekStart(param);

  if (await getFinalReport(weekStart)) throw conflict('Esta semana ya está cerrada');

  const computation = await computeWeek(weekStart);
  if (computation.anomaly_count > 0) {
    throw conflict(
      `No se puede cerrar: hay ${computation.anomaly_count} anomalía(s) sin resolver. Corrígelas en Asistencia.`,
      'anomalies_pending'
    );
  }

  const row = await queryOne<{ id: string }>(
    `INSERT INTO weekly_reports (week_start, week_end, generated_by, data, status)
     VALUES ($1::date, $2::date, $3, $4, 'final')
     RETURNING id`,
    [weekStart, computation.week_end, req.user!.id, JSON.stringify(computation)]
  );
  res.status(201).json({ ok: true, id: row!.id, week_start: weekStart });
});

reportsRouter.get('/weeks', async (_req, res) => {
  res.json(
    await query(
      `SELECT w.id, w.week_start, w.week_end, w.status, w.generated_at, u.name AS generated_by_name
       FROM weekly_reports w JOIN users u ON u.id = w.generated_by
       ORDER BY w.week_start DESC LIMIT 52`
    )
  );
});

// ---------- Export ----------

const hours = (min: number): number => Math.round((min / 60) * 100) / 100;

function localTime(iso: string | null, timezone: string): string {
  if (!iso) return '';
  return DateTime.fromISO(iso).setZone(timezone).toFormat('HH:mm');
}

const SUMMARY_HEADERS = [
  '# Empleado', 'Nombre', 'Seguro', 'Días trab.', 'Hrs regulares', 'Hrs OT', 'Retardos', 'Faltas', 'Total hrs',
];

function summaryRow(e: WeekEmployeeCalc): (string | number)[] {
  return [
    e.employee_number,
    e.full_name,
    e.social_security ?? '',
    e.days_worked,
    hours(e.regular_minutes),
    hours(e.overtime_minutes),
    e.lates,
    e.absences,
    hours(e.total_minutes),
  ];
}

const DETAIL_HEADERS = [
  '# Empleado', 'Nombre', 'Fecha', 'Entrada', 'Salida', 'Comida (min)', 'Horas del día', 'Retardo', 'Incompleto',
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
        d.late ? `Sí (+${d.late_minutes}m)` : '',
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
  const weekStart = await normalizeWeekStart(req.params.weekStart);
  const { format, sheet } = exportSchema.parse(req.query);

  const final = await getFinalReport(weekStart);
  const computation = final ? final.data : await computeWeek(weekStart);
  const tz = (await getSettings()).timezone;
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
