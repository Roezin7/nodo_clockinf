import { Router } from 'express';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { query } from '../db.js';
import { badRequest } from '../errors.js';
import {
  requireAdmin,
  requireAuth,
  requireOrganization,
  requireRole,
} from '../middleware/auth.js';
import {
  calculateCostWeeks,
  decimal4Ratio,
  loadDashboardCostInputs,
  mergeMetrics,
  subtractDecimalMoney,
  withSyntheticOpenProjection,
  type DashboardLaborMetric,
  type DashboardWeekCost,
  type MissingRateRow,
} from '../services/dashboardCosts.js';
import { weekBoundsForDate } from '../services/payPeriodService.js';
import { getSettings } from '../services/settingsService.js';
import { accessiblePlantIds } from '../services/tenantService.js';

export const dashboardRouter = Router();
dashboardRouter.use(requireAuth);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function noStore(res: import('express').Response): void {
  res.header('Cache-Control', 'private, no-store, max-age=0');
  res.header('Pragma', 'no-cache');
}

interface OperationsPlant {
  id: string;
  code: string;
  name: string;
}

interface OperationsWorkerRow {
  employee_id: string;
  employee_number: number;
  full_name: string;
  employee_active: boolean;
  plant_id: string;
  punch_type: 'shift_in' | 'shift_out' | 'meal_out' | 'meal_in';
  punched_at: Date;
}

interface OperationsDeviceRow {
  id: string;
  plant_id: string;
  name: string;
  active: boolean;
  enrolled_at: Date | null;
  last_heartbeat_at: Date | null;
  last_sync_at: Date | null;
  pending_event_count: number;
  rejected_event_count: number;
  camera_status: 'unknown' | 'ready' | 'degraded' | 'unavailable';
  storage_status: 'unknown' | 'ready' | 'degraded' | 'unavailable';
  clock_skew_seconds: number | null;
}

export function dashboardDeviceFlags(device: OperationsDeviceRow, now: Date): string[] {
  const flags: string[] = [];
  if (device.pending_event_count > 0) flags.push('queue_pending');
  if (device.rejected_event_count > 0) flags.push('events_rejected');
  if (!device.last_heartbeat_at) flags.push('heartbeat_missing');
  else if (now.getTime() - device.last_heartbeat_at.getTime() > 24 * 3_600_000) {
    flags.push('heartbeat_stale');
  }
  if (device.storage_status !== 'ready') flags.push('storage_attention');
  if (device.camera_status !== 'ready') flags.push('camera_attention');
  if (device.clock_skew_seconds !== null && Math.abs(device.clock_skew_seconds) > 300) {
    flags.push('clock_skew');
  }
  return flags;
}

function syncStatus(
  device: OperationsDeviceRow,
  now: Date,
): 'healthy' | 'attention' | 'offline' | 'unknown' {
  if (!device.active) return 'offline';
  if (
    device.last_heartbeat_at
    && now.getTime() - device.last_heartbeat_at.getTime() > 24 * 3_600_000
  ) return 'offline';
  if (!device.last_heartbeat_at && !device.last_sync_at) return 'unknown';
  return dashboardDeviceFlags(device, now).length > 0 ? 'attention' : 'healthy';
}

