import crypto from 'node:crypto';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { DateTime } from 'luxon';
import type { PoolClient, QueryResultRow } from 'pg';
import { query } from '../db.js';
import type { PunchType, WeekEmployeeCalc } from '../types.js';
import type { WeekComputation } from './attendanceService.js';
import { buildWorkSegments } from './workSegments.js';

export const ACCOUNTANT_REPORT_SCHEMA_VERSION = 2 as const;
export const ACCOUNTANT_REPORT_CONTRACT = 'clockai-accountant-v1' as const;
export const ACCOUNTANT_REPORT_TEMPLATE_VERSION = 'clockai-export-v1' as const;

export interface AccountantPlant {
  code: string;
  name: string;
}

export interface AccountantSummaryRow {
  employee_number: number;
  full_name: string;
  plants: AccountantPlant[];
  days_worked: number;
  regular_seconds: number;
  overtime_seconds: number;
  double_time_seconds: number;
  clocked_seconds: number;
  manual_seconds: number;
  total_seconds: number;
}

export interface AccountantPunch {
  punch_type: PunchType;
  punched_at: string;
}

export type AccountantExceptionIndicator =
  | 'missing_shift_out'
  | 'missing_meal_in'
  | 'out_of_sequence'
  | 'overlap_between_plants';

export interface AccountantDetailRow {
  employee_number: number;
  full_name: string;
  work_date: string;
  plant_code: string;
  plant_name: string;
  punches: AccountantPunch[];
  meal_seconds: number;
  clocked_seconds: number;
  manual_seconds: number;
  total_seconds: number;
  exception_indicators: AccountantExceptionIndicator[];
}

export interface AccountantHourTotals {
  regular_seconds: number;
  overtime_seconds: number;
  double_time_seconds: number;
  clocked_seconds: number;
  manual_seconds: number;
  total_seconds: number;
}

export interface AccountantReportSnapshotV2 {
  schema_version: typeof ACCOUNTANT_REPORT_SCHEMA_VERSION;
  contract: typeof ACCOUNTANT_REPORT_CONTRACT;
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
}

export interface SafeAccountantReport {
  schema_version: 1 | 2;
  contract: 'legacy-week-computation-v1' | typeof ACCOUNTANT_REPORT_CONTRACT;
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
}

interface SnapshotPunchRow {
  id: string;
  employee_id: string;
  employee_number: number;
  full_name: string;
  punch_type: PunchType;
  punched_at: Date;
  plant_id: string;
  plant_code: string;
  plant_name: string;
}

interface SnapshotManualRow {
  employee_id: string;
  employee_number: number;
  full_name: string;
  plant_id: string;
  plant_code: string;
  plant_name: string;
  work_date: string;
  duration_seconds: string | number;
}

interface MutableDetail {
  employeeId: string;
  employee_number: number;
  full_name: string;
  work_date: string;
  plantId: string;
  plant_code: string;
  plant_name: string;
  punches: AccountantPunch[];
  meal_seconds: number;
  clocked_seconds: number;
  manual_seconds: number;
  exceptions: Set<AccountantExceptionIndicator>;
}

function exactSeconds(value: unknown, fallbackMinutes: unknown = 0): number {
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds));
  const minutes = Number(fallbackMinutes);
  return Number.isFinite(minutes) ? Math.max(0, Math.round(minutes * 60)) : 0;
}

function summaryFromWeekEmployee(employee: WeekEmployeeCalc, plants: AccountantPlant[]): AccountantSummaryRow {
  return {
    employee_number: Number(employee.employee_number),
    full_name: String(employee.full_name),
    plants: plants.map((plant) => ({ code: plant.code, name: plant.name })),
    days_worked: Number(employee.days_worked) || 0,
    regular_seconds: exactSeconds(employee.regular_seconds, employee.regular_minutes),
    overtime_seconds: exactSeconds(employee.overtime_seconds, employee.overtime_minutes),
    double_time_seconds: exactSeconds(employee.double_time_seconds, employee.double_time_minutes),
    clocked_seconds: exactSeconds(employee.clocked_seconds, employee.clocked_minutes),
    manual_seconds: exactSeconds(employee.manual_seconds, employee.manual_minutes),
    total_seconds: exactSeconds(employee.total_seconds, employee.total_minutes),
  };
}

