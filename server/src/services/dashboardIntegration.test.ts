import crypto from 'node:crypto';
import type { Server } from 'node:http';
import { DateTime } from 'luxon';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { pool, query, queryOne } from '../db.js';
import { signAccessToken, type AuthUser } from '../middleware/auth.js';
import { snapshotHash } from './payPeriodService.js';
import { weekBoundsForDate } from './payPeriodService.js';
import { calculateWeekCost, parseHourlyRateUnits } from './dashboardCosts.js';

const run = process.env.RUN_DB_INTEGRATION === '1';
const TIMEZONE = 'America/Los_Angeles';

let server: Server;
let baseUrl = '';
let organizationId = '';
let otherOrganizationId = '';
let adminId = '';
let employeeId = '';
let missingRateEmployeeId = '';
let openEmployeeId = '';
let staleEmployeeId = '';
let firstPlantId = '';
let secondPlantId = '';
let thirdPlantId = '';
let attentionDeviceId = '';
let adminToken = '';
let foremanToken = '';
let accountantToken = '';
let otherAdminToken = '';
let currentWeekStart = '';
let currentWeekEnd = '';
let previousWeekStart = '';
let previousWeekEnd = '';
let legacyWeekStart = '';
let openStartedAt = '';

function token(user: AuthUser): string {
  return signAccessToken(user);
}

async function request(
  path: string,
  bearer: string,
  init: RequestInit = {},
): Promise<{ response: Response; body: Record<string, any> }> {
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
    body: (await response.clone().json().catch(() => ({}))) as Record<string, any>,
  };
}

async function post(
  path: string,
  bearer: string,
  body: Record<string, unknown> = {},
): ReturnType<typeof request> {
  return request(path, bearer, { method: 'POST', body: JSON.stringify(body) });
}

function localTimestamp(workDate: string, hour: number): string {
  return DateTime.fromISO(workDate, { zone: TIMEZONE })
    .startOf('day')
    .plus({ hours: hour })
    .toUTC()
    .toISO()!;
}

function plusDays(date: string, days: number): string {
  return DateTime.fromISO(date, { zone: TIMEZONE }).plus({ days }).toISODate()!;
}

async function insertPunch(input: {
  employeeId: string;
  plantId: string;
  type: 'shift_in' | 'shift_out' | 'meal_out' | 'meal_in';
  at: string;
  identityStatus?: 'not_required' | 'identity_review';
}): Promise<void> {
  await query(
    `INSERT INTO punches
       (organization_id, employee_id, plant_id, punch_type, punched_at,
        captured_at, source, created_by, identity_status, evidence_status)
     VALUES ($1, $2, $3, $4, $5, $5, 'manual', $6, $7, 'captured')`,
    [
      organizationId,
      input.employeeId,
      input.plantId,
      input.type,
      input.at,
      adminId,
      input.identityStatus ?? 'not_required',
    ],
  );
}

async function insertException(input: {
  key: string;
  severity: 'blocker' | 'warning';
  plants: string[];
}): Promise<void> {
  const digest = (value: string): string =>
    crypto.createHash('sha256').update(value).digest('hex');
  const row = await queryOne<{ id: string }>(
    `INSERT INTO operational_exceptions
       (organization_id, dedupe_key, code, severity, source_type, source_key,
        source_fingerprint, employee_id, work_date, occurred_at, title, details)
     VALUES ($1, $2, 'out_of_sequence', $3, 'punch_sequence', $4, $5,
             $6, $7::date, now(), 'Dashboard fixture', '{"private_reason":"must_not_leak"}')
     RETURNING id`,
    [
      organizationId,
      digest(`dedupe:${input.key}`),
      input.severity,
      input.key,
      digest(`fingerprint:${input.key}`),
      employeeId,
      plusDays(currentWeekStart, 1),
    ],
  );
  for (const plantId of input.plants) {
    await query(
      `INSERT INTO operational_exception_plants
         (exception_id, organization_id, plant_id)
       VALUES ($1, $2, $3)`,
      [row!.id, organizationId, plantId],
    );
  }
}