dashboardRouter.get(
  '/operations',
  requireRole('admin', 'foreman'),
  async (req, res) => {
    const organizationId = requireOrganization(req);
    const settings = await getSettings(organizationId);
    const plantIds = await accessiblePlantIds(req.user!);
    const now = new Date();
    const plants = await query<OperationsPlant>(
      `SELECT id, code, name
       FROM plants
       WHERE organization_id = $1 AND active AND id = ANY($2::uuid[])
       ORDER BY code`,
      [organizationId, plantIds],
    );
    const workers = await query<OperationsWorkerRow>(
      `SELECT DISTINCT ON (p.employee_id, p.plant_id)
              p.employee_id, e.employee_number, e.full_name, e.active AS employee_active, p.plant_id,
              p.punch_type, p.punched_at
       FROM punches p
       JOIN employees e
         ON e.id = p.employee_id AND e.organization_id = p.organization_id
       WHERE p.organization_id = $1 AND p.plant_id = ANY($2::uuid[])
         AND NOT p.voided AND p.punched_at <= $3::timestamptz
       ORDER BY p.employee_id, p.plant_id, p.punched_at DESC, p.created_at DESC, p.id DESC`,
      [organizationId, plantIds, now],
    );
    const identityCounts = await query<{ plant_id: string; count: number }>(
      `SELECT plant_id, count(*)::integer AS count
       FROM punches
       WHERE organization_id = $1 AND plant_id = ANY($2::uuid[])
         AND NOT voided AND identity_status = 'identity_review'
       GROUP BY plant_id`,
      [organizationId, plantIds],
    );
    const exceptionCounts = await query<{
      plant_id: string;
      blockers: number;
      warnings: number;
      total: number;
      organization_total: number;
    }>(
      `WITH visible AS (
         SELECT DISTINCT e.id, e.organization_id, e.severity
         FROM operational_exceptions e
         JOIN operational_exception_plants linked
           ON linked.exception_id = e.id AND linked.organization_id = e.organization_id
         WHERE e.organization_id = $1 AND linked.plant_id = ANY($2::uuid[])
           AND e.status IN ('open', 'acknowledged')
           AND ($3::boolean OR NOT EXISTS (
             SELECT 1 FROM operational_exception_plants outside
             WHERE outside.exception_id = e.id
               AND outside.organization_id = e.organization_id
               AND NOT (outside.plant_id = ANY($2::uuid[]))
           ))
       )
       SELECT ep.plant_id,
              count(*) FILTER (WHERE visible.severity = 'blocker')::integer AS blockers,
              count(*) FILTER (WHERE visible.severity = 'warning')::integer AS warnings,
              count(*)::integer AS total,
              (SELECT count(*)::integer FROM visible) AS organization_total
       FROM visible
       JOIN operational_exception_plants ep
         ON ep.exception_id = visible.id AND ep.organization_id = visible.organization_id
        AND ep.plant_id = ANY($2::uuid[])
       GROUP BY ep.plant_id`,
      [organizationId, plantIds, req.user!.role === 'admin'],
    );
    const devices = await query<OperationsDeviceRow>(
      `SELECT id, plant_id, name, active, enrolled_at, last_heartbeat_at, last_sync_at,
              pending_event_count, rejected_event_count, camera_status,
              storage_status, clock_skew_seconds
       FROM devices
       WHERE organization_id = $1 AND plant_id = ANY($2::uuid[])
       ORDER BY plant_id, name`,
      [organizationId, plantIds],
    );

    const identityByPlant = new Map(identityCounts.map((row) => [row.plant_id, row.count]));
    const exceptionsByPlant = new Map(exceptionCounts.map((row) => [row.plant_id, row]));
    const result = plants.map((plant) => {
      const plantWorkers = workers.filter((worker) => worker.plant_id === plant.id);
      const openWorkers = plantWorkers.filter((worker) => worker.punch_type !== 'shift_out');
      const isStale = (worker: OperationsWorkerRow): boolean =>
        !worker.employee_active || now.getTime() - worker.punched_at.getTime() > 16 * 3_600_000;
      const inside = openWorkers
        .filter((worker) => !isStale(worker)
          && (worker.punch_type === 'shift_in' || worker.punch_type === 'meal_in'))
        .map((worker) => ({
          employee_number: worker.employee_number,
          full_name: worker.full_name,
          state: 'inside' as const,
          since: worker.punched_at,
          stale: false as const,
        }));
      const onMeal = openWorkers
        .filter((worker) => !isStale(worker) && worker.punch_type === 'meal_out')
        .map((worker) => ({
          employee_number: worker.employee_number,
          full_name: worker.full_name,
          state: 'on_meal' as const,
          since: worker.punched_at,
          stale: false as const,
        }));
      const staleOpen = openWorkers
        .filter(isStale)
        .map((worker) => ({
          employee_number: worker.employee_number,
          full_name: worker.full_name,
          state: 'stale_open' as const,
          since: worker.punched_at,
          stale: true as const,
          employee_active: worker.employee_active,
          last_punch_type: worker.punch_type,
        }));
      const plantDevices = devices.filter((device) => device.plant_id === plant.id).map((device) => ({
        id: device.id,
        name: device.name,
        active: device.active,
        enrolled: Boolean(device.enrolled_at),
        last_heartbeat_at: device.last_heartbeat_at,
        last_sync_at: device.last_sync_at,
        pending_event_count: device.pending_event_count,
        rejected_event_count: device.rejected_event_count,
        camera_status: device.camera_status,
        storage_status: device.storage_status,
        sync_status: syncStatus(device, now),
        health_flags: dashboardDeviceFlags(device, now),
      }));
      const exceptions = exceptionsByPlant.get(plant.id) ?? {
        blockers: 0,
        warnings: 0,
        total: 0,
      };
      return {
        id: plant.id,
        code: plant.code,
        name: plant.name,
        workers: {
          inside,
          on_meal: onMeal,
          stale_open: staleOpen,
          inside_count: inside.length,
          on_meal_count: onMeal.length,
          stale_open_count: staleOpen.length,
          open_sequences_count: inside.length + onMeal.length + staleOpen.length,
        },
        identity_reviews_open: identityByPlant.get(plant.id) ?? 0,
        exceptions_open: {
          blockers: exceptions.blockers,
          warnings: exceptions.warnings,
          total: exceptions.total,
        },
        devices: plantDevices,
      };
    });

    noStore(res);
    res.json({
      generated_at: now,
      timezone: settings.timezone,
      plants: result,
      totals: {
        inside: result.reduce((sum, plant) => sum + plant.workers.inside_count, 0),
        on_meal: result.reduce((sum, plant) => sum + plant.workers.on_meal_count, 0),
        stale_open: result.reduce((sum, plant) => sum + plant.workers.stale_open_count, 0),
        open_sequences: result.reduce((sum, plant) => sum + plant.workers.open_sequences_count, 0),
        identity_reviews_open: result.reduce((sum, plant) => sum + plant.identity_reviews_open, 0),
        exceptions_open: exceptionCounts[0]?.organization_total ?? 0,
        devices_attention: result.reduce(
          (sum, plant) => sum + plant.devices.filter(
            (device) => device.active && device.enrolled && device.health_flags.length > 0,
          ).length,
          0,
        ),
      },
    });
  },
);

