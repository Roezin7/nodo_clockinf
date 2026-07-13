import { Router } from 'express';
import { DateTime } from 'luxon';
import ExcelJS from 'exceljs';
import { z } from 'zod';
import { query, queryOne, withTransaction } from '../db.js';
import { badRequest, conflict, notFound, HttpError } from '../errors.js';
import {
  requireAuth,
  requireAdmin,
  requireOrganization,
  requireRole,
} from '../middleware/auth.js';
import { computeWeek, type WeekComputation } from '../services/attendanceService.js';
import { getSettings } from '../services/settingsService.js';
import type { WeekEmployeeCalc } from '../types.js';
import {
  canFinalizeWeek,
  lockPayPeriod,
  snapshotHash,
  weekBoundsForDate,
  type PayPeriodStatus,
} from '../services/payPeriodService.js';
import { recordAudit } from '../services/auditService.js';
import {
  deviceHealthReasons,
  periodHeartbeatBoundary,
} from '../services/deviceHealth.js';

export const reportsRouter = Router();
reportsRouter.use(requireAuth, requireRole('admin', 'accountant'));

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Normaliza cualquier fecha al inicio de su semana según settings.week_start_day. */
async function normalizeWeekStart(organizationId: string, date: string): Promise<string> {
  const settings = await getSettings(organizationId);
  return weekBoundsForDate(date, settings.timezone).weekStart;
}

interface PeriodReportRow {
  id: string;
  week_start: string;
  week_end: string;
  status: PayPeriodStatus;
  current_version: number;
  snapshot: WeekComputation | null;
  snapshot_hash: string | null;
  finalized_at: Date | null;
  finalized_by_name: string | null;
}

interface DeviceHealthBlocker {
  id: string;
  name: string;
  plant_name: string;
  reasons: string[];
  pending_event_count: number;
  rejected_event_count: number;
  last_heartbeat_at: Date | null;
  storage_status: 'unknown' | 'ready' | 'degraded' | 'unavailable';
}

async function finalizationDeviceHealthBlockers(
  client: import('pg').PoolClient,
  organizationId: string,
  requiredHeartbeatAfter: Date,
  now = new Date()
): Promise<DeviceHealthBlocker[]> {
  const result = await client.query<{
    id: string;
    name: string;
    plant_name: string;
    pending_event_count: number;
    rejected_event_count: number;
    last_heartbeat_at: Date | null;
    storage_status: 'unknown' | 'ready' | 'degraded' | 'unavailable';
  }>(
    `SELECT d.id, d.name, p.name AS plant_name, d.pending_event_count,
            d.rejected_event_count, d.last_heartbeat_at, d.storage_status
     FROM devices d
     JOIN plants p ON p.id = d.plant_id AND p.organization_id = d.organization_id
     WHERE d.organization_id = $1 AND d.active AND d.enrolled_at IS NOT NULL
     ORDER BY p.code, d.name`,
    [organizationId]
  );
  return result.rows.flatMap((device) => {
    const reasons = deviceHealthReasons(device, now, requiredHeartbeatAfter);
    return reasons.length ? [{ ...device, reasons }] : [];
  });
}