describe.skipIf(!run)('Phase 8 dashboard + direct-cost PostgreSQL/API integration', () => {
  beforeAll(async () => {
    const suffix = crypto.randomUUID();
    const today = DateTime.now().setZone(TIMEZONE).toISODate()!;
    const current = weekBoundsForDate(today, TIMEZONE);
    const previous = weekBoundsForDate(plusDays(current.weekStart, -7), TIMEZONE);
    currentWeekStart = current.weekStart;
    currentWeekEnd = current.weekEnd;
    previousWeekStart = previous.weekStart;
    previousWeekEnd = previous.weekEnd;
    legacyWeekStart = plusDays(currentWeekStart, -14);

    const organization = await queryOne<{ id: string }>(
      `INSERT INTO organizations (name, slug, timezone)
       VALUES ('F8 Dashboard', $1, $2) RETURNING id`,
      [`f8-dashboard-${suffix}`, TIMEZONE],
    );
    const otherOrganization = await queryOne<{ id: string }>(
      `INSERT INTO organizations (name, slug, timezone)
       VALUES ('F8 Other Tenant', $1, $2) RETURNING id`,
      [`f8-dashboard-other-${suffix}`, TIMEZONE],
    );
    organizationId = organization!.id;
    otherOrganizationId = otherOrganization!.id;

    const plants = await query<{ id: string; code: string }>(
      `INSERT INTO plants (organization_id, code, name)
       VALUES ($1, 'P1', 'North Packing'),
              ($1, 'P2', 'South Packing'),
              ($1, 'P3', 'West Packing')
       RETURNING id, code`,
      [organizationId],
    );
    firstPlantId = plants.find((plant) => plant.code === 'P1')!.id;
    secondPlantId = plants.find((plant) => plant.code === 'P2')!.id;
    thirdPlantId = plants.find((plant) => plant.code === 'P3')!.id;
    await query(
      `INSERT INTO plants (organization_id, code, name)
       VALUES ($1, 'O1', 'Other Secret Plant')`,
      [otherOrganizationId],
    );

    const users = await query<{ id: string; role: string }>(
      `INSERT INTO users (organization_id, email, password_hash, role, name)
       VALUES ($1, $2, 'unused', 'admin', 'Dashboard Admin'),
              ($1, $3, 'unused', 'foreman', 'Scoped Foreman'),
              ($1, $4, 'unused', 'accountant', 'Hours Accountant')
       RETURNING id, role`,
      [
        organizationId,
        `f8-admin-${suffix}@test.invalid`,
        `f8-foreman-${suffix}@test.invalid`,
        `f8-accountant-${suffix}@test.invalid`,
      ],
    );
    const admin = users.find((user) => user.role === 'admin')!;
    const foreman = users.find((user) => user.role === 'foreman')!;
    const accountant = users.find((user) => user.role === 'accountant')!;
    const otherAdmin = await queryOne<{ id: string }>(
      `INSERT INTO users (organization_id, email, password_hash, role, name)
       VALUES ($1, $2, 'unused', 'admin', 'Other Admin') RETURNING id`,
      [otherOrganizationId, `f8-other-admin-${suffix}@test.invalid`],
    );
    adminId = admin.id;
    await query(
      `INSERT INTO user_plant_access (organization_id, user_id, plant_id)
       VALUES ($1, $2, $3)`,
      [organizationId, foreman.id, firstPlantId],
    );
    adminToken = token({
      id: admin.id, organizationId, role: 'admin', name: 'Dashboard Admin',
      email: `f8-admin-${suffix}@test.invalid`,
    });
    foremanToken = token({
      id: foreman.id, organizationId, role: 'foreman', name: 'Scoped Foreman',
      email: `f8-foreman-${suffix}@test.invalid`,
    });
    accountantToken = token({
      id: accountant.id, organizationId, role: 'accountant', name: 'Hours Accountant',
      email: `f8-accountant-${suffix}@test.invalid`,
    });
    otherAdminToken = token({
      id: otherAdmin!.id, organizationId: otherOrganizationId, role: 'admin', name: 'Other Admin',
      email: `f8-other-admin-${suffix}@test.invalid`,
    });

    const employees = await query<{ id: string; full_name: string }>(
      `INSERT INTO employees
         (organization_id, full_name, social_security, phone, pin_hash)
       VALUES ($1, 'Costed Worker', '111-22-3333', '209-555-0101', 'unused'),
              ($1, 'Missing Rate Worker', '222-33-4444', '209-555-0102', 'unused'),
              ($1, 'Open Shift Worker', '333-44-5555', '209-555-0103', 'unused'),
              ($1, 'Ancient Open Worker', '444-55-6666', '209-555-0104', 'unused')
       RETURNING id, full_name`,
      [organizationId],
    );
    employeeId = employees.find((employee) => employee.full_name === 'Costed Worker')!.id;
    missingRateEmployeeId = employees.find(
      (employee) => employee.full_name === 'Missing Rate Worker',
    )!.id;
    openEmployeeId = employees.find((employee) => employee.full_name === 'Open Shift Worker')!.id;
    staleEmployeeId = employees.find((employee) => employee.full_name === 'Ancient Open Worker')!.id;
    await query(
      `INSERT INTO employees (organization_id, full_name, pin_hash)
       VALUES ($1, 'OTHER TENANT SECRET WORKER', 'unused')`,
      [otherOrganizationId],
    );

    await query(
      `INSERT INTO employee_rates
         (organization_id, employee_id, hourly_rate, effective_from, created_by, reason)
       VALUES ($1, $2, '20.0000', '2020-01-01', $4, 'Initial dashboard rate'),
              ($1, $3, '10.0000', '2020-01-01', $4, 'Initial dashboard rate')`,
      [organizationId, employeeId, openEmployeeId, adminId],
    );

    const currentWorkDate = currentWeekStart;
    await insertPunch({
      employeeId, plantId: firstPlantId, type: 'shift_in', at: localTimestamp(currentWorkDate, 5),
    });
    await insertPunch({
      employeeId, plantId: firstPlantId, type: 'shift_out', at: localTimestamp(currentWorkDate, 13),
    });
    await query(
      `INSERT INTO manual_time_entries
         (organization_id, employee_id, plant_id, work_date, duration_seconds,
          reason, created_by)
       VALUES ($1, $2, $3, $4::date, 3600, 'Foreman approved credited hour', $5)`,
      [organizationId, employeeId, secondPlantId, currentWorkDate, adminId],
    );
    await insertPunch({
      employeeId: missingRateEmployeeId,
      plantId: thirdPlantId,
      type: 'shift_in',
      at: localTimestamp(currentWorkDate, 14),
    });
    await insertPunch({
      employeeId: missingRateEmployeeId,
      plantId: thirdPlantId,
      type: 'shift_out',
      at: localTimestamp(currentWorkDate, 16),
    });
    openStartedAt = localTimestamp(currentWorkDate, 0);
    await insertPunch({
      employeeId: openEmployeeId,
      plantId: secondPlantId,
      type: 'shift_in',
      at: openStartedAt,
      identityStatus: 'identity_review',
    });
    await insertPunch({
      employeeId: staleEmployeeId,
      plantId: firstPlantId,
      type: 'shift_in',
      at: '2020-01-01T12:00:00.000Z',
    });
    await query(`UPDATE employees SET active = false WHERE id = $1`, [staleEmployeeId]);

    const previousWorkDate = plusDays(previousWeekStart, 1);
    await insertPunch({
      employeeId, plantId: firstPlantId, type: 'shift_in', at: localTimestamp(previousWorkDate, 5),
    });
    await insertPunch({
      employeeId, plantId: firstPlantId, type: 'shift_out', at: localTimestamp(previousWorkDate, 13),
    });

    const deviceRows = await query<{ id: string; name: string }>(
      `INSERT INTO devices
         (organization_id, plant_id, name, token_hash, active, enrolled_at,
          last_heartbeat_at, last_sync_at, pending_event_count,
          rejected_event_count, camera_status, storage_status)
       VALUES
         ($1, $2, 'Healthy P1', $5, true, now(), now(), now(), 0, 0, 'ready', 'ready'),
         ($1, $2, 'Revoked P1', $6, false, NULL, NULL, NULL, 99, 8, 'unavailable', 'unavailable'),
         ($1, $3, 'Attention P2', $7, true, now(), now(), now(), 2, 0, 'ready', 'ready'),
         ($1, $4, 'Healthy P3', $8, true, now(), now(), now(), 0, 0, 'ready', 'ready')
       RETURNING id, name`,
      [
        organizationId,
        firstPlantId,
        secondPlantId,
        thirdPlantId,
        ...Array.from({ length: 4 }, () =>
          crypto.createHash('sha256').update(crypto.randomUUID()).digest('hex')),
      ],
    );
    attentionDeviceId = deviceRows.find((device) => device.name === 'Attention P2')!.id;

    await insertException({ key: 'p1-only', severity: 'warning', plants: [firstPlantId] });
    await insertException({
      key: 'p1-p2-private', severity: 'blocker', plants: [firstPlantId, secondPlantId],
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

  it('enforces role, tenant and exact foreman plant scope without exposing payroll or reasons', async () => {
    const accountant = await request('/api/dashboard/operations', accountantToken);
    expect(accountant.response.status).toBe(403);

    const foreman = await request('/api/dashboard/operations', foremanToken);
    expect(foreman.response.status).toBe(200);
    expect(foreman.response.headers.get('cache-control')).toContain('no-store');
    expect(foreman.body.plants).toHaveLength(1);
    expect(foreman.body.plants[0]).toMatchObject({
      code: 'P1',
      workers: {
        inside_count: 0,
        on_meal_count: 0,
        stale_open_count: 1,
        open_sequences_count: 1,
      },
      exceptions_open: { blockers: 0, warnings: 1, total: 1 },
    });
    expect(foreman.body.plants[0].workers.stale_open[0]).toMatchObject({
      full_name: 'Ancient Open Worker', stale: true, employee_active: false,
    });
    expect(foreman.body.totals).toMatchObject({
      inside: 0, stale_open: 1, open_sequences: 1,
      exceptions_open: 1, devices_attention: 0,
    });
    expect(foreman.body.plants[0].devices).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Healthy P1', sync_status: 'healthy', health_flags: [] }),
      expect.objectContaining({ name: 'Revoked P1', active: false, enrolled: false, sync_status: 'offline' }),
    ]));
    const foremanJson = JSON.stringify(foreman.body);
    expect(foremanJson).not.toMatch(
      /South Packing|West Packing|Open Shift Worker|private_reason|hourly_rate|direct_cost|social_security|photo_key|evidence_key|reason/i,
    );

    const admin = await request('/api/dashboard/operations', adminToken);
    expect(admin.response.status).toBe(200);
    expect(admin.body.plants).toHaveLength(3);
    expect(admin.body.totals).toMatchObject({
      open_sequences: 2,
      identity_reviews_open: 1,
      exceptions_open: 2,
      devices_attention: 1,
    });
    expect(admin.body.totals.inside + admin.body.totals.on_meal + admin.body.totals.stale_open).toBe(2);
    expect(admin.body.totals.stale_open).toBeGreaterThanOrEqual(1);
    expect(admin.body.plants.find((plant: any) => plant.code === 'P1').exceptions_open).toEqual({
      blockers: 1, warnings: 1, total: 2,
    });
    expect(admin.body.plants.find((plant: any) => plant.code === 'P2')).toMatchObject({
      identity_reviews_open: 1,
      exceptions_open: { blockers: 1, warnings: 0, total: 1 },
    });
    expect(admin.body.plants.find((plant: any) => plant.code === 'P2').devices[0]).toMatchObject({
      name: 'Attention P2', sync_status: 'attention', health_flags: ['queue_pending'],
    });
    expect(JSON.stringify(admin.body)).not.toMatch(
      /private_reason|hourly_rate|direct_cost|social_security|photo_key|evidence_key/i,
    );

    const other = await request('/api/dashboard/operations', otherAdminToken);
    expect(other.response.status).toBe(200);
    expect(JSON.stringify(other.body)).not.toMatch(
      /Costed Worker|Missing Rate Worker|Open Shift Worker|North Packing|South Packing|West Packing/,
    );
  });

  it('returns exact current cost, explicit missing-rate coverage, manual facts and a nonpayable capped projection', async () => {
    for (const bearer of [foremanToken, accountantToken]) {
      const forbidden = await request('/api/dashboard/admin/current-week', bearer);
      expect(forbidden.response.status).toBe(403);
    }
    const current = await request('/api/dashboard/admin/current-week', adminToken);
    expect(current.response.status).toBe(200);
    expect(current.response.headers.get('cache-control')).toContain('no-store');
    const rawOpenSeconds = Math.max(
      0,
      Math.floor(
        (new Date(current.body.generated_at).getTime() - new Date(openStartedAt).getTime()) / 1_000,
      ),
    );
    const expectedOpenSeconds = Math.min(16 * 3_600, rawOpenSeconds);
    const openCost = calculateWeekCost({
      weekStart: currentWeekStart,
      employees: [{
        employee_id: openEmployeeId,
        employee_number: 1,
        full_name: 'Open Shift Worker',
        chunks: expectedOpenSeconds > 0 ? [{
          id: 'expected-open',
          workDate: currentWeekStart,
          durationSeconds: expectedOpenSeconds,
          plantId: secondPlantId,
          source: 'clock',
          order: 0,
        }] : [],
        rates: [{ hourly_rate: '10.0000', effective_from: '2020-01-01', effective_to: null }],
      }],
      plants: [{ id: secondPlantId, code: 'P2', name: 'South Packing' }],
    });
    const projectedCostUnits = parseHourlyRateUnits('190.0000')
      + parseHourlyRateUnits(openCost.metric.direct_cost_costed);
    const projectedCost = `${projectedCostUnits / 10_000n}.${(projectedCostUnits % 10_000n)
      .toString().padStart(4, '0')}`;
    expect(current.body).toMatchObject({
      timezone: TIMEZONE,
      week_start: currentWeekStart,
      week_end: currentWeekEnd,
      actual: {
        seconds: {
          regular: 36_000,
          overtime_1_5: 3_600,
          double_time: 0,
          clock: 36_000,
          manual: 3_600,
          total: 39_600,
          costed: 32_400,
          uncosted: 7_200,
        },
        direct_cost_by_bucket_costed: {
          regular: '160.0000', overtime_1_5: '30.0000', double_time: '0.0000',
        },
        direct_cost_costed: '190.0000',
        direct_cost_complete: null,
        coverage_ratio: '0.8182',
      },
      projection: {
        method: 'actual_plus_open_elapsed_capped_16h',
        synthetic: true,
        payable: false,
        synthetic_open_sequences: expectedOpenSeconds > 0 ? 1 : 0,
        capped_open_sequences: rawOpenSeconds >= 16 * 3_600 ? 1 : 0,
        metric: {
          seconds: {
            total: 39_600 + expectedOpenSeconds,
            costed: 32_400 + expectedOpenSeconds,
            uncosted: 7_200,
          },
          direct_cost_costed: projectedCost,
          direct_cost_complete: null,
        },
      },
      manual_activity: {
        active_entries: 1,
        active_seconds: 3_600,
        created_count: 1,
        voided_count: 0,
        clock_seconds: 36_000,
        manual_seconds: 3_600,
        manual_to_clock_ratio: '0.1000',
      },
    });
    expect(current.body.disclaimer).toMatch(/excluye cargas patronales/i);
    expect(current.body.missing_rates).toEqual([
      expect.objectContaining({
        employee_id: missingRateEmployeeId,
        full_name: 'Missing Rate Worker',
        work_dates: [currentWeekStart],
        uncosted_seconds: 7_200,
      }),
    ]);
    expect(current.body.recent_manual_changes[0]).toMatchObject({
      full_name: 'Costed Worker',
      plant_code: 'P2',
      work_date: currentWeekStart,
      duration_seconds: 3_600,
      actor_name: 'Dashboard Admin',
      reason: 'Foreman approved credited hour',
      change_type: 'created',
    });
    expect(current.body.recent_manual_changes[0]).not.toHaveProperty('employee_id');
    expect(current.body.recent_manual_changes[0]).not.toHaveProperty('id');
    expect(current.body.plants).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'P1', metric: expect.objectContaining({ direct_cost_costed: '160.0000' }) }),
      expect.objectContaining({ code: 'P2', metric: expect.objectContaining({ direct_cost_costed: '30.0000' }) }),
      expect.objectContaining({ code: 'P3', metric: expect.objectContaining({
        direct_cost_costed: '0.0000', direct_cost_complete: null,
      }) }),
    ]));
  });

  it('freezes an auditable cost snapshot and never live-recomputes final or legacy trend history', async () => {
    await query(
      `UPDATE devices
       SET pending_event_count = 0, last_heartbeat_at = now(), last_sync_at = now()
       WHERE id = $1`,
      [attentionDeviceId],
    );
    const ready = await post(`/api/reports/week/${previousWeekStart}/ready-for-review`, adminToken);
    expect(ready.response.status).toBe(200);
    const finalized = await post(`/api/reports/week/${previousWeekStart}/finalize`, adminToken);
    expect(finalized.response.status).toBe(201);

    const stored = await queryOne<{
      id: string;
      snapshot: Record<string, any>;
      snapshot_hash: string;
      schema_version: number;
      contract: string;
    }>(
      `SELECT cs.id, cs.snapshot, cs.snapshot_hash, cs.schema_version, cs.contract
       FROM report_cost_snapshots cs
       JOIN report_versions rv
         ON rv.id = cs.report_version_id AND rv.organization_id = cs.organization_id
       JOIN pay_periods p
         ON p.id = rv.pay_period_id AND p.organization_id = rv.organization_id
       WHERE cs.organization_id = $1 AND p.week_start = $2::date AND rv.version = 1`,
      [organizationId, previousWeekStart],
    );
    expect(stored).toMatchObject({
      schema_version: 1,
      contract: 'clockai-admin-direct-cost-v1',
    });
    expect(stored!.snapshot_hash).toBe(snapshotHash(stored!.snapshot));
    expect(stored!.snapshot).toMatchObject({
      schema_version: 1,
      contract: 'clockai-admin-direct-cost-v1',
      report_version: 1,
      week_start: previousWeekStart,
      week_end: previousWeekEnd,
      disclaimer: 'estimated_direct_labor_only_excludes_taxes_benefits_burden',
      week: {
        metric: {
          seconds: { regular: 28_800, total: 28_800, uncosted: 0 },
          direct_cost_costed: '160.0000',
          direct_cost_complete: '160.0000',
          coverage_ratio: '1.0000',
        },
      },
    });
    expect(stored!.snapshot.week.rate_facts).toEqual([
      expect.objectContaining({
        full_name: 'Costed Worker',
        work_date: plusDays(previousWeekStart, 1),
        plant_code: 'P1',
        source: 'clock',
        bucket: 'regular',
        hourly_rate: '20.0000',
        seconds: 28_800,
        direct_cost_costed: '160.0000',
      }),
    ]);
    expect(JSON.stringify(stored!.snapshot.week.rate_facts)).not.toContain(employeeId);
    await expect(query(
      `UPDATE report_cost_snapshots SET snapshot_hash = $2 WHERE id = $1`,
      [stored!.id, 'f'.repeat(64)],
    )).rejects.toThrow(/immutable/);

    // Simulate a privileged historical data repair outside the public API.
    // Final dashboard history must still read the version-bound snapshot.
    await query(
      `UPDATE employee_rates SET hourly_rate = '99.0000'
       WHERE organization_id = $1 AND employee_id = $2 AND effective_from = '2020-01-01'`,
      [organizationId, employeeId],
    );
    const previousComparison = await request('/api/dashboard/admin/current-week', adminToken);
    expect(previousComparison.response.status).toBe(200);
    expect(previousComparison.body.previous_week).toMatchObject({
      week_start: previousWeekStart,
      cost_status: 'frozen_complete',
      source: 'frozen_report_version',
      report_version: 1,
      metric: { direct_cost_complete: '160.0000' },
    });

    const legacyPeriod = await queryOne<{ id: string }>(
      `INSERT INTO pay_periods
         (organization_id, week_start, week_end, status, current_version,
          finalized_at, finalized_by)
       VALUES ($1, $2::date, ($2::date + 6), 'final', 1, now(), $3)
       RETURNING id`,
      [organizationId, legacyWeekStart, adminId],
    );
    await query(
      `INSERT INTO report_versions
         (organization_id, pay_period_id, version, snapshot, snapshot_hash,
          snapshot_schema_version, snapshot_contract, hash_algorithm,
          finalized_by, finalization_reason)
       VALUES ($1, $2, 1, $3, $4, 1, 'legacy-week-computation-v1', 'md5',
               $5, 'Migration-only reason')`,
      [
        organizationId,
        legacyPeriod!.id,
        JSON.stringify({
          employees: [{
            employee_number: 999,
            full_name: 'Legacy Frozen Worker',
            regular_minutes: 60,
            overtime_minutes: 0,
            double_time_minutes: 0,
            total_minutes: 60,
          }],
        }),
        '0'.repeat(32),
        adminId,
      ],
    );

    const forbiddenTrend = await request(
      `/api/dashboard/admin/trends?grain=week&from=${legacyWeekStart}&to=${currentWeekEnd}`,
      foremanToken,
    );
    expect(forbiddenTrend.response.status).toBe(403);
    const trends = await request(
      `/api/dashboard/admin/trends?grain=week&from=${legacyWeekStart}&to=${currentWeekEnd}&limit=10`,
      adminToken,
    );
    expect(trends.response.status).toBe(200);
    expect(trends.response.headers.get('cache-control')).toContain('no-store');
    const frozen = trends.body.items.find((item: any) => item.period_start === previousWeekStart);
    expect(frozen).toMatchObject({
      source: 'frozen_report_version',
      cost_status: 'frozen_complete',
      report_version: 1,
      metric: { direct_cost_complete: '160.0000' },
    });
    const legacy = trends.body.items.find((item: any) => item.period_start === legacyWeekStart);
    expect(legacy).toMatchObject({
      source: 'legacy_report_without_cost_snapshot',
      cost_status: 'unavailable_legacy',
      report_version: 1,
      metric: {
        seconds: { regular: 3_600, total: 3_600, costed: 0, uncosted: 3_600 },
        direct_cost_complete: null,
        coverage_ratio: '0.0000',
      },
    });

    const page = await request(
      `/api/dashboard/admin/trends?grain=week&from=${legacyWeekStart}&to=${currentWeekEnd}&limit=1`,
      adminToken,
    );
    expect(page.response.status).toBe(200);
    expect(page.body.items).toHaveLength(1);
    expect(page.body.next_cursor).toBeDefined();
    const secondPage = await request(
      `/api/dashboard/admin/trends?grain=week&from=${legacyWeekStart}&to=${currentWeekEnd}&limit=1&cursor=${page.body.next_cursor}`,
      adminToken,
    );
    expect(secondPage.response.status).toBe(200);
    expect(secondPage.body.items[0].period_start).not.toBe(page.body.items[0].period_start);
  });
});