function emptyUnavailableMetric(hours: Record<string, unknown>): DashboardLaborMetric {
  const regular = Number(hours.regular_seconds) || 0;
  const overtime = Number(hours.overtime_seconds) || 0;
  const doubleTime = Number(hours.double_time_seconds) || 0;
  const clock = Number(hours.clocked_seconds) || 0;
  const manual = Number(hours.manual_seconds) || 0;
  const total = Number(hours.total_seconds) || regular + overtime + doubleTime;
  return {
    seconds: {
      regular,
      overtime_1_5: overtime,
      double_time: doubleTime,
      clock,
      manual,
      total,
      costed: 0,
      uncosted: total,
    },
    direct_cost_by_bucket_costed: {
      regular: '0.0000', overtime_1_5: '0.0000', double_time: '0.0000',
    },
    direct_cost_costed: '0.0000',
    direct_cost_complete: null,
    coverage_ratio: total > 0 ? '0.0000' : '1.0000',
  };
}

function comparison(actual: DashboardLaborMetric, previous: DashboardLaborMetric): Record<string, unknown> {
  return {
    total_seconds_delta: actual.seconds.total - previous.seconds.total,
    regular_seconds_delta: actual.seconds.regular - previous.seconds.regular,
    overtime_seconds_delta: actual.seconds.overtime_1_5 - previous.seconds.overtime_1_5,
    double_time_seconds_delta: actual.seconds.double_time - previous.seconds.double_time,
    manual_seconds_delta: actual.seconds.manual - previous.seconds.manual,
    direct_cost_delta:
      actual.direct_cost_complete !== null && previous.direct_cost_complete !== null
        ? subtractDecimalMoney(actual.direct_cost_complete, previous.direct_cost_complete)
        : null,
  };
}

