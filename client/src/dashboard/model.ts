import type { UserRole } from '@clockai/shared';

type UnknownRecord = Record<string, unknown>;

export type WorkerPresence = 'inside' | 'on_meal' | 'stale_open';
export type ComponentStatus = 'unknown' | 'ready' | 'degraded' | 'unavailable';
export type KioskSyncStatus = 'healthy' | 'attention' | 'offline' | 'unknown';

export interface OperationWorker {
  employee_number: number;
  full_name: string;
  state: WorkerPresence;
  since: string;
  stale: boolean;
  employee_active?: boolean;
  last_punch_type?: 'shift_in' | 'meal_out' | 'meal_in';
}

export interface OperationDevice {
  id: string;
  name: string;
  active: boolean;
  last_heartbeat_at: string | null;
  last_sync_at: string | null;
  pending_event_count: number;
  rejected_event_count: number;
  camera_status: ComponentStatus;
  storage_status: ComponentStatus;
  sync_status: KioskSyncStatus;
}

export interface OperationPlant {
  id: string;
  code: string;
  name: string;
  workers: {
    inside: OperationWorker[];
    on_meal: OperationWorker[];
    stale_open: OperationWorker[];
    inside_count: number;
    on_meal_count: number;
    stale_open_count: number;
    open_sequences_count: number;
  };
  identity_reviews_open: number;
  exceptions_open: {
    blockers: number;
    warnings: number;
    total: number;
  };
  devices: OperationDevice[];
}

export interface OperationsDashboard {
  generated_at: string;
  timezone: string;
  plants: OperationPlant[];
  totals: {
    inside: number;
    on_meal: number;
    stale_open: number;
    open_sequences: number;
    identity_reviews_open: number;
    exceptions_open: number;
    devices_attention: number;
  };
}

export interface LaborSeconds {
  regular: number;
  overtime_1_5: number;
  double_time: number;
  clock: number;
  manual: number;
  total: number;
  costed: number;
  uncosted: number;
}

export interface LaborMetric {
  seconds: LaborSeconds;
  direct_cost_costed: string;
  direct_cost_complete: string | null;
  coverage_ratio: string;
}

export interface PlantLaborMetric extends LaborMetric {
  id: string;
  code: string;
  name: string;
}

export interface LaborThresholds {
  daily_7_to_8: number;
  daily_11_to_12: number;
  weekly_36_to_40: number;
  daily_at_or_over_8: number;
  daily_at_or_over_12: number;
  weekly_at_or_over_40: number;
}

export interface ManualLaborChange {
  employee_number: number;
  full_name: string;
  plant_code: string;
  plant_name: string;
  work_date: string;
  duration_seconds: number;
  actor_name: string;
  created_at: string;
  reason: string;
  change_type: 'created' | 'voided';
}

export interface AdminWeekDashboard {
  generated_at: string;
  timezone: string;
  week_start: string;
  week_end: string;
  as_of: string;
  disclaimer: string;
  actual: LaborMetric;
  plants: PlantLaborMetric[];
  thresholds: LaborThresholds;
  previous_week: LaborMetric | null;
  projection: (LaborMetric & {
    as_of: string;
    method: 'actual_plus_open_elapsed_capped_16h';
    synthetic: true;
    payable: false;
  }) | null;
  missing_rates: number;
  manual_changes: ManualLaborChange[];
}

export interface LaborTrendItem extends LaborMetric {
  period_start: string;
  period_end: string;
  cost_status:
    | 'frozen_complete'
    | 'frozen_missing_rates'
    | 'unavailable_legacy'
    | 'live_complete'
    | 'live_missing_rates'
    | 'partial_legacy_unavailable'
    | 'partial_missing_rates'
    | 'complete'
    | 'unknown';
}

export interface LaborTrendPage {
  grain: 'week' | 'month';
  items: LaborTrendItem[];
  next_cursor: string | null;
}

function record(value: unknown, field = 'respuesta'): UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`El dashboard contiene ${field} inválida.`);
  }
  return value as UnknownRecord;
}

function array(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`El dashboard no incluye ${field}.`);
  return value;
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`El dashboard no incluye ${field}.`);
  return value;
}

function nullableText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function count(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`El dashboard contiene ${field} inválido.`);
  }
  return value;
}

function seconds(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`El dashboard contiene ${field} inválido.`);
  }
  return value;
}

