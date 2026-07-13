import type { UserRole } from '@clockai/shared';

export type PayPeriodStatus = 'open' | 'ready_for_review' | 'final' | 'reopened';

export interface FinalReportWeek {
  week_start: string;
  week_end: string;
  period_status: PayPeriodStatus;
  current_version: number | null;
  finalized_at: string | null;
}

export interface FinalReportVersion {
  version: number;
  finalized_at: string;
  snapshot_hash: string | null;
  schema_version: number;
  detail_available: boolean;
  export_formats: ReportArtifactKind[];
}

export type ReportArtifactKind = 'xlsx' | 'csv_summary' | 'csv_detail';

export interface ReportPage<T, Cursor extends string | number> {
  items: T[];
  next_cursor: Cursor | null;
}

export interface AccountantPlant {
  code: string;
  name: string;
}

export interface AccountantSummaryRow {
  employee_number: number;
  name: string;
  plants: AccountantPlant[];
  days_worked: number | null;
  regular_seconds: number;
  overtime_seconds: number;
  double_time_seconds: number;
  manual_seconds: number;
  total_seconds: number;
}

export type AccountantPunchType = 'shift_in' | 'meal_out' | 'meal_in' | 'shift_out';

export interface AccountantPunch {
  type: AccountantPunchType;
  occurred_at: string;
}

export interface AccountantDetailRow {
  employee_number: number;
  name: string;
  work_date: string;
  plant: AccountantPlant;
  punches: AccountantPunch[];
  meal_seconds: number;
  clock_seconds: number;
  manual_seconds: number;
  regular_seconds: number | null;
  overtime_seconds: number | null;
  double_time_seconds: number | null;
  total_seconds: number;
  exception_indicators: AccountantExceptionIndicator[];
}

export type AccountantExceptionIndicator =
  | 'missing_shift_out'
  | 'missing_meal_in'
  | 'out_of_sequence'
  | 'overlap_between_plants';

export const ACCOUNTANT_EXCEPTION_LABELS: Record<AccountantExceptionIndicator, string> = {
  missing_shift_out: 'Falta checada de salida',
  missing_meal_in: 'Falta regreso de comida',
  out_of_sequence: 'Orden de checadas por revisar',
  overlap_between_plants: 'Traslape entre plantas',
};

export interface AccountantHourTotals {
  regular_seconds: number;
  overtime_seconds: number;
  double_time_seconds: number;
  manual_seconds: number;
  total_seconds: number;
}

export interface AccountantReportSnapshot {
  schema_version: number;
  contract: string;
  week_start: string;
  week_end: string;
  timezone: string;
  policy: 'CA_STANDARD_8_40';
  version: number;
  status: 'final';
  finalized_at: string;
  summary: AccountantSummaryRow[];
  detail: AccountantDetailRow[];
  totals: AccountantHourTotals;
  period_status: PayPeriodStatus;
  is_current_final: boolean;
  detail_available: boolean;
  snapshot_hash: string | null;
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Respuesta de reportes inválida.');
  }
  return value as UnknownRecord;
}

function records(value: unknown): UnknownRecord[] {
  if (!Array.isArray(value)) throw new Error('Respuesta de reportes inválida.');
  return value.map(record);
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`El reporte no incluye ${field}.`);
  return value;
}

function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function finite(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`El reporte contiene ${field} inválido.`);
  }
  return value;
}

function integer(value: unknown, field: string): number {
  const result = finite(value, field);
  if (!Number.isInteger(result)) throw new Error(`El reporte contiene ${field} inválido.`);
  return result;
}

function nullableFinite(value: unknown): number | null {
  return value === null || value === undefined ? null : finite(value, 'horas');
}

function payPeriodStatus(value: unknown, fallback: PayPeriodStatus = 'final'): PayPeriodStatus {
  return value === 'open' || value === 'ready_for_review' || value === 'final' || value === 'reopened'
    ? value
    : fallback;
}

function plant(value: unknown): AccountantPlant {
  const source = record(value);
  return {
    code: text(source.code ?? source.plant_code, 'el código de planta'),
    name: text(source.name ?? source.plant_name, 'el nombre de planta'),
  };
}

function plants(value: unknown): AccountantPlant[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (typeof item === 'string') return { code: item, name: item };
    return plant(item);
  });
}