function thresholdCounts(rows: DashboardWeekCost['thresholds']): Record<string, number> {
  const count = (code: DashboardWeekCost['thresholds'][number]['code']): number =>
    rows.filter((row) => row.code === code).length;
  return {
    daily_7_to_8: count('near_8h'),
    daily_11_to_12: count('near_12h'),
    weekly_36_to_40: count('near_40h'),
    daily_at_or_over_8: count('at_8h'),
    daily_at_or_over_12: count('at_12h'),
    weekly_at_or_over_40: count('at_40h'),
  };
}

function publicPlants(plants: DashboardWeekCost['plants']): Array<Record<string, unknown>> {
  return plants.map((plant) => ({
    id: plant.plant_id,
    code: plant.code,
    name: plant.name,
    metric: plant.metric,
  }));
}

dashboardRouter.get('/admin/current-week', requireAdmin, async (req, res) => {
  const organizationId = requireOrganization(req);
  const settings = await getSettings(organizationId);
  const now = new Date();
  const localDate = DateTime.fromJSDate(now).setZone(settings.timezone).toISODate()!;
  const currentBounds = weekBoundsForDate(localDate, settings.timezone);
  const previousBounds = weekBoundsForDate(
    DateTime.fromISO(currentBounds.weekStart, { zone: settings.timezone }).minus({ days: 7 }).toISODate()!,
    settings.timezone,
  );
  const inputs = await loadDashboardCostInputs({
    organizationId,
    fromDate: previousBounds.weekStart,
    toDate: currentBounds.weekEnd,
    timezone: settings.timezone,
    now,
  });
  const actualWeeks = calculateCostWeeks(inputs);
  const projectedWeeks = calculateCostWeeks(withSyntheticOpenProjection(inputs));
  const actual = actualWeeks.find((week) => week.week_start === currentBounds.weekStart)!;
  const previousLive = actualWeeks.find((week) => week.week_start === previousBounds.weekStart)!;
  const projected = projectedWeeks.find((week) => week.week_start === currentBounds.weekStart)!;
  const previousFrozen = await query<FrozenCostRow>(
    `SELECT p.week_start, p.status, p.current_version,
            rv.snapshot AS accountant_snapshot, cs.snapshot AS cost_snapshot
     FROM pay_periods p
     LEFT JOIN report_versions rv
       ON rv.pay_period_id = p.id AND rv.organization_id = p.organization_id
      AND rv.version = p.current_version
     LEFT JOIN report_cost_snapshots cs
       ON cs.report_version_id = rv.id AND cs.organization_id = rv.organization_id
     WHERE p.organization_id = $1 AND p.week_start = $2::date`,
    [organizationId, previousBounds.weekStart],
  );
  const previousPeriod = previousFrozen[0];
  const frozenPreviousWeek = previousPeriod?.status === 'final'
    ? previousPeriod.cost_snapshot?.week ?? null
    : null;
  const previousMetric = frozenPreviousWeek?.metric
    ?? (previousPeriod?.status === 'final'
      ? legacySummaryMetric(previousPeriod.accountant_snapshot)
      : previousLive.metric);
  const previousMissingRates = frozenPreviousWeek?.missing_rates
    ?? (previousPeriod?.status === 'final' ? [] : previousLive.missing_rates);
  const previousCostStatus = previousPeriod?.status === 'final'
    ? frozenPreviousWeek
      ? frozenPreviousWeek.metric.direct_cost_complete === null
        ? 'frozen_missing_rates'
        : 'frozen_complete'
      : 'unavailable_legacy'
    : previousLive.metric.direct_cost_complete === null ? 'live_missing_rates' : 'live_complete';
  const manualSummary = await query<{
    active_entries: number;
    active_seconds: string | number;
    created_count: number;
    voided_count: number;
  }>(
    `SELECT
       count(*) FILTER (WHERE voided_at IS NULL)::integer AS active_entries,
       COALESCE(sum(duration_seconds) FILTER (WHERE voided_at IS NULL), 0) AS active_seconds,
       count(*)::integer AS created_count,
       count(*) FILTER (WHERE voided_at IS NOT NULL)::integer AS voided_count
     FROM manual_time_entries
     WHERE organization_id = $1 AND work_date BETWEEN $2::date AND $3::date`,
    [organizationId, currentBounds.weekStart, currentBounds.weekEnd],
  );
  const recentManualChanges = await query<{
    employee_number: number;
    full_name: string;
    plant_code: string;
    plant_name: string;
    work_date: string;
    duration_seconds: string | number;
    actor_name: string;
    created_at: Date;
    reason: string;
    change_type: 'created' | 'voided';
  }>(
    `SELECT employee_number, full_name, plant_code, plant_name, work_date,
            duration_seconds, actor_name, created_at, reason, change_type
     FROM (
       SELECT e.employee_number, e.full_name, p.code AS plant_code,
              p.name AS plant_name, m.work_date, m.duration_seconds,
              u.name AS actor_name, m.created_at, m.reason,
              'created'::text AS change_type
       FROM manual_time_entries m
       JOIN employees e ON e.id = m.employee_id AND e.organization_id = m.organization_id
       JOIN plants p ON p.id = m.plant_id AND p.organization_id = m.organization_id
       JOIN users u ON u.id = m.created_by AND u.organization_id = m.organization_id
       WHERE m.organization_id = $1
         AND m.created_at >= ($2::date AT TIME ZONE $4)
         AND m.created_at < (($3::date + 1) AT TIME ZONE $4)
       UNION ALL
       SELECT e.employee_number, e.full_name, p.code, p.name, m.work_date,
              m.duration_seconds, u.name, m.voided_at, m.void_reason,
              'voided'::text
       FROM manual_time_entries m
       JOIN employees e ON e.id = m.employee_id AND e.organization_id = m.organization_id
       JOIN plants p ON p.id = m.plant_id AND p.organization_id = m.organization_id
       JOIN users u ON u.id = m.voided_by AND u.organization_id = m.organization_id
       WHERE m.organization_id = $1 AND m.voided_at IS NOT NULL
         AND m.voided_at >= ($2::date AT TIME ZONE $4)
         AND m.voided_at < (($3::date + 1) AT TIME ZONE $4)
     ) changes
     ORDER BY created_at DESC
     LIMIT 20`,
    [organizationId, currentBounds.weekStart, currentBounds.weekEnd, settings.timezone],
  );
  const manual = manualSummary[0] ?? {
    active_entries: 0, active_seconds: 0, created_count: 0, voided_count: 0,
  };
  const syntheticOpenSequences = new Set(
    inputs.synthetic_open_chunks.map((chunk) => chunk.open_sequence_id),
  );
  const cappedOpenSequences = new Set(
    inputs.synthetic_open_chunks
      .filter((chunk) => chunk.capped_at_16_hours)
      .map((chunk) => chunk.open_sequence_id),
  );

  noStore(res);
  res.json({
    generated_at: now,
    timezone: settings.timezone,
    week_start: currentBounds.weekStart,
    week_end: currentBounds.weekEnd,
    as_of: now,
    disclaimer: 'Costo directo estimado; excluye cargas patronales, impuestos y beneficios.',
    actual: actual.metric,
    plants: publicPlants(actual.plants),
    thresholds: thresholdCounts(projected.thresholds),
    threshold_details: projected.thresholds,
    previous_week: {
      week_start: previousLive.week_start,
      week_end: previousLive.week_end,
      metric: previousMetric,
      missing_rates: previousMissingRates,
      cost_status: previousCostStatus,
      source: previousPeriod?.status === 'final'
        ? frozenPreviousWeek ? 'frozen_report_version' : 'legacy_report_without_cost_snapshot'
        : 'live',
      report_version: previousPeriod?.current_version ?? 0,
    },
    comparison: comparison(actual.metric, previousMetric),
    projection: {
      as_of: now,
      method: 'actual_plus_open_elapsed_capped_16h',
      synthetic: true,
      payable: false,
      synthetic_open_sequences: syntheticOpenSequences.size,
      capped_open_sequences: cappedOpenSequences.size,
      metric: projected.metric,
      plants: publicPlants(projected.plants),
      missing_rates: projected.missing_rates,
    },
    manual_activity: {
      active_entries: manual.active_entries,
      active_seconds: Number(manual.active_seconds),
      created_count: manual.created_count,
      voided_count: manual.voided_count,
      clock_seconds: actual.metric.seconds.clock,
      manual_seconds: actual.metric.seconds.manual,
      manual_to_clock_ratio: decimal4Ratio(
        actual.metric.seconds.manual,
        actual.metric.seconds.clock,
      ),
    },
    recent_manual_changes: recentManualChanges.map((change) => ({
      ...change,
      duration_seconds: Number(change.duration_seconds),
    })),
    missing_rates: actual.missing_rates,
  });
});