async function getPeriodReport(organizationId: string, weekStart: string): Promise<PeriodReportRow | null> {
  return queryOne<PeriodReportRow>(
    `SELECT p.id, p.week_start, p.week_end, p.status, p.current_version,
            rv.snapshot, rv.snapshot_hash, rv.finalized_at,
            u.name AS finalized_by_name
     FROM pay_periods p
     LEFT JOIN report_versions rv
       ON rv.pay_period_id = p.id AND rv.version = p.current_version
     LEFT JOIN users u ON u.id = rv.finalized_by
     WHERE p.organization_id = $1 AND p.week_start = $2::date`,
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

  const period = await getPeriodReport(organizationId, weekStart);
  if (period?.status === 'final' && period.snapshot) {
    res.json({
      ...hoursOnly(period.snapshot),
      status: 'final',
      version: period.current_version,
      snapshot_hash: period.snapshot_hash,
      finalized_at: period.finalized_at,
      finalized_by: period.finalized_by_name,
    });
    return;
  }
  const computation = await computeWeek(organizationId, weekStart);
  res.json({
    ...hoursOnly(computation),
    status: period?.status ?? 'open',
    version: period?.current_version ?? 0,
  });
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

  const body = z
    .object({
      reason: z.string().trim().min(3).optional(),
      override_device_health: z.boolean().default(false),
    })
    .strict()
    .superRefine((value, context) => {
      if (value.override_device_health && !value.reason) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['reason'],
          message: 'La razón es obligatoria para ignorar la salud de dispositivos',
        });
      }
    })
    .parse(req.body ?? {});
  const settings = await getSettings(organizationId);
  let closed: { id: string; version: number; snapshot_hash: string };
  try {
    closed = await withTransaction(async (client) => {
      const period = await lockPayPeriod(client, organizationId, weekStart, settings.timezone);
      if (period.status === 'final') throw conflict('Esta semana ya está cerrada');
      if (!canFinalizeWeek(period.week_end, new Date(), settings.timezone)) {
        throw conflict('La semana todavía no termina en California', 'week_not_ended');
      }

      const deviceHealthBlockers = await finalizationDeviceHealthBlockers(
        client,
        organizationId,
        periodHeartbeatBoundary(period.week_end, settings.timezone)
      );
      if (deviceHealthBlockers.length && !body.override_device_health) {
        throw conflict(
          `No se puede cerrar: ${deviceHealthBlockers.length} checador(es) requieren atención`,
          'device_health_blockers',
          { devices: deviceHealthBlockers, pay_period_id: period.id }
        );
      }
      if (deviceHealthBlockers.length) {
        await recordAudit(
          {
            organizationId,
            actorUserId: req.user!.id,
            action: 'pay_period.device_health_overridden',
            entityType: 'pay_period',
            entityId: period.id,
            reason: body.reason!,
            metadata: { week_start: weekStart, devices: deviceHealthBlockers },
          },
          client
        );
      }

      // Every mutation obtains the same advisory lock, so this calculation and
      // snapshot cannot race a foreman correction.
      const computation = await computeWeek(organizationId, weekStart);
      if (computation.anomaly_count > 0) {
        throw conflict(
          `No se puede cerrar: hay ${computation.anomaly_count} incidencia(s) bloqueante(s).`,
          'anomalies_pending'
        );
      }
      const version = period.current_version + 1;
      const snapshot = hoursOnly(computation);
      const hash = snapshotHash(snapshot);
      const inserted = await client.query<{ id: string; finalized_at: Date }>(
        `INSERT INTO report_versions
           (organization_id, pay_period_id, version, snapshot, snapshot_hash,
            finalized_by, finalization_reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, finalized_at`,
        [
          organizationId,
          period.id,
          version,
          JSON.stringify(snapshot),
          hash,
          req.user!.id,
          body.reason ?? null,
        ]
      );
      await client.query(
        `UPDATE pay_periods
         SET status = 'final', current_version = $3,
             finalized_at = $4, finalized_by = $5,
             updated_at = now()
         WHERE id = $1 AND organization_id = $2`,
        [period.id, organizationId, version, inserted.rows[0]!.finalized_at, req.user!.id]
      );
      await recordAudit(
        {
          organizationId,
          actorUserId: req.user!.id,
          action: 'pay_period.finalized',
          entityType: 'pay_period',
          entityId: period.id,
          reason: body.reason ?? null,
          metadata: {
            week_start: weekStart,
            version,
            snapshot_hash: hash,
            override_device_health: body.override_device_health,
            device_health_blockers: deviceHealthBlockers,
          },
        },
        client
      );
      return { id: inserted.rows[0]!.id, version, snapshot_hash: hash };
    });
  } catch (error) {
    if (
      error instanceof HttpError &&
      error.code === 'device_health_blockers'
    ) {
      const details = error.details as {
        pay_period_id: string;
        devices: DeviceHealthBlocker[];
      };
      await recordAudit({
        organizationId,
        actorUserId: req.user!.id,
        action: 'pay_period.finalization_blocked_device_health',
        entityType: 'pay_period',
        entityId: details.pay_period_id,
        metadata: { week_start: weekStart, devices: details.devices },
      });
    }
    throw error;
  }
  res.status(201).json({ ok: true, ...closed, week_start: weekStart });
});

