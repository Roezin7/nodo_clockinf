import crypto from 'node:crypto';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { pool, query, queryOne } from '../db.js';
import { signAccessToken, type AuthUser } from '../middleware/auth.js';

const run = process.env.RUN_DB_INTEGRATION === '1';

let server: Server;
let baseUrl = '';
let organizationId = '';
let otherOrganizationId = '';
let adminId = '';
let otherAdminId = '';
let adminToken = '';
let foremanToken = '';
let otherAdminToken = '';
let employeeId = '';

function authToken(user: AuthUser): string {
  return signAccessToken(user);
}

async function request(
  path: string,
  bearer: string,
  options: RequestInit = {}
): Promise<{ response: Response; body: Record<string, any> }> {
  const headers = new Headers(options.headers);
  headers.set('authorization', `Bearer ${bearer}`);
  if (options.body) headers.set('content-type', 'application/json');
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  return {
    response,
    body: (await response.json().catch(() => ({}))) as Record<string, any>,
  };
}

async function post(
  path: string,
  bearer: string,
  body: Record<string, unknown>
): Promise<{ response: Response; body: Record<string, any> }> {
  return request(path, bearer, { method: 'POST', body: JSON.stringify(body) });
}

describe.skipIf(!run)('Phase 8 employee rate API + PostgreSQL integration', () => {
  beforeAll(async () => {
    const suffix = crypto.randomUUID();
    const organization = await queryOne<{ id: string }>(
      `INSERT INTO organizations (name, slug, timezone)
       VALUES ('Rate Integration', $1, 'America/Los_Angeles')
       RETURNING id`,
      [`rate-integration-${suffix}`]
    );
    const otherOrganization = await queryOne<{ id: string }>(
      `INSERT INTO organizations (name, slug, timezone)
       VALUES ('Other Rate Integration', $1, 'America/Los_Angeles')
       RETURNING id`,
      [`other-rate-integration-${suffix}`]
    );
    organizationId = organization!.id;
    otherOrganizationId = otherOrganization!.id;

    const admin = await queryOne<{ id: string }>(
      `INSERT INTO users (organization_id, email, password_hash, role, name)
       VALUES ($1, $2, 'unused', 'admin', 'Rate Admin') RETURNING id`,
      [organizationId, `rate-admin-${suffix}@test.invalid`]
    );
    const foreman = await queryOne<{ id: string }>(
      `INSERT INTO users (organization_id, email, password_hash, role, name)
       VALUES ($1, $2, 'unused', 'foreman', 'Rate Foreman') RETURNING id`,
      [organizationId, `rate-foreman-${suffix}@test.invalid`]
    );
    const otherAdmin = await queryOne<{ id: string }>(
      `INSERT INTO users (organization_id, email, password_hash, role, name)
       VALUES ($1, $2, 'unused', 'admin', 'Other Rate Admin') RETURNING id`,
      [otherOrganizationId, `other-rate-admin-${suffix}@test.invalid`]
    );
    adminId = admin!.id;
    otherAdminId = otherAdmin!.id;
    adminToken = authToken({
      id: adminId,
      organizationId,
      role: 'admin',
      name: 'Rate Admin',
      email: `rate-admin-${suffix}@test.invalid`,
    });
    foremanToken = authToken({
      id: foreman!.id,
      organizationId,
      role: 'foreman',
      name: 'Rate Foreman',
      email: `rate-foreman-${suffix}@test.invalid`,
    });
    otherAdminToken = authToken({
      id: otherAdmin!.id,
      organizationId: otherOrganizationId,
      role: 'admin',
      name: 'Other Rate Admin',
      email: `other-rate-admin-${suffix}@test.invalid`,
    });

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

  it('validates the strict initial-rate contract and creates employee, rate and audits atomically', async () => {
    const legacyField = await post('/api/employees', adminToken, {
      full_name: 'Ignored Legacy Rate',
      initial_hourly_rate: '20.00',
      rate_effective_from: '2026-01-01',
    });
    expect(legacyField.response.status).toBe(400);

    const numericRate = await post('/api/employees', adminToken, {
      full_name: 'Numeric Rate',
      hourly_rate: 20,
      rate_effective_from: '2026-01-01',
    });
    expect(numericRate.response.status).toBe(400);

    const missingPair = await post('/api/employees', adminToken, {
      full_name: 'Missing Pair',
      hourly_rate: '20.00',
    });
    expect(missingPair.response.status).toBe(400);

    const impossibleDate = await post('/api/employees', adminToken, {
      full_name: 'Impossible Date',
      hourly_rate: '20.00',
      rate_effective_from: '2026-02-30',
    });
    expect(impossibleDate.response.status).toBe(400);

    const created = await post('/api/employees', adminToken, {
      full_name: 'Private Rate Worker',
      social_security: '111-22-3333',
      phone: '209-555-0100',
      hired_at: '2026-01-01',
      hourly_rate: '20.125',
      rate_effective_from: '2026-01-01',
      pin: '1234',
    });
    expect(created.response.status).toBe(201);
    expect(created.body).toMatchObject({
      full_name: 'Private Rate Worker',
      current_rate: { hourly_rate: '20.1250', effective_from: '2026-01-01' },
      pin: '1234',
    });
    employeeId = created.body.id as string;

    const rate = await queryOne<{ hourly_rate: string; effective_from: string }>(
      `SELECT hourly_rate::text, effective_from
       FROM employee_rates WHERE employee_id = $1`,
      [employeeId]
    );
    expect(rate).toEqual({ hourly_rate: '20.1250', effective_from: '2026-01-01' });
    expect(
      await queryOne<{ social_security: string }>(
        `SELECT social_security FROM employees WHERE id = $1`, [employeeId],
      ),
    ).toEqual({ social_security: expect.stringMatching(/^enc:v1:/) });
    const actions = await query<{ action: string }>(
      `SELECT action FROM audit_events
       WHERE organization_id = $1 AND entity_id IN ($2, $3)
       ORDER BY created_at`,
      [organizationId, employeeId, created.body.current_rate?.id ?? employeeId]
    );
    expect(actions.map((event) => event.action)).toContain('employee.created');
    expect(
      await queryOne(
        `SELECT id FROM audit_events
         WHERE organization_id = $1 AND action = 'employee.rate_initialized'
           AND metadata ->> 'employee_id' = $2`,
        [organizationId, employeeId]
      )
    ).not.toBeNull();

    const fakeActorToken = authToken({
      id: crypto.randomUUID(),
      organizationId,
      role: 'admin',
      name: 'Nonexistent Admin',
      email: 'nonexistent@test.invalid',
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementationOnce(() => undefined);
    const rolledBack = await post('/api/employees', fakeActorToken, {
      full_name: 'Must Roll Back Completely',
      hired_at: '2026-01-01',
      hourly_rate: '19.0000',
      rate_effective_from: '2026-01-01',
    });
    errorSpy.mockRestore();
    expect(rolledBack.response.status).toBe(401);
    expect(
      await queryOne(`SELECT id FROM employees WHERE full_name = 'Must Roll Back Completely'`)
    ).toBeNull();
  });

  it('exposes only least-data employee and rate fields to each role and tenant', async () => {
    const adminList = await request('/api/employees', adminToken);
    expect(adminList.response.status).toBe(200);
    expect(adminList.response.headers.get('cache-control')).toContain('no-store');
    const listed = (adminList.body as unknown as Array<Record<string, any>>).find(
      (employee) => employee.id === employeeId
    )!;
    expect(listed).toMatchObject({
      phone: '209-555-0100',
      current_rate: { hourly_rate: '20.1250', effective_from: '2026-01-01' },
    });
    expect(listed).not.toHaveProperty('social_security');
    expect(listed).not.toHaveProperty('enrollment_photo_key');

    const detail = await request(`/api/employees/${employeeId}`, adminToken);
    expect(detail.response.status).toBe(200);
    expect(detail.response.headers.get('cache-control')).toContain('no-store');
    expect(detail.body.social_security).toBe('111-22-3333');
    expect(detail.body).not.toHaveProperty('enrollment_photo_key');

    const foremanList = await request('/api/employees', foremanToken);
    expect(foremanList.response.status).toBe(200);
    const foremanEmployee = (foremanList.body as unknown as Array<Record<string, any>>).find(
      (employee) => employee.id === employeeId
    )!;
    expect(foremanEmployee).not.toHaveProperty('social_security');
    expect(foremanEmployee).not.toHaveProperty('phone');
    expect(foremanEmployee).not.toHaveProperty('current_rate');
    expect(foremanEmployee).not.toHaveProperty('current_biometric_enrollment_id');

    const forbiddenRates = await request(`/api/employees/${employeeId}/rates`, foremanToken);
    expect(forbiddenRates.response.status).toBe(403);
    const foreignRates = await request(`/api/employees/${employeeId}/rates`, otherAdminToken);
    expect(foreignRates.response.status).toBe(404);
    const foreignDetail = await request(`/api/employees/${employeeId}`, otherAdminToken);
    expect(foreignDetail.response.status).toBe(404);

    const retired = await post(`/api/employees/${employeeId}/rates`, adminToken, {
      hourly_rate: '99.0000',
      effective_from: '2026-02-01',
    });
    expect(retired.response.status).toBe(410);
    expect(retired.body.code).toBe('RATE_ENDPOINT_RETIRED');
  });

  it('splits covered history deterministically, preserves reasons and audits exact before/after facts', async () => {
    const future = await post(`/api/employees/${employeeId}/rates/change`, adminToken, {
      hourly_rate: '21.5',
      effective_from: '2026-02-01',
      reason: 'Aumento programado',
    });
    expect(future.response.status).toBe(201);
    expect(future.body).toMatchObject({
      hourly_rate: '21.5000',
      effective_from: '2026-02-01',
      effective_to: null,
      reason: 'Aumento programado',
    });

    const split = await post(`/api/employees/${employeeId}/rates/change`, adminToken, {
      hourly_rate: '22.25',
      effective_from: '2026-01-15',
      reason: 'Corrección autorizada',
    });
    expect(split.response.status).toBe(201);
    expect(split.body).toMatchObject({
      hourly_rate: '22.2500',
      effective_from: '2026-01-15',
      effective_to: '2026-01-31',
    });

    const rates = await request(`/api/employees/${employeeId}/rates`, adminToken);
    expect(rates.response.status).toBe(200);
    expect(rates.body).toEqual([
      expect.objectContaining({
        hourly_rate: '21.5000',
        effective_from: '2026-02-01',
        effective_to: null,
        reason: 'Aumento programado',
      }),
      expect.objectContaining({
        hourly_rate: '22.2500',
        effective_from: '2026-01-15',
        effective_to: '2026-01-31',
        reason: 'Corrección autorizada',
      }),
      expect.objectContaining({
        hourly_rate: '20.1250',
        effective_from: '2026-01-01',
        effective_to: '2026-01-14',
        reason: null,
      }),
    ]);

    const audit = await queryOne<{
      reason: string;
      metadata: Record<string, any>;
    }>(
      `SELECT reason, metadata FROM audit_events
       WHERE organization_id = $1 AND entity_id = $2`,
      [organizationId, split.body.id]
    );
    expect(audit).toMatchObject({
      reason: 'Corrección autorizada',
      metadata: {
        employee_id: employeeId,
        old: {
          hourly_rate: '20.1250',
          effective_from: '2026-01-01',
          effective_to_before: '2026-01-31',
          effective_to_after: '2026-01-14',
        },
        new: {
          hourly_rate: '22.2500',
          effective_from: '2026-01-15',
          effective_to: '2026-01-31',
        },
      },
    });

    const duplicate = await post(`/api/employees/${employeeId}/rates/change`, adminToken, {
      hourly_rate: '23.00',
      effective_from: '2026-01-15',
      reason: 'Intento duplicado',
    });
    expect(duplicate.response.status).toBe(409);
    expect(duplicate.body.code).toBe('RATE_DATE_CONFLICT');

    const unchanged = await post(`/api/employees/${employeeId}/rates/change`, adminToken, {
      hourly_rate: '21.5000',
      effective_from: '2026-03-01',
      reason: 'Sin cambio real',
    });
    expect(unchanged.response.status).toBe(409);
    expect(unchanged.body.code).toBe('RATE_UNCHANGED');
  });

  it('fills legacy history gaps explicitly and rejects a hire date moved after the first rate', async () => {
    const gapEmployee = await queryOne<{ id: string }>(
      `INSERT INTO employees (organization_id, full_name, pin_hash, hired_at)
       VALUES ($1, 'Gap Rate Worker', 'unused', '2026-01-01') RETURNING id`,
      [organizationId]
    );
    await query(
      `INSERT INTO employee_rates
         (organization_id, employee_id, hourly_rate, effective_from, effective_to, created_by)
       VALUES
         ($1, $2, 18, '2026-01-01', '2026-01-10', $3),
         ($1, $2, 19, '2026-02-01', NULL, $3)`,
      [organizationId, gapEmployee!.id, adminId]
    );
    const gap = await post(`/api/employees/${gapEmployee!.id}/rates/change`, adminToken, {
      hourly_rate: '18.50',
      effective_from: '2026-01-20',
      reason: 'Fecha dentro del hueco',
    });
    expect(gap.response.status).toBe(201);
    expect(gap.body).toMatchObject({
      hourly_rate: '18.5000',
      effective_from: '2026-01-20',
      effective_to: '2026-01-31',
      reason: 'Fecha dentro del hueco',
    });

    const invalidHire = await request(`/api/employees/${employeeId}`, adminToken, {
      method: 'PATCH',
      body: JSON.stringify({ hired_at: '2026-01-02' }),
    });
    expect(invalidHire.response.status).toBe(409);
    expect(invalidHire.body.code).toBe('RATE_HIRE_AFTER_FIRST_RATE');
    expect(
      await queryOne<{ hired_at: string }>(`SELECT hired_at FROM employees WHERE id = $1`, [
        employeeId,
      ])
    ).toEqual({ hired_at: '2026-01-01' });
  });

  it('serializes concurrent changes and allows an explicit first rate for missing-rate employees', async () => {
    const firstRateEmployee = await queryOne<{ id: string }>(
      `INSERT INTO employees (organization_id, full_name, pin_hash, hired_at)
       VALUES ($1, 'No Initial Rate', 'unused', '2026-01-01') RETURNING id`,
      [organizationId]
    );
    const firstRate = await post(
      `/api/employees/${firstRateEmployee!.id}/rates/change`,
      adminToken,
      {
        hourly_rate: '17.75',
        effective_from: '2026-01-01',
        reason: 'Primera tasa documentada',
      }
    );
    expect(firstRate.response.status).toBe(201);

    const concurrentEmployee = await queryOne<{ id: string }>(
      `INSERT INTO employees (organization_id, full_name, pin_hash, hired_at)
       VALUES ($1, 'Concurrent Rate Worker', 'unused', '2026-01-01') RETURNING id`,
      [organizationId]
    );
    await query(
      `INSERT INTO employee_rates
         (organization_id, employee_id, hourly_rate, effective_from, created_by)
       VALUES ($1, $2, 20, '2026-01-01', $3)`,
      [organizationId, concurrentEmployee!.id, adminId]
    );
    const results = await Promise.all([
      post(`/api/employees/${concurrentEmployee!.id}/rates/change`, adminToken, {
        hourly_rate: '21.00',
        effective_from: '2026-02-01',
        reason: 'Cambio simultáneo uno',
      }),
      post(`/api/employees/${concurrentEmployee!.id}/rates/change`, adminToken, {
        hourly_rate: '22.00',
        effective_from: '2026-02-01',
        reason: 'Cambio simultáneo dos',
      }),
    ]);
    expect(results.map((result) => result.response.status).sort()).toEqual([201, 409]);
    expect(results.find((result) => result.response.status === 409)?.body.code).toBe(
      'RATE_DATE_CONFLICT'
    );
    const concurrentRates = await query<RateRow>(
      `SELECT hourly_rate::text, effective_from, effective_to
       FROM employee_rates WHERE employee_id = $1 ORDER BY effective_from`,
      [concurrentEmployee!.id]
    );
    expect(concurrentRates).toHaveLength(2);
    expect(concurrentRates[0]?.effective_to).toBe('2026-01-31');
    expect(concurrentRates[1]?.effective_from).toBe('2026-02-01');
  });

  it('permits a reopened historical period, blocks locked periods and preserves immutable facts', async () => {
    await query(
      `INSERT INTO pay_periods
         (organization_id, week_start, week_end, status, current_version,
          reopened_at, reopened_by, reopen_reason)
       VALUES ($1, '2026-01-04', '2026-01-10', 'reopened', 1, now(), $2,
               'Corrección histórica de integración')`,
      [organizationId, adminId]
    );
    const reopenedChange = await post(
      `/api/employees/${employeeId}/rates/change`,
      adminToken,
      {
        hourly_rate: '19.75',
        effective_from: '2026-01-08',
        reason: 'Semana reabierta por administración',
      }
    );
    expect(reopenedChange.response.status).toBe(201);

    const period = await queryOne<{ id: string }>(
      `INSERT INTO pay_periods
         (organization_id, week_start, week_end, status, current_version,
          finalized_at, finalized_by)
       VALUES ($1, '2026-03-01', '2026-03-07', 'final', 1, now(), $2)
       RETURNING id`,
      [organizationId, adminId]
    );
    const blocked = await post(`/api/employees/${employeeId}/rates/change`, adminToken, {
      hourly_rate: '24.00',
      effective_from: '2026-03-07',
      reason: 'No debe reescribir cierre',
    });
    expect(blocked.response.status).toBe(409);
    expect(blocked.body).toMatchObject({
      code: 'RATE_PERIOD_LOCKED',
      details: { status: 'final', week_start: '2026-03-01', week_end: '2026-03-07' },
    });

    await query(
      `INSERT INTO pay_periods
         (organization_id, week_start, week_end, status)
       VALUES ($1, '2026-04-05', '2026-04-11', 'ready_for_review')`,
      [organizationId]
    );
    const reviewing = await post(`/api/employees/${employeeId}/rates/change`, adminToken, {
      hourly_rate: '24.00',
      effective_from: '2026-04-07',
      reason: 'No debe cambiar durante revisión',
    });
    expect(reviewing.response.status).toBe(409);
    expect(reviewing.body).toMatchObject({
      code: 'RATE_PERIOD_LOCKED',
      details: { status: 'ready_for_review' },
    });

    const spanningEmployee = await queryOne<{ id: string }>(
      `INSERT INTO employees (organization_id, full_name, pin_hash, hired_at)
       VALUES ($1, 'Spanning Rate Worker', 'unused', '2026-05-01') RETURNING id`,
      [organizationId]
    );
    await query(
      `INSERT INTO employee_rates
         (organization_id, employee_id, hourly_rate, effective_from, created_by)
       VALUES ($1, $2, 20, '2026-05-01', $3)`,
      [organizationId, spanningEmployee!.id, adminId]
    );
    await query(
      `INSERT INTO pay_periods
         (organization_id, week_start, week_end, status, current_version,
          reopened_at, reopened_by, reopen_reason)
       VALUES ($1, '2026-05-03', '2026-05-09', 'reopened', 1, now(), $2,
               'Corrección de tasa')`,
      [organizationId, adminId]
    );
    await query(
      `INSERT INTO pay_periods
         (organization_id, week_start, week_end, status, current_version,
          finalized_at, finalized_by)
       VALUES ($1, '2026-05-10', '2026-05-16', 'final', 1, now(), $2)`,
      [organizationId, adminId]
    );
    const spansLockedWeek = await post(
      `/api/employees/${spanningEmployee!.id}/rates/change`,
      adminToken,
      {
        hourly_rate: '21.00',
        effective_from: '2026-05-05',
        reason: 'No debe retasar la semana posterior',
      }
    );
    expect(spansLockedWeek.response.status).toBe(409);
    expect(spansLockedWeek.body).toMatchObject({
      code: 'RATE_PERIOD_LOCKED',
      details: {
        status: 'final',
        week_start: '2026-05-10',
        proposed_end_exclusive: null,
      },
    });

    const reportVersion = await queryOne<{ id: string }>(
      `INSERT INTO report_versions
         (organization_id, pay_period_id, version, snapshot, snapshot_hash,
          finalized_by, snapshot_schema_version, snapshot_contract, hash_algorithm)
       VALUES (
         $1, $2, 1, '{"schema_version":2,"contract":"clockai-accountant-v1"}',
         repeat('a', 64), $3, 2, 'clockai-accountant-v1', 'sha256'
       ) RETURNING id`,
      [organizationId, period!.id, adminId]
    );
    const cost = await queryOne<{ id: string }>(
      `INSERT INTO report_cost_snapshots
         (organization_id, report_version_id, snapshot, snapshot_hash)
       VALUES ($1, $2, '{"total_cost":"100.0000"}', repeat('b', 64))
       RETURNING id`,
      [organizationId, reportVersion!.id]
    );
    await expect(
      query(`UPDATE report_cost_snapshots SET snapshot = '{}' WHERE id = $1`, [cost!.id])
    ).rejects.toThrow(/immutable/);
    await expect(query(`DELETE FROM report_cost_snapshots WHERE id = $1`, [cost!.id])).rejects.toThrow(
      /immutable/
    );
    const secondReportVersion = await queryOne<{ id: string }>(
      `INSERT INTO report_versions
         (organization_id, pay_period_id, version, snapshot, snapshot_hash,
          finalized_by, snapshot_schema_version, snapshot_contract, hash_algorithm)
       VALUES (
         $1, $2, 2, '{"schema_version":2,"contract":"clockai-accountant-v1"}',
         repeat('d', 64), $3, 2, 'clockai-accountant-v1', 'sha256'
       ) RETURNING id`,
      [organizationId, period!.id, adminId]
    );
    await expect(
      query(
        `INSERT INTO report_cost_snapshots
           (organization_id, report_version_id, snapshot, snapshot_hash)
         VALUES ($1, $2, '{}', repeat('c', 64))`,
        [otherOrganizationId, secondReportVersion!.id]
      )
    ).rejects.toMatchObject({ code: '23503' });

    const audit = await queryOne<{ id: string }>(
      `SELECT id FROM audit_events
       WHERE organization_id = $1 AND action = 'employee.rate_changed'
       LIMIT 1`,
      [organizationId]
    );
    await expect(
      query(`UPDATE audit_events SET reason = 'tampered' WHERE id = $1`, [audit!.id])
    ).rejects.toThrow(/append-only/);
    await expect(query(`DELETE FROM audit_events WHERE id = $1`, [audit!.id])).rejects.toThrow(
      /append-only/
    );

    const tenantRateEmployee = await queryOne<{ id: string }>(
      `INSERT INTO employees (organization_id, full_name, pin_hash)
       VALUES ($1, 'Tenant-bound Rate Worker', 'unused') RETURNING id`,
      [organizationId]
    );
    await expect(
      query(
        `INSERT INTO employee_rates
           (organization_id, employee_id, hourly_rate, effective_from, created_by)
         VALUES ($1, $2, 15, '2026-01-01', $3)`,
        [organizationId, tenantRateEmployee!.id, otherAdminId]
      )
    ).rejects.toMatchObject({ code: '23503' });
  });
});

interface RateRow {
  hourly_rate: string;
  effective_from: string;
  effective_to: string | null;
}