interface FrozenCostRow {
  week_start: string;
  status: 'open' | 'ready_for_review' | 'final' | 'reopened';
  current_version: number;
  accountant_snapshot: Record<string, unknown> | null;
  cost_snapshot: { week?: DashboardWeekCost } | null;
}

function legacySummaryMetric(snapshot: Record<string, unknown> | null): DashboardLaborMetric {
  const totals = snapshot?.totals && typeof snapshot.totals === 'object'
    ? snapshot.totals as Record<string, unknown>
    : null;
  if (totals) return emptyUnavailableMetric(totals);
  const employees = Array.isArray(snapshot?.employees) ? snapshot.employees : [];
  const aggregate = employees.reduce<Record<string, number>>((sum, employee) => {
    if (!employee || typeof employee !== 'object') return sum;
    const row = employee as Record<string, unknown>;
    const add = (secondsKey: string, minutesKey?: string): void => {
      const seconds = row[secondsKey] === undefined && minutesKey
        ? (Number(row[minutesKey]) || 0) * 60
        : Number(row[secondsKey]) || 0;
      sum[secondsKey] = (sum[secondsKey] ?? 0) + seconds;
    };
    add('regular_seconds', 'regular_minutes');
    add('overtime_seconds', 'overtime_minutes');
    add('double_time_seconds', 'double_time_minutes');
    add('clocked_seconds');
    add('manual_seconds');
    add('total_seconds', 'total_minutes');
    return sum;
  }, {});
  return emptyUnavailableMetric(aggregate);
}

