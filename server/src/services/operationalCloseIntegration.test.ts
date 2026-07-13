import crypto from 'node:crypto';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { pool, query, queryOne } from '../db.js';
import { signAccessToken, type AuthUser } from '../middleware/auth.js';

const run = process.env.RUN_DB_INTEGRATION === '1';

let server: Server;
let baseUrl = '';
let organizationId = '';
let plantId = '';
let employeeId = '';
let adminId = '';
let adminToken = '';
let accountantToken = '';

function token(user: AuthUser): string {
  return signAccessToken(user);
}

async function finalize(
  weekStart: string,
  bearer: string,
  body: Record<string, unknown>,
): Promise<{ response: Response; json: Record<string, any> }> {
  const response = await fetch(`${baseUrl}/api/reports/week/${weekStart}/finalize`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${bearer}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return {
    response,
    json: (await response.json().catch(() => ({}))) as Record<string, any>,
  };
}

async function readyForReview(
  weekStart: string,
  bearer: string,
  body: Record<string, unknown>,
): Promise<{ response: Response; json: Record<string, any> }> {
  const response = await fetch(`${baseUrl}/api/reports/week/${weekStart}/ready-for-review`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${bearer}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return {
    response,
    json: (await response.json().catch(() => ({}))) as Record<string, any>,
  };
}

async function insertPunch(type: 'shift_in' | 'shift_out', timestamp: string): Promise<void> {
  await query(
    `INSERT INTO punches
       (organization_id, employee_id, plant_id, punch_type, punched_at,
        captured_at, source, created_by, identity_status, evidence_status)
     VALUES ($1, $2, $3, $4, $5, $5, 'manual', $6, 'not_required', 'captured')`,
    [organizationId, employeeId, plantId, type, timestamp, adminId],
  );
}

describe.skipIf(!run)('Phase 6 finalization gate + PostgreSQL integration', () => {
  beforeAll(async () => {
    const suffix = crypto.randomUUID();
    const organization = await queryOne<{ id: string }>(
      `INSERT INTO organizations (name, slug, timezone)
       VALUES ('F6 Close Integration', $1, 'America/Los_Angeles') RETURNING id`,
      [`f6-close-${suffix}`],
    );
    organizationId = organization!.id;
    const plant = await queryOne<{ id: string }>(
      `INSERT INTO plants (organization_id, code, name)
       VALUES ($1, 'P1', 'Plant 1') RETURNING id`,
      [organizationId],
    );
    plantId = plant!.id;
    const employee = await queryOne<{ id: string }>(
      `INSERT INTO employees (organization_id, full_name, pin_hash)
       VALUES ($1, 'Close Worker', 'unused') RETURNING id`,
      [organizationId],
    );
    employeeId = employee!.id;
    const admin = await queryOne<{ id: string }>(
      `INSERT INTO users (organization_id, email, password_hash, role, name)
       VALUES ($1, $2, 'unused', 'admin', 'Close Admin') RETURNING id`,
      [organizationId, `close-admin-${suffix}@test.invalid`],
    );
    const accountant = await queryOne<{ id: string }>(
      `INSERT INTO users (organization_id, email, password_hash, role, name)
       VALUES ($1, $2, 'unused', 'accountant', 'Close Accountant') RETURNING id`,
      [organizationId, `close-accountant-${suffix}@test.invalid`],
    );
    adminId = admin!.id;
    adminToken = token({
      id: adminId,
      role: 'admin',
      name: 'Close Admin',
      email: `close-admin-${suffix}@test.invalid`,
      organizationId,
    });
    accountantToken = token({
      id: accountant!.id,
      role: 'accountant',
      name: 'Close Accountant',
      email: `close-accountant-${suffix}@test.invalid`,
      organizationId,
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

  it('re-derives blockers at review and close, requiring explicit overrides twice', async () => {
    await insertPunch('shift_in', '2026-07-06T12:00:00.000Z');

    const blockedReview = await readyForReview('2026-07-05', adminToken, {});
    expect(blockedReview.response.status).toBe(409);
    expect(blockedReview.json).toMatchObject({
      code: 'review_operational_blockers',
      details: { blockers: [{ code: 'missing_shift_out', work_date: '2026-07-06' }] },
    });

    const missingReviewReason = await readyForReview('2026-07-05', adminToken, {
      override_operational_blockers: true,
    });
    expect(missingReviewReason.response.status).toBe(400);

    const accountantReview = await readyForReview('2026-07-05', accountantToken, {
      override_operational_blockers: true,
      reason: 'Accountant cannot authorize this',
    });
    expect(accountantReview.response.status).toBe(403);

    const review = await readyForReview('2026-07-05', adminToken, {
      override_operational_blockers: true,
      reason: 'Horas verificadas para iniciar la revisión',
    });
    expect(review.response.status).toBe(200);

    const blocked = await finalize('2026-07-05', adminToken, {});
    expect(blocked.response.status).toBe(409);
    expect(blocked.json).toMatchObject({
      code: 'operational_exception_blockers',
      details: { blockers: [{ code: 'missing_shift_out', work_date: '2026-07-06' }] },
    });

    const missingReason = await finalize('2026-07-05', adminToken, {
      override_operational_blockers: true,
    });
    expect(missingReason.response.status).toBe(400);

    const accountant = await finalize('2026-07-05', accountantToken, {
      override_operational_blockers: true,
      reason: 'Accountant cannot authorize this',
    });
    expect(accountant.response.status).toBe(403);

    const overridden = await finalize('2026-07-05', adminToken, {
      override_operational_blockers: true,
      reason: 'Horas verificadas contra evidencia externa',
    });
    expect(overridden.response.status).toBe(201);
    expect(overridden.json).toMatchObject({ ok: true, week_start: '2026-07-05', version: 1 });

    const audit = await queryOne<{ reason: string; metadata: Record<string, any> }>(
      `SELECT reason, metadata FROM audit_events
       WHERE organization_id = $1 AND action = 'pay_period.operational_blockers_overridden'
       ORDER BY created_at DESC LIMIT 1`,
      [organizationId],
    );
    expect(audit?.reason).toBe('Horas verificadas contra evidencia externa');
    expect(audit?.metadata.blockers).toHaveLength(1);
  });

  it('keeps a California meal screening warning non-blocking and creates no premium', async () => {
    await insertPunch('shift_in', '2026-06-29T12:00:00.000Z');
    await insertPunch('shift_out', '2026-06-29T20:00:00.000Z');

    const review = await readyForReview('2026-06-28', adminToken, {});
    expect(review.response.status).toBe(200);
    const closed = await finalize('2026-06-28', adminToken, {});
    expect(closed.response.status).toBe(201);
    const version = await queryOne<{ snapshot: Record<string, any> }>(
      `SELECT rv.snapshot FROM report_versions rv
       JOIN pay_periods p ON p.id = rv.pay_period_id
       WHERE rv.organization_id = $1 AND p.week_start = '2026-06-28'::date`,
      [organizationId],
    );
    expect(version?.snapshot).not.toHaveProperty('meal_premium');
  });

  it('blocks ready-for-review on unhealthy devices and audits an explicit admin override', async () => {
    await insertPunch('shift_in', '2026-06-15T12:00:00.000Z');
    await insertPunch('shift_out', '2026-06-15T20:00:00.000Z');
    await query(
      `INSERT INTO devices
       (organization_id, plant_id, name, token_hash, enrolled_at,
          last_heartbeat_at, storage_status, camera_status)
       VALUES ($1, $2, 'Review Health Kiosk', $3, now(),
               NULL, 'unavailable', 'ready')`,
      [organizationId, plantId, crypto.createHash('sha256').update(crypto.randomUUID()).digest('hex')],
    );

    const blocked = await readyForReview('2026-06-14', adminToken, {});
    expect(blocked.response.status).toBe(409);
    expect(blocked.json).toMatchObject({
      code: 'device_health_blockers',
      details: {
        devices: [{
          name: 'Review Health Kiosk',
          reasons: expect.arrayContaining([
            'Almacenamiento local no disponible',
            'Sin heartbeat registrado',
          ]),
        }],
      },
    });

    const missingReason = await readyForReview('2026-06-14', adminToken, {
      override_device_health: true,
    });
    expect(missingReason.response.status).toBe(400);

    const accountant = await readyForReview('2026-06-14', accountantToken, {
      override_device_health: true,
      reason: 'Accountant must not override device health',
    });
    expect(accountant.response.status).toBe(403);

    const overridden = await readyForReview('2026-06-14', adminToken, {
      override_device_health: true,
      reason: 'Cola revisada y horas verificadas contra evidencia local',
    });
    expect(overridden.response.status).toBe(200);
    expect(overridden.json.status).toBe('ready_for_review');

    const audit = await queryOne<{ reason: string; metadata: Record<string, any> }>(
      `SELECT reason, metadata FROM audit_events
       WHERE organization_id = $1
         AND action = 'pay_period.review_device_health_overridden'
       ORDER BY created_at DESC LIMIT 1`,
      [organizationId],
    );
    expect(audit?.reason).toBe('Cola revisada y horas verificadas contra evidencia local');
    expect(audit?.metadata).toMatchObject({
      week_start: '2026-06-14',
      devices: [{ name: 'Review Health Kiosk' }],
    });
  });
});
