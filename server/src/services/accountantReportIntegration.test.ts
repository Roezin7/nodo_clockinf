import crypto from 'node:crypto';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { pool, query, queryOne } from '../db.js';
import { signAccessToken, type AuthUser } from '../middleware/auth.js';

const run = process.env.RUN_DB_INTEGRATION === '1';
const WEEK = '2026-06-21';

let server: Server;
let baseUrl = '';
let organizationId = '';
let otherOrganizationId = '';
let firstPlantId = '';
let secondPlantId = '';
let employeeId = '';
let adminId = '';
let adminToken = '';
let accountantToken = '';
let otherAccountantToken = '';

function token(user: AuthUser): string {
  return signAccessToken(user);
}

async function request(
  path: string,
  bearer: string,
  init: RequestInit = {},
): Promise<{ response: Response; json: Record<string, any> }> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${bearer}`,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  return {
    response,
    json: (await response.clone().json().catch(() => ({}))) as Record<string, any>,
  };
}

async function post(
  path: string,
  bearer: string,
  body: Record<string, unknown>,
): ReturnType<typeof request> {
  return request(path, bearer, { method: 'POST', body: JSON.stringify(body) });
}

async function insertPunch(
  plantId: string,
  type: 'shift_in' | 'shift_out',
  timestamp: string,
): Promise<void> {
  await query(
    `INSERT INTO punches
       (organization_id, employee_id, plant_id, punch_type, punched_at,
        captured_at, source, created_by, identity_status, evidence_status)
     VALUES ($1, $2, $3, $4, $5, $5, 'manual', $6, 'not_required', 'captured')`,
    [organizationId, employeeId, plantId, type, timestamp, adminId],
  );
}

describe.skipIf(!run)('Phase 7 accountant contract + PostgreSQL/API integration', () => {
  beforeAll(async () => {
    const suffix = crypto.randomUUID();
    const organization = await queryOne<{ id: string }>(
      `INSERT INTO organizations (name, slug, timezone)
       VALUES ('F7 Accountant Contract', $1, 'America/Los_Angeles') RETURNING id`,
      [`f7-accountant-${suffix}`],
    );
    const otherOrganization = await queryOne<{ id: string }>(
      `INSERT INTO organizations (name, slug, timezone)
       VALUES ('F7 Other Tenant', $1, 'America/Los_Angeles') RETURNING id`,
      [`f7-other-${suffix}`],
    );
    organizationId = organization!.id;
    otherOrganizationId = otherOrganization!.id;

    const [firstPlant, secondPlant] = await Promise.all([
      queryOne<{ id: string }>(
        `INSERT INTO plants (organization_id, code, name)
         VALUES ($1, 'P1', 'Empaque Norte') RETURNING id`,
        [organizationId],
      ),
      queryOne<{ id: string }>(
        `INSERT INTO plants (organization_id, code, name)
         VALUES ($1, 'P2', 'Empaque Sur') RETURNING id`,
        [organizationId],
      ),
    ]);
    firstPlantId = firstPlant!.id;
    secondPlantId = secondPlant!.id;

    const employee = await queryOne<{ id: string }>(
      `INSERT INTO employees
         (organization_id, full_name, social_security, pin_hash)
       VALUES ($1, '  =HYPERLINK("https://evil.invalid")', '111-22-3333', 'unused')
       RETURNING id`,
      [organizationId],
    );
    employeeId = employee!.id;

    const admin = await queryOne<{ id: string }>(
      `INSERT INTO users (organization_id, email, password_hash, role, name)
       VALUES ($1, $2, 'unused', 'admin', 'F7 Admin') RETURNING id`,
      [organizationId, `f7-admin-${suffix}@test.invalid`],
    );
    const accountant = await queryOne<{ id: string }>(
      `INSERT INTO users (organization_id, email, password_hash, role, name)
       VALUES ($1, $2, 'unused', 'accountant', 'F7 Accountant') RETURNING id`,
      [organizationId, `f7-accountant-${suffix}@test.invalid`],
    );
    const otherAccountant = await queryOne<{ id: string }>(
      `INSERT INTO users (organization_id, email, password_hash, role, name)
       VALUES ($1, $2, 'unused', 'accountant', 'Other Accountant') RETURNING id`,
      [otherOrganizationId, `f7-other-${suffix}@test.invalid`],
    );
    adminId = admin!.id;
    adminToken = token({
      id: adminId,
      role: 'admin',
      name: 'F7 Admin',
      email: `f7-admin-${suffix}@test.invalid`,
      organizationId,
    });
    accountantToken = token({
      id: accountant!.id,
      role: 'accountant',
      name: 'F7 Accountant',
      email: `f7-accountant-${suffix}@test.invalid`,
      organizationId,
    });
    otherAccountantToken = token({
      id: otherAccountant!.id,
      role: 'accountant',
      name: 'Other Accountant',
      email: `f7-other-${suffix}@test.invalid`,
      organizationId: otherOrganizationId,
    });

    await insertPunch(firstPlantId, 'shift_in', '2026-06-22T12:00:00.000Z');
    await insertPunch(firstPlantId, 'shift_out', '2026-06-22T16:00:00.000Z');
    await insertPunch(secondPlantId, 'shift_in', '2026-06-22T16:30:00.000Z');
    await insertPunch(secondPlantId, 'shift_out', '2026-06-22T20:30:00.000Z');
    await query(
      `INSERT INTO manual_time_entries
         (organization_id, employee_id, plant_id, work_date, duration_seconds,
          reason, created_by)
       VALUES ($1, $2, $3, '2026-06-22', 3600, 'Bono solicitado', $4)`,
      [organizationId, employeeId, secondPlantId, adminId],
    );

    await new Promise<void>((resolve) => {
      server = createApp().listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('No test port');
        baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
  });

  it('enforces final-only RBAC and freezes a private multi-plant report with exact exports', async () => {
    const live = await request(`/api/reports/week/${WEEK}`, accountantToken);
    expect(live.response.status).toBe(409);
    expect(live.json.code).toBe('report_not_final');

    const forbiddenPreview = await request(`/api/reports/week/${WEEK}/preview`, accountantToken);
    expect(forbiddenPreview.response.status).toBe(403);

    const beforeWeeks = await request('/api/reports/weeks?limit=1', accountantToken);
    expect(beforeWeeks.response.status).toBe(200);
    expect(beforeWeeks.json.items).toEqual([]);

    const ready = await post(
      `/api/reports/week/${WEEK}/ready-for-review`,
      adminToken,
      {},
    );
    expect(ready.response.status).toBe(200);
    expect(ready.json.status).toBe('ready_for_review');

    const frozenMutation = await post('/api/manual-time', adminToken, {
      employee_id: employeeId,
      plant_id: firstPlantId,
      work_date: '2026-06-22',
      hours: 0.5,
      reason: 'Must not enter while reviewing',
    });
    expect(frozenMutation.response.status).toBe(409);
    expect(frozenMutation.json.code).toBe('period_ready_for_review');

    const closed = await post(`/api/reports/week/${WEEK}/finalize`, adminToken, {});
    expect(closed.response.status).toBe(201);
    expect(closed.json).toMatchObject({ version: 1, week_start: WEEK });
    expect(closed.json.snapshot_hash).toMatch(/^[0-9a-f]{64}$/);

    const stored = await queryOne<{
      id: string;
      snapshot: Record<string, any>;
      snapshot_schema_version: number;
      snapshot_contract: string;
      hash_algorithm: string;
    }>(
      `SELECT rv.id, rv.snapshot, rv.snapshot_schema_version,
              rv.snapshot_contract, rv.hash_algorithm
       FROM report_versions rv
       JOIN pay_periods p ON p.id = rv.pay_period_id
       WHERE rv.organization_id = $1 AND p.week_start = $2::date AND rv.version = 1`,
      [organizationId, WEEK],
    );
    expect(stored).toMatchObject({
      snapshot_schema_version: 2,
      snapshot_contract: 'clockai-accountant-v1',
      hash_algorithm: 'sha256',
    });
    expect(stored!.snapshot.summary[0]).toMatchObject({
      plants: [{ code: 'P1', name: 'Empaque Norte' }, { code: 'P2', name: 'Empaque Sur' }],
      regular_seconds: 28_800,
      overtime_seconds: 3_600,
      manual_seconds: 3_600,
      total_seconds: 32_400,
    });

    const artifactRows = await query<{
      kind: string;
      content_sha256: string;
      byte_length: number;
      actual_length: number;
    }>(
      `SELECT kind, content_sha256, byte_length, octet_length(content) AS actual_length
       FROM report_export_artifacts
       WHERE organization_id = $1 AND report_version_id = $2
       ORDER BY kind`,
      [organizationId, stored!.id],
    );
    expect(artifactRows).toHaveLength(3);
    expect(artifactRows.every((row) => row.byte_length === row.actual_length)).toBe(true);

    const report = await request(
      `/api/reports/week/${WEEK}/versions/1`,
      accountantToken,
    );
    expect(report.response.status).toBe(200);
    expect(report.response.headers.get('cache-control')).toContain('no-store');
    expect(report.response.headers.get('etag')).toContain(closed.json.snapshot_hash);
    const finalCurrentEtag = report.response.headers.get('etag');
    expect(finalCurrentEtag).toBeTruthy();
    expect(report.json).toMatchObject({
      schema_version: 2,
      contract: 'clockai-accountant-v1',
      version: 1,
      status: 'final',
      period_status: 'final',
      is_current_final: true,
      detail_available: true,
    });
    const serialized = JSON.stringify(report.json);
    for (const forbidden of [
      employeeId,
      firstPlantId,
      secondPlantId,
      adminId,
      'employee_id',
      'social_security',
      'correction_reason',
      'finalization_reason',
      'photo_key',
      'hourly_rate',
    ]) expect(serialized).not.toContain(forbidden);

    const versions = await request(
      `/api/reports/week/${WEEK}/versions?limit=1`,
      accountantToken,
    );
    expect(versions.response.status).toBe(200);
    expect(versions.json.items).toEqual([
      expect.objectContaining({
        version: 1,
        detail_available: true,
        export_formats: ['csv_detail', 'csv_summary', 'xlsx'],
      }),
    ]);
    expect(JSON.stringify(versions.json)).not.toMatch(/finalized_by|finalization_reason|"id"/);

    const firstCsvResponse = await fetch(
      `${baseUrl}/api/reports/week/${WEEK}/versions/1/export?format=csv&sheet=summary`,
      { headers: { authorization: `Bearer ${accountantToken}` } },
    );
    const secondCsvResponse = await fetch(
      `${baseUrl}/api/reports/week/${WEEK}/versions/1/export?format=csv&sheet=summary`,
      { headers: { authorization: `Bearer ${accountantToken}` } },
    );
    expect(firstCsvResponse.status).toBe(200);
    expect(secondCsvResponse.status).toBe(200);
    const firstCsv = Buffer.from(await firstCsvResponse.arrayBuffer());
    const secondCsv = Buffer.from(await secondCsvResponse.arrayBuffer());
    expect(firstCsv.equals(secondCsv)).toBe(true);
    expect(crypto.createHash('sha256').update(firstCsv).digest('hex')).toBe(
      firstCsvResponse.headers.get('x-content-sha256'),
    );
    expect(firstCsv.toString('utf8')).toContain("'  =HYPERLINK");
    expect(firstCsv.toString('utf8')).toContain('Versión,Estatus');

    const crossTenant = await request(
      `/api/reports/week/${WEEK}/versions/1`,
      otherAccountantToken,
    );
    expect(crossTenant.response.status).toBe(404);
    const crossTenantExport = await request(
      `/api/reports/week/${WEEK}/versions/1/export?format=xlsx`,
      otherAccountantToken,
    );
    expect(crossTenantExport.response.status).toBe(404);

    const audit = await queryOne<{ metadata: Record<string, any> }>(
      `SELECT metadata FROM audit_events
       WHERE organization_id = $1 AND action = 'report.export_requested'
       ORDER BY created_at DESC LIMIT 1`,
      [organizationId],
    );
    expect(audit?.metadata).toMatchObject({
      week_start: WEEK,
      version: 1,
      kind: 'csv_summary',
    });
    expect(JSON.stringify(audit?.metadata)).not.toContain(employeeId);

    await query(`UPDATE employees SET full_name = 'Renamed Worker' WHERE id = $1`, [employeeId]);
    await query(`UPDATE plants SET name = 'Renamed Plant' WHERE id = $1`, [firstPlantId]);
    const frozen = await request(`/api/reports/week/${WEEK}/versions/1`, accountantToken);
    expect(frozen.json.summary[0].full_name).toContain('HYPERLINK');
    expect(frozen.json.summary[0].plants[0].name).toBe('Empaque Norte');

    await expect(query(
      `UPDATE report_export_artifacts SET filename = 'changed.xlsx'
       WHERE report_version_id = $1 AND kind = 'xlsx'`,
      [stored!.id],
    )).rejects.toThrow(/immutable/);

    const reopened = await post(`/api/reports/week/${WEEK}/reopen`, adminToken, {
      reason: 'Verificar invalidación de caché histórica',
    });
    expect(reopened.response.status).toBe(200);
    const reopenedVersion = await request(
      `/api/reports/week/${WEEK}/versions/1`,
      accountantToken,
      { headers: { 'if-none-match': finalCurrentEtag! } },
    );
    expect(reopenedVersion.response.status).toBe(200);
    expect(reopenedVersion.json).toMatchObject({
      period_status: 'reopened',
      is_current_final: false,
    });
    const reopenedEtag = reopenedVersion.response.headers.get('etag');
    expect(reopenedEtag).toBeTruthy();
    expect(reopenedEtag).not.toBe(finalCurrentEtag);

    const secondReview = await post(
      `/api/reports/week/${WEEK}/ready-for-review`,
      adminToken,
      {},
    );
    expect(secondReview.response.status).toBe(200);
    const secondClose = await post(`/api/reports/week/${WEEK}/finalize`, adminToken, {});
    expect(secondClose.response.status).toBe(201);
    expect(secondClose.json.version).toBe(2);

    // Status is again "final", exactly as in the first response; only
    // is_current_final changed because version 2 superseded version 1.
    const supersededVersion = await request(
      `/api/reports/week/${WEEK}/versions/1`,
      accountantToken,
      { headers: { 'if-none-match': finalCurrentEtag! } },
    );
    expect(supersededVersion.response.status).toBe(200);
    expect(supersededVersion.json).toMatchObject({
      period_status: 'final',
      is_current_final: false,
    });
    const supersededEtag = supersededVersion.response.headers.get('etag');
    expect(supersededEtag).toBeTruthy();
    expect(supersededEtag).not.toBe(finalCurrentEtag);
    const unchanged = await request(
      `/api/reports/week/${WEEK}/versions/1`,
      accountantToken,
      { headers: { 'if-none-match': supersededEtag! } },
    );
    expect(unchanged.response.status).toBe(304);
  });

  it('adapts legacy snapshots without leaks and explicitly rejects legacy export', async () => {
    const legacyWeek = '2026-06-07';
    const period = await queryOne<{ id: string }>(
      `INSERT INTO pay_periods
         (organization_id, week_start, week_end, status, current_version,
          finalized_at, finalized_by)
       VALUES ($1, $2::date, ($2::date + 6), 'final', 1, now(), $3)
       RETURNING id`,
      [organizationId, legacyWeek, adminId],
    );
    await query(
      `INSERT INTO report_versions
         (organization_id, pay_period_id, version, snapshot, snapshot_hash,
          snapshot_schema_version, snapshot_contract, hash_algorithm,
          finalized_by, finalization_reason)
       VALUES ($1, $2, 1, $3, $4, 1, 'legacy-week-computation-v1', 'md5',
               $5, 'Secret migration reason')`,
      [
        organizationId,
        period!.id,
        JSON.stringify({
          week_start: legacyWeek,
          week_end: '2026-06-13',
          issues: [{ employee_id: employeeId, detail: 'secret issue' }],
          employees: [{
            employee_id: employeeId,
            employee_number: 900,
            full_name: 'Legacy Worker',
            regular_minutes: 60,
            overtime_minutes: 0,
            double_time_minutes: 0,
            total_minutes: 60,
            days_worked: 1,
            days: [{ correction_reason: 'secret correction' }],
          }],
        }),
        '0'.repeat(32),
        adminId,
      ],
    );

    const legacy = await request(
      `/api/reports/week/${legacyWeek}/versions/1`,
      accountantToken,
    );
    expect(legacy.response.status).toBe(200);
    expect(legacy.json).toMatchObject({
      schema_version: 1,
      contract: 'legacy-week-computation-v1',
      detail_available: false,
      detail: [],
      summary: [{ employee_number: 900, full_name: 'Legacy Worker', total_seconds: 3_600 }],
    });
    expect(JSON.stringify(legacy.json)).not.toMatch(/employee_id|secret issue|secret correction|migration reason/i);

    const unavailable = await request(
      `/api/reports/week/${legacyWeek}/versions/1/export?format=xlsx`,
      accountantToken,
    );
    expect(unavailable.response.status).toBe(409);
    expect(unavailable.json.code).toBe('legacy_export_unavailable');

    const weeks = await request('/api/reports/weeks?limit=1', accountantToken);
    expect(weeks.response.status).toBe(200);
    expect(weeks.json.items).toHaveLength(1);
    expect(weeks.json.next_cursor).toBeDefined();
    expect(JSON.stringify(weeks.json)).not.toMatch(/finalized_by|finalization_reason|"id"/);
  });
});