function bool(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`El dashboard contiene ${field} inválido.`);
  return value;
}

function decimal(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^\d+(?:\.\d{1,4})?$/.test(value)) {
    throw new Error(`El dashboard contiene ${field} inválido.`);
  }
  return value;
}

function nullableDecimal(value: unknown, field: string): string | null {
  return value === null || value === undefined ? null : decimal(value, field);
}

function componentStatus(value: unknown): ComponentStatus {
  return value === 'ready' || value === 'degraded' || value === 'unavailable' ? value : 'unknown';
}

function syncStatus(value: unknown): KioskSyncStatus {
  return value === 'healthy' || value === 'attention' || value === 'offline' ? value : 'unknown';
}

function presence(value: unknown, fallback: WorkerPresence): WorkerPresence {
  if (value === 'inside' || value === 'in') return 'inside';
  if (value === 'on_meal' || value === 'meal') return 'on_meal';
  if (value === 'stale_open') return 'stale_open';
  return fallback;
}

function worker(value: unknown, fallback: WorkerPresence): OperationWorker {
  const source = record(value, 'trabajador');
  return {
    employee_number: count(source.employee_number, 'número de empleado'),
    full_name: text(source.full_name, 'nombre de empleado'),
    state: presence(source.state, fallback),
    since: text(source.since, 'hora de estado'),
    stale: source.stale === true,
    ...(source.employee_active === undefined
      ? {}
      : { employee_active: bool(source.employee_active, 'estado del empleado') }),
    ...(source.last_punch_type === 'shift_in'
      || source.last_punch_type === 'meal_out'
      || source.last_punch_type === 'meal_in'
      ? { last_punch_type: source.last_punch_type }
      : {}),
  };
}

function device(value: unknown): OperationDevice {
  const source = record(value, 'checador');
  return {
    id: text(source.id, 'ID de checador'),
    name: text(source.name, 'nombre de checador'),
    active: bool(source.active, 'estado de checador'),
    last_heartbeat_at: nullableText(source.last_heartbeat_at),
    last_sync_at: nullableText(source.last_sync_at),
    pending_event_count: count(source.pending_event_count, 'eventos pendientes'),
    rejected_event_count: count(source.rejected_event_count, 'eventos rechazados'),
    camera_status: componentStatus(source.camera_status),
    storage_status: componentStatus(source.storage_status),
    sync_status: syncStatus(source.sync_status),
  };
}

function plant(value: unknown): OperationPlant {
  const source = record(value, 'planta');
  const workers = record(source.workers, 'trabajadores');
  const exceptions = record(source.exceptions_open, 'incidencias');
  return {
    id: text(source.id, 'ID de planta'),
    code: text(source.code, 'código de planta'),
    name: text(source.name, 'nombre de planta'),
    workers: {
      inside: array(workers.inside, 'trabajadores adentro').map((row) => worker(row, 'inside')),
      on_meal: array(workers.on_meal, 'trabajadores en comida').map((row) => worker(row, 'on_meal')),
      stale_open: array(workers.stale_open ?? [], 'secuencias obsoletas').map((row) => worker(row, 'stale_open')),
      inside_count: count(workers.inside_count, 'personas adentro'),
      on_meal_count: count(workers.on_meal_count, 'personas en comida'),
      stale_open_count: count(workers.stale_open_count ?? 0, 'secuencias obsoletas'),
      open_sequences_count: count(workers.open_sequences_count, 'secuencias abiertas'),
    },
    identity_reviews_open: count(source.identity_reviews_open, 'revisiones de identidad'),
    exceptions_open: {
      blockers: count(exceptions.blockers, 'incidencias bloqueantes'),
      warnings: count(exceptions.warnings, 'advertencias'),
      total: count(exceptions.total, 'incidencias totales'),
    },
    devices: array(source.devices, 'checadores').map(device),
  };
}

export function parseOperationsDashboard(value: unknown): OperationsDashboard {
  const source = record(value);
  const totals = record(source.totals, 'totales');
  return {
    generated_at: text(source.generated_at, 'fecha de actualización'),
    timezone: text(source.timezone, 'zona horaria'),
    plants: array(source.plants, 'plantas').map(plant),
    totals: {
      inside: count(totals.inside, 'total adentro'),
      on_meal: count(totals.on_meal, 'total en comida'),
      stale_open: count(totals.stale_open ?? 0, 'secuencias obsoletas'),
      open_sequences: count(totals.open_sequences, 'secuencias abiertas'),
      identity_reviews_open: count(totals.identity_reviews_open, 'revisiones de identidad'),
      exceptions_open: count(totals.exceptions_open, 'incidencias'),
      devices_attention: count(totals.devices_attention, 'checadores con atención'),
    },
  };
}