function totalsOf(summary: readonly AccountantSummaryRow[]): AccountantHourTotals {
  return summary.reduce<AccountantHourTotals>(
    (totals, row) => ({
      regular_seconds: totals.regular_seconds + row.regular_seconds,
      overtime_seconds: totals.overtime_seconds + row.overtime_seconds,
      double_time_seconds: totals.double_time_seconds + row.double_time_seconds,
      clocked_seconds: totals.clocked_seconds + row.clocked_seconds,
      manual_seconds: totals.manual_seconds + row.manual_seconds,
      total_seconds: totals.total_seconds + row.total_seconds,
    }),
    {
      regular_seconds: 0,
      overtime_seconds: 0,
      double_time_seconds: 0,
      clocked_seconds: 0,
      manual_seconds: 0,
      total_seconds: 0,
    },
  );
}

function detailKey(employeeId: string, workDate: string, plantId: string): string {
  return `${employeeId}\u0000${workDate}\u0000${plantId}`;
}

function localDate(timestamp: Date, timezone: string): string {
  return DateTime.fromJSDate(timestamp).setZone(timezone).toISODate()!;
}

/**
 * Builds the immutable accountant contract. Operational identifiers are used
 * only while joining source data and are deliberately absent from the result.
 */
export async function buildAccountantSnapshot(input: {
  organizationId: string;
  timezone: string;
  version: number;
  finalizedAt: Date;
  computation: WeekComputation;
  client?: PoolClient;
}): Promise<AccountantReportSnapshotV2> {
  const { organizationId, timezone, computation } = input;
  const scopedQuery = async <T extends QueryResultRow>(
    text: string,
    params: unknown[],
  ): Promise<T[]> => input.client
    ? (await input.client.query<T>(text, params)).rows
    : query<T>(text, params);
  const allPunches = await scopedQuery<SnapshotPunchRow>(
    `SELECT p.id, p.employee_id, e.employee_number, e.full_name,
            p.punch_type, p.punched_at, p.plant_id,
            pl.code AS plant_code, pl.name AS plant_name
     FROM punches p
     JOIN employees e
       ON e.id = p.employee_id AND e.organization_id = p.organization_id
     JOIN plants pl
       ON pl.id = p.plant_id AND pl.organization_id = p.organization_id
     WHERE p.organization_id = $1 AND NOT p.voided
       AND (p.punched_at AT TIME ZONE $4)::date
           BETWEEN ($2::date - 1) AND ($3::date + 1)
     ORDER BY p.employee_id, p.punched_at, p.created_at, p.id`,
    [organizationId, computation.week_start, computation.week_end, timezone],
  );
  const manualRows = await scopedQuery<SnapshotManualRow>(
    `SELECT m.employee_id, e.employee_number, e.full_name, m.plant_id,
            pl.code AS plant_code, pl.name AS plant_name,
            m.work_date, m.duration_seconds
     FROM manual_time_entries m
     JOIN employees e
       ON e.id = m.employee_id AND e.organization_id = m.organization_id
     JOIN plants pl
       ON pl.id = m.plant_id AND pl.organization_id = m.organization_id
     WHERE m.organization_id = $1 AND m.voided_at IS NULL
       AND m.work_date BETWEEN $2::date AND $3::date
     ORDER BY m.employee_id, m.work_date, pl.code, m.created_at, m.id`,
    [organizationId, computation.week_start, computation.week_end],
  );

  const details = new Map<string, MutableDetail>();
  const employeePlants = new Map<string, Map<string, AccountantPlant>>();
  const employeeById = new Map(
    computation.employees.map((employee) => [
      employee.employee_id,
      { number: employee.employee_number, name: employee.full_name },
    ]),
  );

  const ensureDetail = (identity: {
    employeeId: string;
    employeeNumber: number;
    fullName: string;
    workDate: string;
    plantId: string;
    plantCode: string;
    plantName: string;
  }): MutableDetail => {
    const key = detailKey(identity.employeeId, identity.workDate, identity.plantId);
    let row = details.get(key);
    if (!row) {
      row = {
        employeeId: identity.employeeId,
        employee_number: identity.employeeNumber,
        full_name: identity.fullName,
        work_date: identity.workDate,
        plantId: identity.plantId,
        plant_code: identity.plantCode,
        plant_name: identity.plantName,
        punches: [],
        meal_seconds: 0,
        clocked_seconds: 0,
        manual_seconds: 0,
        exceptions: new Set(),
      };
      details.set(key, row);
    }
    const plants = employeePlants.get(identity.employeeId) ?? new Map<string, AccountantPlant>();
    plants.set(identity.plantId, { code: identity.plantCode, name: identity.plantName });
    employeePlants.set(identity.employeeId, plants);
    return row;
  };

  const punchesByEmployee = new Map<string, SnapshotPunchRow[]>();
  for (const punch of allPunches) {
    const list = punchesByEmployee.get(punch.employee_id) ?? [];
    list.push(punch);
    punchesByEmployee.set(punch.employee_id, list);
    const workDate = localDate(punch.punched_at, timezone);
    if (workDate < computation.week_start || workDate > computation.week_end) continue;
    ensureDetail({
      employeeId: punch.employee_id,
      employeeNumber: punch.employee_number,
      fullName: punch.full_name,
      workDate,
      plantId: punch.plant_id,
      plantCode: punch.plant_code,
      plantName: punch.plant_name,
    }).punches.push({
      punch_type: punch.punch_type,
      punched_at: punch.punched_at.toISOString(),
    });
  }

  for (const [employeeId, punches] of punchesByEmployee) {
    const segments = buildWorkSegments(
      punches.map((punch) => ({
        id: punch.id,
        type: punch.punch_type,
        time: punch.punched_at,
        plantId: punch.plant_id,
      })),
    );
    const punchById = new Map(punches.map((punch) => [punch.id, punch]));
    for (const chunk of segments.chunks) {
      if (chunk.workDate < computation.week_start || chunk.workDate > computation.week_end) continue;
      const source = punchById.get(chunk.startPunchId);
      const identity = employeeById.get(employeeId);
      if (!source || !identity) continue;
      ensureDetail({
        employeeId,
        employeeNumber: identity.number,
        fullName: identity.name,
        workDate: chunk.workDate,
        plantId: source.plant_id,
        plantCode: source.plant_code,
        plantName: source.plant_name,
      }).clocked_seconds += chunk.durationSeconds;
    }

    const openMeals = new Map<string, SnapshotPunchRow>();
    for (const punch of punches) {
      if (punch.punch_type === 'meal_out') {
        openMeals.set(punch.plant_id, punch);
      } else if (punch.punch_type === 'meal_in') {
        const start = openMeals.get(punch.plant_id);
        openMeals.delete(punch.plant_id);
        if (!start || punch.punched_at <= start.punched_at) continue;
        const workDate = localDate(start.punched_at, timezone);
        if (workDate < computation.week_start || workDate > computation.week_end) continue;
        const identity = employeeById.get(employeeId);
        if (!identity) continue;
        ensureDetail({
          employeeId,
          employeeNumber: identity.number,
          fullName: identity.name,
          workDate,
          plantId: start.plant_id,
          plantCode: start.plant_code,
          plantName: start.plant_name,
        }).meal_seconds += Math.floor(
          (punch.punched_at.getTime() - start.punched_at.getTime()) / 1_000,
        );
      }
    }
  }

  for (const entry of manualRows) {
    ensureDetail({
      employeeId: entry.employee_id,
      employeeNumber: entry.employee_number,
      fullName: entry.full_name,
      workDate: entry.work_date,
      plantId: entry.plant_id,
      plantCode: entry.plant_code,
      plantName: entry.plant_name,
    }).manual_seconds += exactSeconds(entry.duration_seconds);
  }

  for (const issue of computation.issues) {
    const type = issue.type as AccountantExceptionIndicator;
    const plantIds = [...new Set(issue.plant_ids)];
    const issueDate = issue.start
      ? DateTime.fromISO(issue.start, { setZone: true }).setZone(timezone).toISODate()
      : null;
    for (const row of details.values()) {
      if (row.employeeId !== issue.employee_id) continue;
      if (issueDate && row.work_date !== issueDate) continue;
      if (plantIds.length && !plantIds.includes(row.plantId)) continue;
      row.exceptions.add(type);
    }
  }

  const detail: AccountantDetailRow[] = [...details.values()]
    .map((row) => ({
      employee_number: row.employee_number,
      full_name: row.full_name,
      work_date: row.work_date,
      plant_code: row.plant_code,
      plant_name: row.plant_name,
      punches: row.punches
        .map((punch) => ({ ...punch }))
        .sort((left, right) =>
          left.punched_at.localeCompare(right.punched_at)
          || left.punch_type.localeCompare(right.punch_type)),
      meal_seconds: row.meal_seconds,
      clocked_seconds: row.clocked_seconds,
      manual_seconds: row.manual_seconds,
      total_seconds: row.clocked_seconds + row.manual_seconds,
      exception_indicators: [...row.exceptions].sort(),
    }))
    .sort((left, right) =>
      left.employee_number - right.employee_number
      || left.work_date.localeCompare(right.work_date)
      || left.plant_code.localeCompare(right.plant_code)
      || left.plant_name.localeCompare(right.plant_name),
    );

  const summary = computation.employees.map((employee) => {
    const plants = [...(employeePlants.get(employee.employee_id)?.values() ?? [])]
      .sort((left, right) => left.code.localeCompare(right.code) || left.name.localeCompare(right.name));
    return summaryFromWeekEmployee(employee, plants);
  });

  return {
    schema_version: ACCOUNTANT_REPORT_SCHEMA_VERSION,
    contract: ACCOUNTANT_REPORT_CONTRACT,
    week_start: computation.week_start,
    week_end: computation.week_end,
    timezone,
    policy: 'CA_STANDARD_8_40',
    version: input.version,
    status: 'final',
    finalized_at: input.finalizedAt.toISOString(),
    summary,
    detail,
    totals: totalsOf(summary),
  };
}

