import crypto from 'node:crypto';
import type { Server } from 'node:http';
import express from 'express';
import type { PoolClient } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../db.js';
import { HttpError } from '../errors.js';
import { signAccessToken, type AuthUser } from '../middleware/auth.js';
import { operationalExceptionsRouter } from '../routes/operationalExceptions.js';
import {
  canAccessOperationalException,
  deriveFinalizationBlockers,
  deriveOperationalExceptionCandidates,
  reconcileOperationalExceptions,
  transitionOperationalException,
} from './operationalExceptions.js';

const run = process.env.RUN_DB_INTEGRATION === '1';
const TIMEZONE = 'America/Los_Angeles';
const WEEK_START = '2026-07-05';
const WEEK_END = '2026-07-11';
const WORK_DATE = '2026-07-06';

interface Fixture {
  organizationId: string;
  plantA: string;
  plantB: string;
  employeeId: string;
  deviceId: string;
  adminId: string;
  foremanAId: string;
  foremanBId: string;
  foremanBothId: string;
  accountantId: string;
}

let client: PoolClient;
let fixture: Fixture;

async function insertUser(
  organizationId: string,
  role: 'admin' | 'foreman' | 'accountant',
  suffix: string,
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, name, organization_id)
     VALUES ($1, 'unused', $2, $3, $4)
     RETURNING id`,
    [`f6-${suffix}-${crypto.randomUUID()}@test.invalid`, role, `F6 ${suffix}`, organizationId],
  );
  return result.rows[0]!.id;
}

async function createFixture(): Promise<Fixture> {
  const suffix = crypto.randomUUID();
  const organization = await client.query<{ id: string }>(
    `INSERT INTO organizations (name, slug, timezone)
     VALUES ('F6 Integration', $1, $2)
     RETURNING id`,
    [`f6-${suffix}`, TIMEZONE],
  );
  const organizationId = organization.rows[0]!.id;
  const plants = await client.query<{ id: string; code: string }>(
    `INSERT INTO plants (organization_id, code, name)
     VALUES ($1, 'A', 'Plant A'), ($1, 'B', 'Plant B')
     RETURNING id, code`,
    [organizationId],
  );
  const plantA = plants.rows.find((row) => row.code === 'A')!.id;
  const plantB = plants.rows.find((row) => row.code === 'B')!.id;
  const employee = await client.query<{ id: string }>(
    `INSERT INTO employees (organization_id, full_name, pin_hash)
     VALUES ($1, 'F6 Worker', 'unused')
     RETURNING id`,
    [organizationId],
  );
  const adminId = await insertUser(organizationId, 'admin', 'admin');
  const foremanAId = await insertUser(organizationId, 'foreman', 'foreman-a');
  const foremanBId = await insertUser(organizationId, 'foreman', 'foreman-b');
  const foremanBothId = await insertUser(organizationId, 'foreman', 'foreman-both');
  const accountantId = await insertUser(organizationId, 'accountant', 'accountant');
  await client.query(
    `INSERT INTO user_plant_access (organization_id, user_id, plant_id)
     VALUES ($1, $2, $3), ($1, $4, $5), ($1, $6, $3), ($1, $6, $5)`,
    [organizationId, foremanAId, plantA, foremanBId, plantB, foremanBothId],
  );
  const device = await client.query<{ id: string }>(
    `INSERT INTO devices
       (organization_id, plant_id, name, token_hash, enrolled_at,
        last_heartbeat_at, camera_status, storage_status)
     VALUES ($1, $2, 'F6 Kiosk', $3, now(), now(), 'ready', 'ready')
     RETURNING id`,
    [organizationId, plantA, crypto.createHash('sha256').update(suffix).digest('hex')],
  );
  return {
    organizationId,
    plantA,
    plantB,
    employeeId: employee.rows[0]!.id,
    deviceId: device.rows[0]!.id,
    adminId,
    foremanAId,
    foremanBId,
    foremanBothId,
    accountantId,
  };
}

async function insertManualPunch(
  punchType: 'shift_in' | 'shift_out' | 'meal_out' | 'meal_in',
  timestamp: string,
  plantId = fixture.plantA,
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO punches
       (organization_id, employee_id, plant_id, punch_type, punched_at,
        captured_at, source, created_by, identity_status, evidence_status)
     VALUES ($1, $2, $3, $4, $5, $5, 'manual', $6, 'not_required', 'captured')
     RETURNING id`,
    [
      fixture.organizationId,
      fixture.employeeId,
      plantId,
      punchType,
      timestamp,
      fixture.adminId,
    ],
  );
  return result.rows[0]!.id;
}