function laborSeconds(value: unknown): LaborSeconds {
  const source = record(value, 'segundos laborales');
  return {
    regular: seconds(source.regular, 'tiempo regular'),
    overtime_1_5: seconds(source.overtime_1_5, 'overtime'),
    double_time: seconds(source.double_time, 'double time'),
    clock: seconds(source.clock, 'horas checadas'),
    manual: seconds(source.manual, 'horas manuales'),
    total: seconds(source.total, 'horas totales'),
    costed: seconds(source.costed, 'horas con tasa'),
    uncosted: seconds(source.uncosted, 'horas sin tasa'),
  };
}

function laborMetric(value: unknown): LaborMetric {
  const source = record(value, 'métrica laboral');
  return {
    seconds: laborSeconds(source.seconds),
    direct_cost_costed: decimal(source.direct_cost_costed, 'costo cubierto'),
    direct_cost_complete: nullableDecimal(source.direct_cost_complete, 'costo completo'),
    coverage_ratio: decimal(source.coverage_ratio, 'cobertura'),
  };
}

function thresholdValue(source: UnknownRecord, key: keyof LaborThresholds): number {
  return count(source[key] ?? 0, `umbral ${key}`);
}

function laborThresholds(value: unknown): LaborThresholds {
  if (Array.isArray(value)) {
    const counts: LaborThresholds = {
      daily_7_to_8: 0,
      daily_11_to_12: 0,
      weekly_36_to_40: 0,
      daily_at_or_over_8: 0,
      daily_at_or_over_12: 0,
      weekly_at_or_over_40: 0,
    };
    for (const item of value) {
      const code = record(item, 'umbral').code;
      if (code === 'near_8h') counts.daily_7_to_8 += 1;
      else if (code === 'near_12h') counts.daily_11_to_12 += 1;
      else if (code === 'near_40h') counts.weekly_36_to_40 += 1;
      else if (code === 'at_8h') counts.daily_at_or_over_8 += 1;
      else if (code === 'at_12h') counts.daily_at_or_over_12 += 1;
      else if (code === 'at_40h') counts.weekly_at_or_over_40 += 1;
    }
    return counts;
  }
  const source = record(value ?? {}, 'umbrales');
  return {
    daily_7_to_8: thresholdValue(source, 'daily_7_to_8'),
    daily_11_to_12: thresholdValue(source, 'daily_11_to_12'),
    weekly_36_to_40: thresholdValue(source, 'weekly_36_to_40'),
    daily_at_or_over_8: thresholdValue(source, 'daily_at_or_over_8'),
    daily_at_or_over_12: thresholdValue(source, 'daily_at_or_over_12'),
    weekly_at_or_over_40: thresholdValue(source, 'weekly_at_or_over_40'),
  };
}