reportsRouter.post('/week/:weekStart/reopen', requireAdmin, async (req, res) => {
  const param = String(req.params.weekStart);
  if (!DATE_RE.test(param)) throw badRequest('Fecha inválida');
  const organizationId = requireOrganization(req);
  const weekStart = await normalizeWeekStart(organizationId, param);
  const body = z.object({ reason: z.string().trim().min(3, 'La razón es obligatoria') }).parse(req.body);
  const settings = await getSettings(organizationId);

  const period = await withTransaction(async (client) => {
    const locked = await lockPayPeriod(client, organizationId, weekStart, settings.timezone);
    if (locked.status !== 'final') throw conflict('Solo una semana final puede reabrirse');
    await client.query(
      `UPDATE pay_periods
       SET status = 'reopened', reopened_at = now(), reopened_by = $3,
           reopen_reason = $4, updated_at = now()
       WHERE id = $1 AND organization_id = $2`,
      [locked.id, organizationId, req.user!.id, body.reason]
    );
    await recordAudit(
      {
        organizationId,
        actorUserId: req.user!.id,
        action: 'pay_period.reopened',
        entityType: 'pay_period',
        entityId: locked.id,
        reason: body.reason,
        metadata: { week_start: weekStart, prior_version: locked.current_version },
      },
      client
    );
    return locked;
  });
  res.json({ ok: true, id: period.id, week_start: weekStart, status: 'reopened' });
});

reportsRouter.get('/week/:weekStart/versions', async (req, res) => {
  if (!DATE_RE.test(req.params.weekStart)) throw badRequest('Fecha inválida');
  const organizationId = requireOrganization(req);
  const weekStart = await normalizeWeekStart(organizationId, req.params.weekStart);
  res.json(
    await query(
      `SELECT rv.id, rv.version, rv.snapshot_hash, rv.finalized_at,
              rv.finalized_by, u.name AS finalized_by_name, rv.finalization_reason
       FROM report_versions rv
       JOIN pay_periods p ON p.id = rv.pay_period_id
       JOIN users u ON u.id = rv.finalized_by
       WHERE rv.organization_id = $1 AND p.week_start = $2::date
       ORDER BY rv.version DESC`,
      [organizationId, weekStart]
    )
  );
});

/** Recupera exactamente el snapshot histórico que vio la contadora. */
reportsRouter.get('/week/:weekStart/versions/:version', async (req, res) => {
  if (!DATE_RE.test(req.params.weekStart)) throw badRequest('Fecha inválida');
  const version = z.coerce.number().int().positive().parse(req.params.version);
  const organizationId = requireOrganization(req);
  const weekStart = await normalizeWeekStart(organizationId, req.params.weekStart);
  const historical = await queryOne<{
    snapshot: WeekComputation;
    snapshot_hash: string;
    finalized_at: Date;
    finalized_by_name: string;
  }>(
    `SELECT rv.snapshot, rv.snapshot_hash, rv.finalized_at,
            u.name AS finalized_by_name
     FROM report_versions rv
     JOIN pay_periods p ON p.id = rv.pay_period_id
     JOIN users u ON u.id = rv.finalized_by
     WHERE rv.organization_id = $1
       AND p.week_start = $2::date
       AND rv.version = $3`,
    [organizationId, weekStart, version]
  );
  if (!historical) throw notFound('La versión solicitada no existe');
  res.json({
    ...hoursOnly(historical.snapshot),
    status: 'final',
    version,
    snapshot_hash: historical.snapshot_hash,
    finalized_at: historical.finalized_at,
    finalized_by: historical.finalized_by_name,
  });
});

reportsRouter.get('/weeks', async (req, res) => {
  res.json(
    await query(
      `SELECT p.id, p.week_start, p.week_end, p.status, p.current_version,
              rv.finalized_at, u.name AS finalized_by_name, rv.snapshot_hash
       FROM pay_periods p
       LEFT JOIN report_versions rv
         ON rv.pay_period_id = p.id AND rv.version = p.current_version
       LEFT JOIN users u ON u.id = rv.finalized_by
       WHERE p.organization_id = $1
       ORDER BY p.week_start DESC LIMIT 52`
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

  const period = await getPeriodReport(organizationId, weekStart);
  const isFinal = period?.status === 'final' && Boolean(period.snapshot);
  const computation = hoursOnly(
    isFinal ? period!.snapshot! : await computeWeek(organizationId, weekStart)
  );
  const tz = (await getSettings(organizationId)).timezone;
  const suffix = isFinal ? `-v${period!.current_version}` : '-BORRADOR';
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
