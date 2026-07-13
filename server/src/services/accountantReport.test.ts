import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import {
  adaptLegacySnapshot,
  renderReportArtifacts,
  sanitizeAccountantSnapshot,
  spreadsheetSafeText,
  toSafeCsv,
  type AccountantReportSnapshotV2,
} from './accountantReport.js';

const snapshot: AccountantReportSnapshotV2 = {
  schema_version: 2,
  contract: 'clockai-accountant-v1',
  week_start: '2026-07-05',
  week_end: '2026-07-11',
  timezone: 'America/Los_Angeles',
  policy: 'CA_STANDARD_8_40',
  version: 2,
  status: 'final',
  finalized_at: '2026-07-12T16:00:00.000Z',
  summary: [{
    employee_number: 41,
    full_name: '  =HYPERLINK("bad")',
    plants: [{ code: 'P1', name: 'Empaque Norte' }],
    days_worked: 1,
    regular_seconds: 28_800,
    overtime_seconds: 3_600,
    double_time_seconds: 0,
    clocked_seconds: 28_800,
    manual_seconds: 3_600,
    total_seconds: 32_400,
  }],
  detail: [{
    employee_number: 41,
    full_name: '  =HYPERLINK("bad")',
    work_date: '2026-07-06',
    plant_code: 'P1',
    plant_name: 'Empaque Norte',
    punches: [
      { punch_type: 'shift_in', punched_at: '2026-07-06T12:00:00.000Z' },
      { punch_type: 'shift_out', punched_at: '2026-07-06T20:00:00.000Z' },
    ],
    meal_seconds: 1_800,
    clocked_seconds: 28_800,
    manual_seconds: 3_600,
    total_seconds: 32_400,
    exception_indicators: [],
  }],
  totals: {
    regular_seconds: 28_800,
    overtime_seconds: 3_600,
    double_time_seconds: 0,
    clocked_seconds: 28_800,
    manual_seconds: 3_600,
    total_seconds: 32_400,
  },
};

describe('accountant report privacy and immutable artifacts', () => {
  it('projects legacy data through an explicit summary allowlist', () => {
    const adapted = adaptLegacySnapshot({
      snapshot: {
        week_start: '2026-07-05',
        week_end: '2026-07-11',
        issues: [{ employee_id: 'secret', detail: 'operational secret' }],
        employees: [{
          employee_id: 'secret-employee-id',
          employee_number: 41,
          full_name: 'Worker',
          social_security: '111-22-3333',
          regular_seconds: 10,
          overtime_seconds: 20,
          double_time_seconds: 30,
          clocked_seconds: 50,
          manual_seconds: 10,
          total_seconds: 60,
          days_worked: 1,
          days: [{ anomaly: 'secret', correction_reason: 'secret reason' }],
        }],
      },
      timezone: 'America/Los_Angeles',
      version: 1,
      finalizedAt: new Date('2026-07-12T16:00:00.000Z'),
    });

    expect(adapted).toMatchObject({
      schema_version: 1,
      contract: 'legacy-week-computation-v1',
      detail: [],
      summary: [{ employee_number: 41, full_name: 'Worker', total_seconds: 60 }],
    });
    const serialized = JSON.stringify(adapted);
    for (const secret of ['employee_id', 'social_security', 'issues', 'correction_reason']) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('re-sanitizes schema v2 instead of trusting extra persisted properties', () => {
    const hostile = {
      ...snapshot,
      finalized_by: 'secret-user',
      summary: [{ ...snapshot.summary[0], employee_id: 'secret-employee' }],
      detail: [{
        ...snapshot.detail[0],
        photo_url: 'secret-photo',
        correction_reason: 'secret-reason',
        punches: [{ ...snapshot.detail[0]!.punches[0], id: 'secret-punch' }],
      }],
    };
    const safe = sanitizeAccountantSnapshot(hostile);
    const serialized = JSON.stringify(safe);
    for (const secret of [
      'finalized_by', 'employee_id', 'photo_url', 'correction_reason', 'secret-punch',
    ]) expect(serialized).not.toContain(secret);
  });

  it('neutralizes formula injection after spaces, tab or carriage return', () => {
    expect(spreadsheetSafeText('=1+1')).toBe("'=1+1");
    expect(spreadsheetSafeText('  +cmd')).toBe("'  +cmd");
    expect(spreadsheetSafeText('\t@SUM(A1)')).toBe("'\t@SUM(A1)");
    expect(spreadsheetSafeText('\r-2+3')).toBe("'\r-2+3");
    expect(spreadsheetSafeText('\u00a0=2+2')).toBe("'\u00a0=2+2");
    expect(spreadsheetSafeText('Worker - 2')).toBe('Worker - 2');

    const csv = toSafeCsv(['name'], [[' =2+2'], ['normal']]).toString('utf8');
    expect(csv).toContain("' =2+2");
    expect(csv).not.toContain('\r\n =2+2');
  });

  it('renders deterministic XLSX/CSV bytes with stable SHA-256 digests', async () => {
    const first = await renderReportArtifacts(snapshot);
    // ZIP stores DOS timestamps at two-second resolution. Crossing that
    // boundary proves determinism is not an accidental same-tick render.
    await new Promise((resolve) => setTimeout(resolve, 3_100));
    const second = await renderReportArtifacts(snapshot);
    expect(first.map((item) => item.kind)).toEqual(['xlsx', 'csv_summary', 'csv_detail']);
    for (let index = 0; index < first.length; index += 1) {
      expect(first[index]!.content.equals(second[index]!.content)).toBe(true);
      expect(first[index]!.contentSha256).toBe(second[index]!.contentSha256);
      expect(first[index]!.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(first[0]!.content);
    const nameCell = workbook.getWorksheet('Resumen')!.getCell('D2');
    expect(nameCell.value).toBe("'  =HYPERLINK(\"bad\")");
    expect(nameCell.formula).toBeUndefined();
  }, 10_000);
});