function safePlant(input: unknown): AccountantPlant | null {
  if (!input || typeof input !== 'object') return null;
  const plant = input as Record<string, unknown>;
  if (typeof plant.code !== 'string' || typeof plant.name !== 'string') return null;
  return { code: plant.code, name: plant.name };
}

function safeSummaryRow(input: unknown): AccountantSummaryRow | null {
  if (!input || typeof input !== 'object') return null;
  const row = input as Record<string, unknown>;
  if (!Number.isFinite(Number(row.employee_number)) || typeof row.full_name !== 'string') return null;
  return {
    employee_number: Number(row.employee_number),
    full_name: row.full_name,
    plants: Array.isArray(row.plants)
      ? row.plants.map(safePlant).filter((plant): plant is AccountantPlant => plant !== null)
      : [],
    days_worked: exactSeconds(row.days_worked),
    regular_seconds: exactSeconds(row.regular_seconds),
    overtime_seconds: exactSeconds(row.overtime_seconds),
    double_time_seconds: exactSeconds(row.double_time_seconds),
    clocked_seconds: exactSeconds(row.clocked_seconds),
    manual_seconds: exactSeconds(row.manual_seconds),
    total_seconds: exactSeconds(row.total_seconds),
  };
}

function safeDetailRow(input: unknown): AccountantDetailRow | null {
  if (!input || typeof input !== 'object') return null;
  const row = input as Record<string, unknown>;
  if (
    !Number.isFinite(Number(row.employee_number))
    || typeof row.full_name !== 'string'
    || typeof row.work_date !== 'string'
    || typeof row.plant_code !== 'string'
    || typeof row.plant_name !== 'string'
  ) return null;
  const allowedTypes = new Set<PunchType>(['shift_in', 'shift_out', 'meal_out', 'meal_in']);
  const allowedExceptions = new Set<AccountantExceptionIndicator>([
    'missing_shift_out', 'missing_meal_in', 'out_of_sequence', 'overlap_between_plants',
  ]);
  const punches: AccountantPunch[] = Array.isArray(row.punches)
    ? row.punches.flatMap((value) => {
      if (!value || typeof value !== 'object') return [];
      const punch = value as Record<string, unknown>;
      if (!allowedTypes.has(punch.punch_type as PunchType) || typeof punch.punched_at !== 'string') return [];
      return [{ punch_type: punch.punch_type as PunchType, punched_at: punch.punched_at }];
    })
    : [];
  return {
    employee_number: Number(row.employee_number),
    full_name: row.full_name,
    work_date: row.work_date,
    plant_code: row.plant_code,
    plant_name: row.plant_name,
    punches,
    meal_seconds: exactSeconds(row.meal_seconds),
    clocked_seconds: exactSeconds(row.clocked_seconds),
    manual_seconds: exactSeconds(row.manual_seconds),
    total_seconds: exactSeconds(row.total_seconds),
    exception_indicators: Array.isArray(row.exception_indicators)
      ? row.exception_indicators.filter(
        (value): value is AccountantExceptionIndicator => allowedExceptions.has(value as AccountantExceptionIndicator),
      )
      : [],
  };
}