function deriveInput() {
  return {
    organizationId: fixture.organizationId,
    fromDate: WORK_DATE,
    toDate: WORK_DATE,
    timezone: TIMEZONE,
  };
}

describe.skipIf(!run)('Phase 6 operational exceptions + PostgreSQL integration', () => {
  beforeAll(async () => {
    client = await pool.connect();
  });

  afterAll(async () => {
    client.release();
    await pool.end();
  });

  beforeEach(async () => {
    await client.query('BEGIN');
    fixture = await createFixture();
  });

  afterEach(async () => {
    await client.query('ROLLBACK');
  });

  it('reconciles idempotently, preserves reviewed facts, reopens changed causes and resolves repairs', async () => {
    const shiftInId = await insertManualPunch('shift_in', '2026-07-06T12:00:00.000Z');
    const shiftOutId = await insertManualPunch('shift_out', '2026-07-06T20:00:00.000Z');
    const sourceCountBefore = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM punches WHERE organization_id = $1`,
      [fixture.organizationId],
    );

    const first = await reconcileOperationalExceptions(client, deriveInput());
    const repeated = await reconcileOperationalExceptions(client, deriveInput());

    expect(first).toMatchObject({ candidateCount: 1, opened: 1, reopened: 0, resolved: 0 });
    expect(repeated).toMatchObject({ candidateCount: 1, opened: 0, refreshed: 0, resolved: 0 });
    const projected = await client.query<{ id: string; code: string; status: string }>(
      `SELECT id, code, status FROM operational_exceptions WHERE organization_id = $1`,
      [fixture.organizationId],
    );
    expect(projected.rows).toHaveLength(1);
    expect(projected.rows[0]).toMatchObject({ code: 'first_meal_missing', status: 'open' });
    const exceptionId = projected.rows[0]!.id;

    await transitionOperationalException(client, {
      organizationId: fixture.organizationId,
      exceptionId,
      actorUserId: fixture.adminId,
      action: 'acknowledge',
      reason: 'Supervisor revisando evidencia',
    });
    await reconcileOperationalExceptions(client, deriveInput());
    expect(
      (
        await client.query<{ status: string }>(
          `SELECT status FROM operational_exceptions WHERE id = $1`,
          [exceptionId],
        )
      ).rows[0]?.status,
    ).toBe('acknowledged');

    await transitionOperationalException(client, {
      organizationId: fixture.organizationId,
      exceptionId,
      actorUserId: fixture.adminId,
      action: 'resolve',
      reason: 'Revisión manual terminada',
    });
    const reviewedAgain = await reconcileOperationalExceptions(client, deriveInput());
    expect(reviewedAgain.reopened).toBe(0);
    expect(
      (
        await client.query<{ status: string }>(
          `SELECT status FROM operational_exceptions WHERE id = $1`,
          [exceptionId],
        )
      ).rows[0]?.status,
    ).toBe('resolved');

    // New authoritative facts invalidate the prior human review and reopen it.
    await client.query(`UPDATE punches SET voided = true WHERE id = $1`, [shiftOutId]);
    const changedShiftOutId = await insertManualPunch('shift_out', '2026-07-06T21:00:00.000Z');
    const reopened = await reconcileOperationalExceptions(client, deriveInput());
    expect(reopened.reopened).toBe(1);

    // Repair the authoritative log; reconciliation never invents time.
    await client.query(`UPDATE punches SET voided = true WHERE id = ANY($1::uuid[])`, [
      [shiftInId, changedShiftOutId],
    ]);
    await insertManualPunch('shift_in', '2026-07-06T12:00:00.000Z');
    await insertManualPunch('meal_out', '2026-07-06T16:00:00.000Z');
    await insertManualPunch('meal_in', '2026-07-06T16:30:00.000Z');
    await insertManualPunch('shift_out', '2026-07-06T20:30:00.000Z');
    const repaired = await reconcileOperationalExceptions(client, deriveInput());

    expect(repaired).toMatchObject({ candidateCount: 0, resolved: 1 });
    const finalProjection = await client.query<{ status: string; resolution_reason: string }>(
      `SELECT status, resolution_reason FROM operational_exceptions WHERE id = $1`,
      [exceptionId],
    );
    expect(finalProjection.rows[0]).toEqual({
      status: 'resolved',
      resolution_reason: 'source_condition_cleared',
    });

    const lifecycle = await client.query<{ event_type: string }>(
      `SELECT event_type FROM operational_exception_events
       WHERE exception_id = $1 ORDER BY sequence`,
      [exceptionId],
    );
    expect(lifecycle.rows.map((row) => row.event_type)).toEqual([
      'opened',
      'acknowledged',
      'resolved',
      'reopened',
      'resolved',
    ]);
    const outbox = await client.query<{ count: number }>(
      `SELECT count(*)::integer AS count
       FROM operational_notification_outbox o
       JOIN operational_exception_events ev ON ev.id = o.exception_event_id
       WHERE ev.exception_id = $1`,
      [exceptionId],
    );
    expect(outbox.rows[0]?.count).toBe(5);

    const sourceCountAfter = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM punches WHERE organization_id = $1`,
      [fixture.organizationId],
    );
    expect(sourceCountBefore.rows[0]?.count).toBe('2');
    expect(sourceCountAfter.rows[0]?.count).toBe('7');
    expect(
      (
        await client.query<{ count: number }>(
          `SELECT count(*)::integer AS count
           FROM punches
           WHERE organization_id = $1 AND source = 'manual' AND created_by IS NULL`,
          [fixture.organizationId],
        )
      ).rows[0]?.count,
    ).toBe(0);

    const eventId = (
      await client.query<{ id: string }>(
        `SELECT id FROM operational_exception_events WHERE exception_id = $1 LIMIT 1`,
        [exceptionId],
      )
    ).rows[0]!.id;
    await client.query('SAVEPOINT immutable_event_check');
    await expect(
      client.query(`UPDATE operational_exception_events SET reason = 'tampered' WHERE id = $1`, [
        eventId,
      ]),
    ).rejects.toThrow('append-only');
    await client.query('ROLLBACK TO SAVEPOINT immutable_event_check');
  });

  it('updates volatile heartbeat facts without appending an event every poll', async () => {
    await client.query(
      `UPDATE devices SET camera_status = 'degraded' WHERE id = $1`,
      [fixture.deviceId],
    );
    const opened = await reconcileOperationalExceptions(client, deriveInput());
    expect(opened).toMatchObject({ opened: 1, refreshed: 0 });

    await client.query(
      `UPDATE devices SET last_heartbeat_at = last_heartbeat_at + interval '1 minute'
       WHERE id = $1`,
      [fixture.deviceId],
    );
    const heartbeatOnly = await reconcileOperationalExceptions(client, deriveInput());
    expect(heartbeatOnly).toMatchObject({ opened: 0, refreshed: 0 });

    await client.query(
      `UPDATE devices SET camera_status = 'unavailable' WHERE id = $1`,
      [fixture.deviceId],
    );
    const semanticChange = await reconcileOperationalExceptions(client, deriveInput());
    expect(semanticChange.refreshed).toBe(1);
    const events = await client.query<{ event_type: string }>(
      `SELECT event_type FROM operational_exception_events
       WHERE organization_id = $1 ORDER BY sequence`,
      [fixture.organizationId],
    );
    expect(events.rows.map((row) => row.event_type)).toEqual(['opened', 'refreshed']);
  });

  it('reopens a structural blocker that was marked resolved without fixing its source', async () => {
    await insertManualPunch('shift_in', '2026-07-06T12:00:00.000Z');
    await reconcileOperationalExceptions(client, deriveInput());
    const exception = await client.query<{ id: string }>(
      `SELECT id FROM operational_exceptions
       WHERE organization_id = $1 AND code = 'missing_shift_out'`,
      [fixture.organizationId],
    );
    await transitionOperationalException(client, {
      organizationId: fixture.organizationId,
      exceptionId: exception.rows[0]!.id,
      actorUserId: fixture.adminId,
      action: 'resolve',
      reason: 'Revisión sin corrección de origen',
    });

    const result = await reconcileOperationalExceptions(client, deriveInput());
    expect(result.reopened).toBe(1);
    const state = await client.query<{ status: string }>(
      `SELECT status FROM operational_exceptions WHERE id = $1`,
      [exception.rows[0]!.id],
    );
    expect(state.rows[0]?.status).toBe('open');
  });

  it('derives the 05:00–13:30 scheduled-end grace from the database shift', async () => {
    const shift = await client.query<{ id: string }>(
      `INSERT INTO shifts
         (organization_id, name, start_time, end_time, tolerance_minutes)
       VALUES ($1, 'Normal', '05:00', '13:30', 5)
       RETURNING id`,
      [fixture.organizationId],
    );
    await client.query(
      `UPDATE employees SET default_shift_id = $2
       WHERE id = $1 AND organization_id = $3`,
      [fixture.employeeId, shift.rows[0]!.id, fixture.organizationId],
    );
    await insertManualPunch('shift_in', '2026-07-06T12:00:00.000Z');

    const before = await deriveOperationalExceptionCandidates(client, {
      ...deriveInput(),
      now: new Date('2026-07-06T21:29:59.000Z'),
    });
    const atDeadline = await deriveOperationalExceptionCandidates(client, {
      ...deriveInput(),
      now: new Date('2026-07-06T21:30:00.000Z'),
    });
    expect(before).toEqual([]);
    expect(atDeadline.map((value) => value.code)).toEqual(['missing_shift_out']);
  });

  it('derives finalization blockers under the weekly lock without reading the projection', async () => {
    await insertManualPunch('shift_in', '2026-07-06T12:00:00.000Z');
    const projectionBefore = await client.query<{ count: number }>(
      `SELECT count(*)::integer AS count
       FROM operational_exceptions WHERE organization_id = $1`,
      [fixture.organizationId],
    );

    const blockers = await deriveFinalizationBlockers(client, {
      organizationId: fixture.organizationId,
      fromDate: WEEK_START,
      toDate: WEEK_END,
      timezone: TIMEZONE,
    });

    expect(projectionBefore.rows[0]?.count).toBe(0);
    expect(blockers.map((value) => value.code)).toEqual(['missing_shift_out']);
    expect(blockers[0]?.severity).toBe('blocker');
    expect(
      (
        await client.query<{ count: number }>(
          `SELECT count(*)::integer AS count
           FROM operational_exceptions WHERE organization_id = $1`,
          [fixture.organizationId],
        )
      ).rows[0]?.count,
    ).toBe(0);
  });

  it('keeps identity, meal and device alerts as warnings and never adds a premium', async () => {
    await client.query(
      `UPDATE devices SET storage_status = 'unavailable' WHERE id = $1`,
      [fixture.deviceId],
    );
    const clientEventId = crypto.randomUUID();
    const installationId = crypto.randomUUID();
    const session = await client.query<{ id: string }>(
      `INSERT INTO identity_sessions
         (organization_id, plant_id, device_id, employee_id, client_event_id,
          client_installation_id, client_sequence, punch_type, captured_at,
          payload_hash, mode, provider, provider_liveness_capable,
          status, review_reason, resolved_at)
       VALUES ($1, $2, $3, $4, $5, $6, 1, 'shift_in',
               '2026-07-06T12:00:00.000Z', $7, 'review_only', 'review_only',
               false, 'review_required', 'review_only', now())
       RETURNING id`,
      [
        fixture.organizationId,
        fixture.plantA,
        fixture.deviceId,
        fixture.employeeId,
        clientEventId,
        installationId,
        'a'.repeat(64),
      ],
    );
    await client.query(
      `INSERT INTO punches
         (organization_id, employee_id, plant_id, device_id, punch_type,
          punched_at, captured_at, source, client_event_id,
          client_installation_id, client_sequence, evidence_status,
          identity_status, face_check_status, identity_session_id)
       VALUES ($1, $2, $3, $4, 'shift_in', '2026-07-06T12:00:00.000Z',
               '2026-07-06T12:00:00.000Z', 'kiosk', $5, $6, 1, 'captured',
               'identity_review', 'pending', $7)`,
      [
        fixture.organizationId,
        fixture.employeeId,
        fixture.plantA,
        fixture.deviceId,
        clientEventId,
        installationId,
        session.rows[0]!.id,
      ],
    );
    await insertManualPunch('shift_out', '2026-07-06T20:00:00.000Z');
    await client.query(
      `INSERT INTO manual_time_entries
         (organization_id, employee_id, plant_id, work_date, duration_seconds,
          reason, created_by)
       VALUES ($1, $2, $3, $4::date, 999999999, 'Horas solicitadas sin tope', $5)`,
      [
        fixture.organizationId,
        fixture.employeeId,
        fixture.plantA,
        WORK_DATE,
        fixture.adminId,
      ],
    );

    const candidates = await deriveOperationalExceptionCandidates(client, deriveInput());
    expect(candidates.map((value) => value.code).sort()).toEqual([
      'device_unhealthy',
      'first_meal_missing',
      'identity_review',
    ]);
    expect(candidates.every((value) => value.severity === 'warning')).toBe(true);
    expect(candidates.every((value) => !('premium_seconds' in value.details))).toBe(true);
    expect(candidates.find((value) => value.code === 'first_meal_missing')?.details).toMatchObject({
      total_worked_seconds: 8 * 3_600,
    });

    const blockers = await deriveFinalizationBlockers(client, {
      organizationId: fixture.organizationId,
      fromDate: WEEK_START,
      toDate: WEEK_END,
      timezone: TIMEZONE,
    });
    expect(blockers).toEqual([]);
  });

  it('enforces exact tenant/plant scope, including multi-plant exceptions', async () => {
    await insertManualPunch('shift_in', '2026-07-06T12:00:00.000Z');
    await reconcileOperationalExceptions(client, deriveInput());
    const exceptionId = (
      await client.query<{ id: string }>(
        `SELECT id FROM operational_exceptions WHERE organization_id = $1`,
        [fixture.organizationId],
      )
    ).rows[0]!.id;

    const allowed = (userId: string, role: 'admin' | 'foreman') =>
      canAccessOperationalException(client, {
        organizationId: fixture.organizationId,
        exceptionId,
        userId,
        role,
      });
    await expect(allowed(fixture.adminId, 'admin')).resolves.toBe(true);
    await expect(allowed(fixture.foremanAId, 'foreman')).resolves.toBe(true);
    await expect(allowed(fixture.foremanBId, 'foreman')).resolves.toBe(false);

    await client.query(
      `INSERT INTO operational_exception_plants
         (exception_id, organization_id, plant_id)
       VALUES ($1, $2, $3)`,
      [exceptionId, fixture.organizationId, fixture.plantB],
    );
    await expect(allowed(fixture.foremanAId, 'foreman')).resolves.toBe(false);
    await expect(allowed(fixture.foremanBothId, 'foreman')).resolves.toBe(true);

    const otherOrganization = await client.query<{ id: string }>(
      `INSERT INTO organizations (name, slug, timezone)
       VALUES ('Other F6 Tenant', $1, $2) RETURNING id`,
      [`f6-other-${crypto.randomUUID()}`, TIMEZONE],
    );
    await expect(
      canAccessOperationalException(client, {
        organizationId: otherOrganization.rows[0]!.id,
        exceptionId,
        userId: fixture.adminId,
        role: 'admin',
      }),
    ).resolves.toBe(false);
  });

  it('enforces RBAC and pagination on list, summary and detail HTTP routes', async () => {
    await insertManualPunch('shift_in', '2026-07-06T12:00:00.000Z');
    await reconcileOperationalExceptions(client, deriveInput());
    const exceptionId = (
      await client.query<{ id: string }>(
        `SELECT id FROM operational_exceptions WHERE organization_id = $1`,
        [fixture.organizationId],
      )
    ).rows[0]!.id;

    // The route helpers normally use pool.query. Point read-only route calls at
    // this test's open transaction so no committed fixture is left behind.
    const originalPoolQuery = pool.query.bind(pool);
    (pool as unknown as { query: typeof pool.query }).query = ((text: unknown, params?: unknown[]) =>
      client.query(text as string, params)) as typeof pool.query;

    const app = express();
    app.use(express.json());
    app.use('/api/exceptions', operationalExceptionsRouter);
    app.use(
      (
        error: unknown,
        _req: express.Request,
        res: express.Response,
        _next: express.NextFunction,
      ) => {
        if (error instanceof HttpError) {
          res.status(error.status).json({ error: error.message, code: error.code });
          return;
        }
        res.status(500).json({ error: error instanceof Error ? error.message : 'unknown' });
      },
    );
    const server: Server = await new Promise((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server address unavailable');
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const bearer = (id: string, role: AuthUser['role']) =>
      signAccessToken({
        id,
        role,
        name: `F6 ${role}`,
        email: `${role}@test.invalid`,
        organizationId: fixture.organizationId,
      });
    const get = async (path: string, token: string) => {
      const response = await fetch(`${baseUrl}${path}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      return { response, body: (await response.json()) as Record<string, any> };
    };

    try {
      const admin = await get(
        '/api/exceptions?limit=1&offset=0',
        bearer(fixture.adminId, 'admin'),
      );
      expect(admin.response.status).toBe(200);
      expect(admin.body).toMatchObject({ total: 1, next_offset: null });
      expect(admin.body.items).toHaveLength(1);

      const assigned = await get('/api/exceptions', bearer(fixture.foremanAId, 'foreman'));
      const unassigned = await get('/api/exceptions', bearer(fixture.foremanBId, 'foreman'));
      expect(assigned.body.total).toBe(1);
      expect(unassigned.body.total).toBe(0);

      const summary = await get(
        `/api/exceptions/summary?from_date=${WORK_DATE}&to_date=${WORK_DATE}`,
        bearer(fixture.adminId, 'admin'),
      );
      expect(summary.response.status).toBe(200);
      expect(summary.body).toMatchObject({
        totals: { all: 1, active: 1, blockers: 1, warnings: 0 },
      });

      const detail = await get(
        `/api/exceptions/${exceptionId}`,
        bearer(fixture.foremanAId, 'foreman'),
      );
      expect(detail.response.status).toBe(200);
      expect(detail.body).toMatchObject({ id: exceptionId, code: 'missing_shift_out' });
      expect(detail.body.events).toHaveLength(1);
      expect(detail.body.events[0]).toMatchObject({ sequence: 1, event_type: 'opened' });

      await client.query(
        `INSERT INTO operational_exception_events
           (organization_id, exception_id, sequence, event_type,
            from_status, to_status, snapshot)
         SELECT $1, $2, sequence, 'refreshed', 'open', 'open', '{}'::jsonb
         FROM generate_series(2, 5) AS sequence`,
        [fixture.organizationId, exceptionId],
      );
      const newestEvents = await get(
        `/api/exceptions/${exceptionId}?event_limit=2`,
        bearer(fixture.adminId, 'admin'),
      );
      expect(newestEvents.body.events.map((event: { sequence: number }) => event.sequence)).toEqual([
        4, 5,
      ]);
      expect(newestEvents.body.events_next_before_sequence).toBe(4);
      const olderEvents = await get(
        `/api/exceptions/${exceptionId}?event_limit=2&event_before_sequence=4`,
        bearer(fixture.adminId, 'admin'),
      );
      expect(olderEvents.body.events.map((event: { sequence: number }) => event.sequence)).toEqual([
        2, 3,
      ]);
      expect(olderEvents.body.events_next_before_sequence).toBe(2);

      const accountant = await get(
        '/api/exceptions',
        bearer(fixture.accountantId, 'accountant'),
      );
      expect(accountant.response.status).toBe(403);

      await client.query(
        `INSERT INTO operational_exception_plants
           (exception_id, organization_id, plant_id)
         VALUES ($1, $2, $3)`,
        [exceptionId, fixture.organizationId, fixture.plantB],
      );
      const partialScope = await get(
        `/api/exceptions/${exceptionId}`,
        bearer(fixture.foremanAId, 'foreman'),
      );
      const completeScope = await get(
        `/api/exceptions/${exceptionId}`,
        bearer(fixture.foremanBothId, 'foreman'),
      );
      expect(partialScope.response.status).toBe(404);
      expect(completeScope.response.status).toBe(200);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      (pool as unknown as { query: typeof pool.query }).query = originalPoolQuery as typeof pool.query;
    }
  });
});
