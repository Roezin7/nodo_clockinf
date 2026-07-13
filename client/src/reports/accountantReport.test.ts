import { describe, expect, it } from 'vitest';
import {
  ACCOUNTANT_EXCEPTION_LABELS,
  parseAccountantReport,
  parseReportVersionPage,
  parseReportVersions,
  parseReportWeekPage,
  parseReportWeeks,
  reportExportPath,
  reportModeForRole,
  reportVersionPath,
} from './accountantReport';

const safeSnapshot = {
  schema_version: 2,
  contract: 'clockai-accountant-v1',
  week_start: '2026-07-05',
  week_end: '2026-07-11',
  timezone: 'America/Los_Angeles',
  policy: 'CA_STANDARD_8_40',
  version: 3,
  status: 'final',
  finalized_at: '2026-07-12T18:00:00.000Z',
  summary: [{
    employee_number: 7,
    name: 'Ana',
    plants: [{ code: 'P1', name: 'Planta Uno' }],
    days_worked: 2,
    regular_seconds: 28_800,
    overtime_seconds: 3_600,
    double_time_seconds: 0,
    manual_seconds: 900,
    total_seconds: 33_300,
    employee_id: 'must-not-leak',
    hourly_rate: 99,
  }],
  detail: [{
    employee_number: 7,
    name: 'Ana',
    work_date: '2026-07-07',
    plant: { code: 'P1', name: 'Planta Uno', id: 'must-not-leak' },
    punches: [{ type: 'shift_in', occurred_at: '2026-07-07T12:00:00.000Z', id: 'must-not-leak' }],
    meal_seconds: 1_800,
    clock_seconds: 32_400,
    manual_seconds: 900,
    regular_seconds: 28_800,
    overtime_seconds: 3_600,
    double_time_seconds: 0,
    total_seconds: 33_300,
    exception_indicators: ['missing_shift_out'],
    reason: 'private',
    photo_url: 'private',
  }],
  totals: {
    regular_seconds: 28_800,
    overtime_seconds: 3_600,
    double_time_seconds: 0,
    manual_seconds: 900,
    total_seconds: 33_300,
  },
};

describe('contrato contable final e inmutable', () => {
  it('reduce la respuesta a una allowlist sin IDs, motivos, costos ni fotos', () => {
    const parsed = parseAccountantReport({
      snapshot: safeSnapshot,
      period_status: 'reopened',
      is_current_final: false,
      detail_available: true,
      finalized_by: 'private',
      finalization_reason: 'private',
    });
    expect(parsed.period_status).toBe('reopened');
    expect(parsed.summary[0]).toEqual({
      employee_number: 7,
      name: 'Ana',
      plants: [{ code: 'P1', name: 'Planta Uno' }],
      days_worked: 2,
      regular_seconds: 28_800,
      overtime_seconds: 3_600,
      double_time_seconds: 0,
      manual_seconds: 900,
      total_seconds: 33_300,
    });
    expect(JSON.stringify(parsed)).not.toMatch(/must-not-leak|private|hourly_rate|photo_url|employee_id/);
    expect(parsed.detail[0]?.exception_indicators).toEqual(['missing_shift_out']);
  });

  it('rechaza un preview no final en vez de enseñárselo a accountant', () => {
    expect(() => parseAccountantReport({ ...safeSnapshot, status: 'open' })).toThrow('sólo puede consultar');
  });

  it('adapta versiones legacy sin inventar detalle', () => {
    const parsed = parseReportVersions({ items: [{
      version: 1,
      finalized_at: '2026-07-06T18:00:00.000Z',
      snapshot_hash: 'abc',
      schema_version: 1,
      export_formats: ['xlsx', 'unsafe', 'csv_summary'],
      finalized_by_name: 'no debe cruzar al DTO',
      finalization_reason: 'no debe cruzar al DTO',
      id: 'no debe cruzar al DTO',
    }] });
    expect(parsed[0]).toMatchObject({
      schema_version: 1,
      detail_available: false,
      export_formats: ['xlsx', 'csv_summary'],
    });
    expect(JSON.stringify(parsed)).not.toMatch(/finalized_by|finalization_reason|no debe|\"id\"/);
  });

  it('consume semanas paginadas y conserva el estado reabierto', () => {
    expect(parseReportWeeks({ items: [{
      week_start: '2026-07-05',
      week_end: '2026-07-11',
      period_status: 'reopened',
      current_version: 2,
      finalized_at: '2026-07-12T18:00:00.000Z',
    }] })).toEqual([{
      week_start: '2026-07-05',
      week_end: '2026-07-11',
      period_status: 'reopened',
      current_version: 2,
      finalized_at: '2026-07-12T18:00:00.000Z',
    }]);
  });

  it('valida cursores paginados y no conserva formatos desconocidos', () => {
    expect(parseReportWeekPage({ items: [], next_cursor: '2026-06-01' }).next_cursor).toBe('2026-06-01');
    expect(parseReportWeekPage({ items: [], next_cursor: 'private' }).next_cursor).toBeNull();
    expect(parseReportVersionPage({
      items: [{
        version: 3,
        finalized_at: '2026-07-12T18:00:00.000Z',
        schema_version: 2,
        export_formats: ['csv_detail', 'javascript'],
      }],
      next_cursor: 3,
    })).toMatchObject({
      next_cursor: 3,
      items: [{ export_formats: ['csv_detail'] }],
    });
  });

  it('mantiene etiquetas cerradas para indicadores contables', () => {
    expect(ACCOUNTANT_EXCEPTION_LABELS).toEqual({
      missing_shift_out: 'Falta checada de salida',
      missing_meal_in: 'Falta regreso de comida',
      out_of_sequence: 'Orden de checadas por revisar',
      overlap_between_plants: 'Traslape entre plantas',
    });
  });

  it('siempre exige semana y versión explícita para consultar y exportar', () => {
    expect(reportVersionPath('2026-07-05', 3)).toBe('/api/reports/week/2026-07-05/versions/3');
    expect(reportExportPath('2026-07-05', 3, 'xlsx')).toBe(
      '/api/reports/week/2026-07-05/versions/3/export?format=xlsx',
    );
    expect(reportExportPath('2026-07-05', 3, 'csv', 'detail')).toBe(
      '/api/reports/week/2026-07-05/versions/3/export?format=csv&sheet=detail',
    );
  });

  it('impide que accountant elija el modo preview', () => {
    expect(reportModeForRole('accountant')).toBe('final_only');
    expect(reportModeForRole('admin')).toBe('admin_preview');
  });
});