function summaryRow(value: unknown): AccountantSummaryRow {
  const source = record(value);
  return {
    employee_number: integer(source.employee_number, 'el número de empleado'),
    name: text(source.name ?? source.full_name, 'el nombre del empleado'),
    plants: plants(source.plants ?? source.plants_worked),
    days_worked: source.days_worked === undefined ? null : integer(source.days_worked, 'los días trabajados'),
    regular_seconds: finite(source.regular_seconds, 'las horas regulares'),
    overtime_seconds: finite(source.overtime_seconds, 'el overtime'),
    double_time_seconds: finite(source.double_time_seconds, 'el double time'),
    manual_seconds: finite(source.manual_seconds, 'las horas manuales'),
    total_seconds: finite(source.total_seconds, 'el total de horas'),
  };
}

const PUNCH_TYPES = new Set<AccountantPunchType>(['shift_in', 'meal_out', 'meal_in', 'shift_out']);

function punch(value: unknown): AccountantPunch {
  const source = record(value);
  const type = source.type ?? source.punch_type;
  if (typeof type !== 'string' || !PUNCH_TYPES.has(type as AccountantPunchType)) {
    throw new Error('El reporte contiene un tipo de checada inválido.');
  }
  return {
    type: type as AccountantPunchType,
    occurred_at: text(source.occurred_at ?? source.punched_at, 'la hora de checada'),
  };
}

function detailRow(value: unknown): AccountantDetailRow {
  const source = record(value);
  const allowedIndicators = new Set<AccountantExceptionIndicator>([
    'missing_shift_out',
    'missing_meal_in',
    'out_of_sequence',
    'overlap_between_plants',
  ]);
  const exceptionIndicators = Array.isArray(source.exception_indicators)
    ? source.exception_indicators.filter(
      (item): item is AccountantExceptionIndicator =>
        typeof item === 'string' && allowedIndicators.has(item as AccountantExceptionIndicator),
    )
    : [];
  return {
    employee_number: integer(source.employee_number, 'el número de empleado'),
    name: text(source.name ?? source.full_name, 'el nombre del empleado'),
    work_date: text(source.work_date, 'la fecha de trabajo'),
    plant: plant(source.plant ?? {
      code: source.plant_code,
      name: source.plant_name,
    }),
    punches: Array.isArray(source.punches) ? source.punches.map(punch) : [],
    meal_seconds: finite(source.meal_seconds ?? 0, 'la comida'),
    clock_seconds: finite(source.clock_seconds ?? source.clocked_seconds ?? 0, 'las horas de reloj'),
    manual_seconds: finite(source.manual_seconds ?? 0, 'las horas manuales'),
    regular_seconds: nullableFinite(source.regular_seconds),
    overtime_seconds: nullableFinite(source.overtime_seconds),
    double_time_seconds: nullableFinite(source.double_time_seconds),
    total_seconds: finite(source.total_seconds, 'el total de horas'),
    exception_indicators: exceptionIndicators,
  };
}

function totals(value: unknown, summary: AccountantSummaryRow[]): AccountantHourTotals {
  if (!value) {
    return summary.reduce<AccountantHourTotals>((result, row) => ({
      regular_seconds: result.regular_seconds + row.regular_seconds,
      overtime_seconds: result.overtime_seconds + row.overtime_seconds,
      double_time_seconds: result.double_time_seconds + row.double_time_seconds,
      manual_seconds: result.manual_seconds + row.manual_seconds,
      total_seconds: result.total_seconds + row.total_seconds,
    }), {
      regular_seconds: 0,
      overtime_seconds: 0,
      double_time_seconds: 0,
      manual_seconds: 0,
      total_seconds: 0,
    });
  }
  const source = record(value);
  return {
    regular_seconds: finite(source.regular_seconds, 'el total regular'),
    overtime_seconds: finite(source.overtime_seconds, 'el total de overtime'),
    double_time_seconds: finite(source.double_time_seconds, 'el total de double time'),
    manual_seconds: finite(source.manual_seconds, 'el total manual'),
    total_seconds: finite(source.total_seconds, 'el total de horas'),
  };
}

/**
 * Convierte el JSON externo a un DTO contable de allowlist. Nunca conserva
 * identificadores, actores, motivos, costos ni fotos. Los únicos indicadores
 * conservados pertenecen al enum contable cerrado definido arriba.
 */