export function parseAdminWeekDashboard(value: unknown): AdminWeekDashboard {
  const source = record(value);
  const previous = source.previous_week;
  const projection = source.projection;
  const missing = source.missing_rates;
  return {
    generated_at: text(source.generated_at, 'fecha de actualización'),
    timezone: text(source.timezone, 'zona horaria'),
    week_start: text(source.week_start, 'inicio de semana'),
    week_end: text(source.week_end, 'fin de semana'),
    as_of: text(source.as_of, 'fecha de corte'),
    disclaimer: text(source.disclaimer, 'aviso de costos'),
    actual: laborMetric(source.actual),
    plants: array(source.plants, 'costos por planta').map((value): PlantLaborMetric => {
      const row = record(value, 'costo de planta');
      return {
        id: text(row.id ?? row.plant_id, 'ID de planta'),
        code: text(row.code, 'código de planta'),
        name: text(row.name, 'nombre de planta'),
        ...laborMetric(row.metric ?? row.actual ?? row),
      };
    }),
    thresholds: laborThresholds(source.thresholds),
    previous_week: previous && typeof previous === 'object'
      ? laborMetric(record(previous).metric ?? previous)
      : null,
    projection: projection && typeof projection === 'object'
      ? (() => {
        const projectionSource = record(projection);
        if (
          projectionSource.synthetic !== true || projectionSource.payable !== false ||
          projectionSource.method !== 'actual_plus_open_elapsed_capped_16h'
        ) {
          throw new Error('El dashboard contiene una proyección no identificada o marcada como pagable.');
        }
        return {
          ...laborMetric(projectionSource.metric ?? projection),
          as_of: text(projectionSource.as_of, 'corte de proyección'),
          method: projectionSource.method,
          synthetic: true as const,
          payable: false as const,
        };
      })()
      : null,
    missing_rates: Array.isArray(missing)
      ? missing.length
      : typeof missing === 'number' && Number.isInteger(missing) && missing >= 0
        ? missing
        : 0,
    manual_changes: array(source.recent_manual_changes ?? source.manual_changes ?? [], 'cambios manuales').map((value): ManualLaborChange => {
      const row = record(value, 'cambio manual');
      return {
        employee_number: count(row.employee_number, 'número de empleado'),
        full_name: text(row.full_name, 'nombre del empleado'),
        plant_code: text(row.plant_code, 'código de planta'),
        plant_name: text(row.plant_name, 'nombre de planta'),
        work_date: text(row.work_date, 'fecha de trabajo'),
        duration_seconds: seconds(row.duration_seconds ?? row.seconds, 'duración manual'),
        actor_name: text(row.actor_name, 'actor del cambio'),
        created_at: text(row.created_at, 'fecha del cambio'),
        reason: text(row.reason, 'motivo del cambio'),
        change_type: row.change_type === 'voided' ? 'voided' : 'created',
      };
    }),
  };
}

export function parseLaborTrendPage(value: unknown): LaborTrendPage {
  const source = record(value);
  const grain = source.grain;
  if (grain !== 'week' && grain !== 'month') throw new Error('El dashboard contiene una agrupación inválida.');
  return {
    grain,
    items: array(source.items, 'tendencias').map((value): LaborTrendItem => {
      const row = record(value, 'tendencia');
      return {
        period_start: text(row.period_start, 'inicio de periodo'),
        period_end: text(row.period_end, 'fin de periodo'),
        cost_status: typeof row.cost_status === 'string' && [
          'frozen_complete',
          'frozen_missing_rates',
          'unavailable_legacy',
          'live_complete',
          'live_missing_rates',
          'partial_legacy_unavailable',
          'partial_missing_rates',
          'complete',
        ].includes(row.cost_status)
          ? row.cost_status as LaborTrendItem['cost_status']
          : 'unknown',
        ...laborMetric(row.metric ?? row),
      };
    }),
    next_cursor: nullableText(source.next_cursor),
  };
}

export function dashboardPathsForRole(role: UserRole): string[] {
  if (role === 'admin') {
    return [
      '/api/dashboard/operations',
      '/api/dashboard/admin/current-week',
      '/api/dashboard/admin/trends',
    ];
  }
  return role === 'foreman' ? ['/api/dashboard/operations'] : [];
}

export function canViewLaborCosts(role: UserRole): boolean {
  return role === 'admin';
}

export function metricChangeRatio(current: LaborMetric, previous: LaborMetric | null): number | null {
  if (!previous || previous.seconds.total === 0) return null;
  return (current.seconds.total - previous.seconds.total) / previous.seconds.total;
}

export function completeCostChangeRatio(current: LaborMetric, previous: LaborMetric | null): number | null {
  if (!previous || current.direct_cost_complete === null || previous.direct_cost_complete === null) return null;
  const prior = Number(previous.direct_cost_complete);
  if (!Number.isFinite(prior) || prior === 0) return null;
  return (Number(current.direct_cost_complete) - prior) / prior;
}

export function laborCostDisplay(metric: LaborMetric): {
  complete: boolean;
  amount: string | null;
  known_amount: string;
  status: 'complete' | 'missing_rates';
} {
  return metric.direct_cost_complete === null
    ? {
      complete: false,
      amount: null,
      known_amount: metric.direct_cost_costed,
      status: 'missing_rates',
    }
    : {
      complete: true,
      amount: metric.direct_cost_complete,
      known_amount: metric.direct_cost_costed,
      status: 'complete',
    };
}