const trendsSchema = z.object({
  grain: z.enum(['week', 'month']).default('week'),
  from: z.string().regex(DATE_RE),
  to: z.string().regex(DATE_RE),
  limit: z.coerce.number().int().min(1).max(104).default(26),
  cursor: z.string().regex(DATE_RE).optional(),
});

dashboardRouter.get('/admin/trends', requireAdmin, async (req, res) => {
  const organizationId = requireOrganization(req);
  const filters = trendsSchema.parse(req.query);
  const settings = await getSettings(organizationId);
  const from = DateTime.fromISO(filters.from, { zone: settings.timezone });
  const to = DateTime.fromISO(filters.to, { zone: settings.timezone });
  if (!from.isValid || !to.isValid || from > to) throw badRequest('Rango inválido');
  if (to.diff(from, 'days').days > 730) throw badRequest('El rango máximo es de 730 días');
  const inputs = await loadDashboardCostInputs({
    organizationId,
    fromDate: filters.from,
    toDate: filters.to,
    timezone: settings.timezone,
  });
  const liveWeeks = calculateCostWeeks(inputs);
  const frozenRows = await query<FrozenCostRow>(
    `SELECT p.week_start, p.status, p.current_version,
            rv.snapshot AS accountant_snapshot, cs.snapshot AS cost_snapshot
     FROM pay_periods p
     LEFT JOIN report_versions rv
       ON rv.pay_period_id = p.id AND rv.organization_id = p.organization_id
      AND rv.version = p.current_version
     LEFT JOIN report_cost_snapshots cs
       ON cs.report_version_id = rv.id AND cs.organization_id = rv.organization_id
     WHERE p.organization_id = $1
       AND p.week_start BETWEEN $2::date AND $3::date`,
    [organizationId, inputs.from_week_start, inputs.to_week_end],
  );
  const frozenByWeek = new Map(frozenRows.map((row) => [row.week_start, row]));
  const weeklyItems = liveWeeks.map((live) => {
    const period = frozenByWeek.get(live.week_start);
    if (period?.status === 'final') {
      if (period.cost_snapshot?.week) {
        return {
          period_start: live.week_start,
          period_end: live.week_end,
          metric: period.cost_snapshot.week.metric,
          missing_rates: period.cost_snapshot.week.missing_rates,
          cost_status: period.cost_snapshot.week.metric.direct_cost_complete === null
            ? 'frozen_missing_rates' as const
            : 'frozen_complete' as const,
          source: 'frozen_report_version' as const,
          report_version: period.current_version,
        };
      }
      return {
        period_start: live.week_start,
        period_end: live.week_end,
        metric: legacySummaryMetric(period.accountant_snapshot),
        missing_rates: [] as MissingRateRow[],
        cost_status: 'unavailable_legacy' as const,
        source: 'legacy_report_without_cost_snapshot' as const,
        report_version: period.current_version,
      };
    }
    return {
      period_start: live.week_start,
      period_end: live.week_end,
      metric: live.metric,
      missing_rates: live.missing_rates,
      cost_status: live.metric.direct_cost_complete === null
        ? 'live_missing_rates' as const
        : 'live_complete' as const,
      source: 'live' as const,
      report_version: period?.current_version ?? 0,
    };
  });

  let items: Array<Record<string, unknown>>;
  if (filters.grain === 'week') {
    items = weeklyItems;
  } else {
    const byMonth = new Map<string, typeof weeklyItems>();
    for (const item of weeklyItems) {
      const month = item.period_start.slice(0, 7);
      const list = byMonth.get(month) ?? [];
      list.push(item);
      byMonth.set(month, list);
    }
    items = [...byMonth.entries()].map(([month, weeks]) => {
      const unavailable = weeks.some((week) => week.cost_status === 'unavailable_legacy');
      const metric = mergeMetrics(weeks.map((week) => week.metric));
      if (unavailable) metric.direct_cost_complete = null;
      return {
        period_start: `${month}-01`,
        period_end: DateTime.fromISO(`${month}-01`, { zone: settings.timezone })
          .endOf('month').toISODate(),
        metric,
        missing_rates: weeks.flatMap((week) => week.missing_rates),
        cost_status: unavailable
          ? 'partial_legacy_unavailable'
          : metric.direct_cost_complete === null ? 'partial_missing_rates' : 'complete',
        source: 'classified_weeks_grouped_by_week_start',
        week_count: weeks.length,
      };
    });
  }
  items.sort((left, right) => String(right.period_start).localeCompare(String(left.period_start)));
  const afterCursor = filters.cursor
    ? items.filter((item) => String(item.period_start) < filters.cursor!)
    : items;
  const page = afterCursor.slice(0, filters.limit + 1);
  const hasNext = page.length > filters.limit;
  const visible = page.slice(0, filters.limit);
  noStore(res);
  res.json({
    grain: filters.grain,
    from: filters.from,
    to: filters.to,
    disclaimer: 'Costo directo estimado; excluye cargas patronales, impuestos y beneficios.',
    items: visible,
    next_cursor: hasNext ? visible.at(-1)?.period_start : undefined,
  });
});