/** Defense-in-depth allowlist for every snapshot read, including schema v2. */
export function sanitizeAccountantSnapshot(input: unknown): AccountantReportSnapshotV2 {
  if (!input || typeof input !== 'object') throw new Error('invalid accountant snapshot');
  const snapshot = input as Record<string, unknown>;
  if (snapshot.schema_version !== 2 || snapshot.contract !== ACCOUNTANT_REPORT_CONTRACT) {
    throw new Error('unsupported accountant snapshot');
  }
  const summary = Array.isArray(snapshot.summary)
    ? snapshot.summary.map(safeSummaryRow).filter((row): row is AccountantSummaryRow => row !== null)
    : [];
  const detail = Array.isArray(snapshot.detail)
    ? snapshot.detail.map(safeDetailRow).filter((row): row is AccountantDetailRow => row !== null)
    : [];
  return {
    schema_version: 2,
    contract: ACCOUNTANT_REPORT_CONTRACT,
    week_start: String(snapshot.week_start),
    week_end: String(snapshot.week_end),
    timezone: String(snapshot.timezone),
    policy: 'CA_STANDARD_8_40',
    version: Number(snapshot.version),
    status: 'final',
    finalized_at: String(snapshot.finalized_at),
    summary,
    detail,
    totals: totalsOf(summary),
  };
}