export function parseAccountantReport(value: unknown): AccountantReportSnapshot {
  const envelope = record(value);
  const source = record(envelope.snapshot ?? envelope.report ?? envelope);
  const summary = records(source.summary ?? source.employees).map(summaryRow);
  const status = source.status;
  if (status !== 'final') throw new Error('La contadora sólo puede consultar versiones finales.');
  const detailAvailable = envelope.detail_available ?? source.detail_available;
  const detail = detailAvailable === false ? [] : records(source.detail ?? []).map(detailRow);
  const policy = source.policy;
  if (policy !== 'CA_STANDARD_8_40') throw new Error('El reporte no usa la política de California esperada.');

  return {
    schema_version: integer(source.schema_version ?? 1, 'la versión de esquema'),
    contract: optionalText(source.contract) ?? 'clockai-accountant-legacy',
    week_start: text(source.week_start, 'el inicio de semana'),
    week_end: text(source.week_end, 'el fin de semana'),
    timezone: optionalText(source.timezone) ?? 'America/Los_Angeles',
    policy,
    version: integer(source.version ?? envelope.version, 'la versión'),
    status,
    finalized_at: text(source.finalized_at ?? envelope.finalized_at, 'la fecha de cierre'),
    summary,
    detail,
    totals: totals(source.totals, summary),
    period_status: payPeriodStatus(envelope.period_status ?? source.period_status),
    is_current_final: Boolean(envelope.is_current_final ?? source.is_current_final ?? true),
    detail_available: detailAvailable !== false,
    snapshot_hash: optionalText(envelope.snapshot_hash ?? source.snapshot_hash),
  };
}

export function parseReportWeekPage(value: unknown): ReportPage<FinalReportWeek, string> {
  const envelope = Array.isArray(value) ? null : record(value);
  const source = Array.isArray(value) ? value : envelope!.items;
  const items = records(source).map((item) => ({
    week_start: text(item.week_start, 'el inicio de semana'),
    week_end: text(item.week_end, 'el fin de semana'),
    period_status: payPeriodStatus(item.period_status ?? item.status),
    current_version: item.current_version === null || item.current_version === undefined
      ? null
      : integer(item.current_version ?? item.version, 'la versión actual'),
    finalized_at: optionalText(item.finalized_at),
  }));
  const cursor = envelope?.next_cursor;
  return {
    items,
    next_cursor: typeof cursor === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(cursor) ? cursor : null,
  };
}

export function parseReportWeeks(value: unknown): FinalReportWeek[] {
  return parseReportWeekPage(value).items;
}

export function parseReportVersionPage(value: unknown): ReportPage<FinalReportVersion, number> {
  const envelope = Array.isArray(value) ? null : record(value);
  const source = Array.isArray(value) ? value : envelope!.items;
  const allowedArtifacts = new Set<ReportArtifactKind>(['xlsx', 'csv_summary', 'csv_detail']);
  const items = records(source).map((item) => ({
    version: integer(item.version, 'la versión'),
    finalized_at: text(item.finalized_at, 'la fecha de cierre'),
    snapshot_hash: optionalText(item.snapshot_hash),
    schema_version: integer(item.schema_version ?? item.snapshot_schema_version ?? 1, 'la versión de esquema'),
    detail_available: item.detail_available !== false && Number(item.schema_version ?? item.snapshot_schema_version ?? 1) >= 2,
    export_formats: Array.isArray(item.export_formats)
      ? item.export_formats.filter(
        (format): format is ReportArtifactKind =>
          typeof format === 'string' && allowedArtifacts.has(format as ReportArtifactKind),
      )
      : [],
  }));
  const numericCursor = Number(envelope?.next_cursor);
  return {
    items,
    next_cursor: Number.isInteger(numericCursor) && numericCursor > 0 ? numericCursor : null,
  };
}

export function parseReportVersions(value: unknown): FinalReportVersion[] {
  return parseReportVersionPage(value).items;
}

export function reportVersionPath(weekStart: string, version: number): string {
  return `/api/reports/week/${encodeURIComponent(weekStart)}/versions/${version}`;
}

export function reportExportPath(
  weekStart: string,
  version: number,
  format: 'xlsx' | 'csv',
  sheet: 'summary' | 'detail' = 'summary',
): string {
  const params = new URLSearchParams({ format });
  if (format === 'csv') params.set('sheet', sheet);
  return `${reportVersionPath(weekStart, version)}/export?${params.toString()}`;
}

export function reportModeForRole(role: UserRole): 'admin_preview' | 'final_only' {
  return role === 'admin' ? 'admin_preview' : 'final_only';
}