/**
 * Legacy snapshots are never returned verbatim: their employee IDs, day
 * anomalies and operational history are projected to a summary-only contract.
 */
export function adaptLegacySnapshot(input: {
  snapshot: unknown;
  timezone: string;
  version: number;
  finalizedAt: Date;
}): SafeAccountantReport {
  const raw = input.snapshot && typeof input.snapshot === 'object'
    ? input.snapshot as Record<string, unknown>
    : {};
  const employees = Array.isArray(raw.employees) ? raw.employees : [];
  const summary = employees.flatMap((value): AccountantSummaryRow[] => {
    if (!value || typeof value !== 'object') return [];
    const employee = value as Record<string, unknown>;
    if (!Number.isFinite(Number(employee.employee_number)) || typeof employee.full_name !== 'string') return [];
    return [{
      employee_number: Number(employee.employee_number),
      full_name: employee.full_name,
      plants: [],
      days_worked: exactSeconds(employee.days_worked),
      regular_seconds: exactSeconds(employee.regular_seconds, employee.regular_minutes),
      overtime_seconds: exactSeconds(employee.overtime_seconds, employee.overtime_minutes),
      double_time_seconds: exactSeconds(employee.double_time_seconds, employee.double_time_minutes),
      clocked_seconds: exactSeconds(employee.clocked_seconds, employee.clocked_minutes),
      manual_seconds: exactSeconds(employee.manual_seconds, employee.manual_minutes),
      total_seconds: exactSeconds(employee.total_seconds, employee.total_minutes),
    }];
  }).sort((left, right) => left.employee_number - right.employee_number);
  return {
    schema_version: 1,
    contract: 'legacy-week-computation-v1',
    week_start: typeof raw.week_start === 'string' ? raw.week_start : '',
    week_end: typeof raw.week_end === 'string' ? raw.week_end : '',
    timezone: input.timezone,
    policy: 'CA_STANDARD_8_40',
    version: input.version,
    status: 'final',
    finalized_at: input.finalizedAt.toISOString(),
    summary,
    detail: [],
    totals: totalsOf(summary),
  };
}

export type ReportArtifactKind = 'xlsx' | 'csv_summary' | 'csv_detail';

export interface RenderedReportArtifact {
  kind: ReportArtifactKind;
  content: Buffer;
  contentSha256: string;
  contentType: string;
  filename: string;
}

const SUMMARY_HEADERS = [
  'Versión', 'Estatus', '# Empleado', 'Nombre', 'Plantas', 'Días trabajados', 'Hrs regulares',
  'Hrs OT 1.5x', 'Hrs double 2x', 'Horas checadas', 'Horas manuales', 'Total hrs',
] as const;
const DETAIL_HEADERS = [
  'Versión', 'Estatus', '# Empleado', 'Nombre', 'Fecha', 'Planta', 'Checadas', 'Comida (min)',
  'Horas checadas', 'Horas manuales', 'Total hrs', 'Indicadores',
] as const;

function hours(seconds: number): number {
  return Math.round((seconds / 3_600) * 10_000) / 10_000;
}

/** Neutralizes Excel/Sheets formulas even when attackers prefix whitespace. */
export function spreadsheetSafeText(value: string): string {
  return /^\s*[=+\-@]/u.test(value) || /^[\u0009\u000d]/.test(value)
    ? `'${value}`
    : value;
}

function summaryValues(
  row: AccountantSummaryRow,
  snapshot: AccountantReportSnapshotV2,
): (string | number)[] {
  return [
    snapshot.version,
    snapshot.status,
    row.employee_number,
    spreadsheetSafeText(row.full_name),
    spreadsheetSafeText(row.plants.map((plant) => plant.code).join(', ')),
    row.days_worked,
    hours(row.regular_seconds),
    hours(row.overtime_seconds),
    hours(row.double_time_seconds),
    hours(row.clocked_seconds),
    hours(row.manual_seconds),
    hours(row.total_seconds),
  ];
}

function detailValues(
  row: AccountantDetailRow,
  snapshot: AccountantReportSnapshotV2,
): (string | number)[] {
  const punches = row.punches.map((punch) => {
    const time = DateTime.fromISO(punch.punched_at, { setZone: true })
      .setZone(snapshot.timezone).toFormat('HH:mm');
    return `${punch.punch_type} ${time}`;
  }).join(' | ');
  return [
    snapshot.version,
    snapshot.status,
    row.employee_number,
    spreadsheetSafeText(row.full_name),
    row.work_date,
    spreadsheetSafeText(`${row.plant_code} — ${row.plant_name}`),
    spreadsheetSafeText(punches),
    Math.round((row.meal_seconds / 60) * 100) / 100,
    hours(row.clocked_seconds),
    hours(row.manual_seconds),
    hours(row.total_seconds),
    spreadsheetSafeText(row.exception_indicators.join(', ')),
  ];
}

export function toSafeCsv(headers: readonly string[], rows: readonly (readonly (string | number)[])[]): Buffer {
  const escape = (value: string | number): string => {
    const raw = typeof value === 'string' ? spreadsheetSafeText(value) : String(value);
    return /[",\r\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
  };
  const csv = [headers, ...rows].map((row) => row.map(escape).join(',')).join('\r\n');
  return Buffer.from(`\uFEFF${csv}`, 'utf8');
}

function digest(content: Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function applySheetStyle(sheet: ExcelJS.Worksheet): void {
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  const header = sheet.getRow(1);
  sheet.autoFilter = { from: 'A1', to: header.getCell(Math.max(1, header.cellCount)).address };
  sheet.getRow(1).font = { bold: true };
  sheet.columns.forEach((column) => {
    let width = 10;
    column.eachCell?.({ includeEmpty: false }, (cell) => {
      width = Math.max(width, String(cell.value ?? '').length + 2);
    });
    column.width = Math.min(width, 42);
  });
}

/**
 * ExcelJS delegates ZIP metadata to the current clock. Repack every entry with
 * the frozen close timestamp so the same snapshot produces the same bytes even
 * in a later process. The stored artifact remains the delivery source of truth.
 */
async function freezeWorkbookZip(input: Buffer, timestamp: Date): Promise<Buffer> {
  const zip = await JSZip.loadAsync(input);
  for (const entry of Object.values(zip.files)) entry.date = timestamp;
  return zip.generateAsync({
    type: 'nodebuffer',
    platform: 'DOS',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
}

/** Produces canonical bytes once; callers persist and serve these exact bytes. */
export async function renderReportArtifacts(
  snapshotInput: AccountantReportSnapshotV2,
): Promise<RenderedReportArtifact[]> {
  const snapshot = sanitizeAccountantSnapshot(snapshotInput);
  const summaryRows = snapshot.summary.map((row) => summaryValues(row, snapshot));
  const detailRows = snapshot.detail.map((row) => detailValues(row, snapshot));
  const base = `nomina-semana-${snapshot.week_start}-v${snapshot.version}`;

  const summaryCsv = toSafeCsv(SUMMARY_HEADERS, summaryRows);
  const detailCsv = toSafeCsv(DETAIL_HEADERS, detailRows);

  const workbook = new ExcelJS.Workbook();
  const frozenTimestamp = new Date(snapshot.finalized_at);
  if (!Number.isFinite(frozenTimestamp.getTime())) throw new Error('invalid finalized_at');
  workbook.creator = 'ClockAI';
  workbook.company = 'ClockAI';
  workbook.created = frozenTimestamp;
  workbook.modified = frozenTimestamp;
  workbook.lastPrinted = frozenTimestamp;
  workbook.calcProperties.fullCalcOnLoad = false;

  const summarySheet = workbook.addWorksheet('Resumen');
  summarySheet.addRow([...SUMMARY_HEADERS]);
  for (const row of summaryRows) summarySheet.addRow(row);
  applySheetStyle(summarySheet);

  const detailSheet = workbook.addWorksheet('Detalle por planta');
  detailSheet.addRow([...DETAIL_HEADERS]);
  for (const row of detailRows) detailSheet.addRow(row);
  applySheetStyle(detailSheet);

  const renderedXlsx = Buffer.from(await workbook.xlsx.writeBuffer());
  const xlsx = await freezeWorkbookZip(renderedXlsx, frozenTimestamp);
  return [
    {
      kind: 'xlsx',
      content: xlsx,
      contentSha256: digest(xlsx),
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      filename: `${base}.xlsx`,
    },
    {
      kind: 'csv_summary',
      content: summaryCsv,
      contentSha256: digest(summaryCsv),
      contentType: 'text/csv; charset=utf-8',
      filename: `${base}-resumen.csv`,
    },
    {
      kind: 'csv_detail',
      content: detailCsv,
      contentSha256: digest(detailCsv),
      contentType: 'text/csv; charset=utf-8',
      filename: `${base}-detalle.csv`,
    },
  ];
}
