import crypto from 'node:crypto';
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../db.js';
import { HttpError } from '../errors.js';
import { signAccessToken, type AuthUser } from '../middleware/auth.js';
import { notificationsRouter } from '../routes/notifications.js';
import {
  PushSubscriptionLimitError,
  PushSubscriptionOwnershipError,
  processOperationalNotificationOutbox,
  processPendingPushDeliveries,
  serializeGenericOperationalPush,
  upsertPushSubscription,
  type PushSender,
} from './notifications.js';

const run = process.env.RUN_DB_INTEGRATION === '1';

interface NotificationFixture {
  organizationId: string;
  plantA: string;
  plantB: string;
  adminId: string;
  foremanAId: string;
  foremanBId: string;
  foremanBothId: string;
  accountantId: string;
}

async function insertUser(
  organizationId: string,
  role: 'admin' | 'foreman' | 'accountant',
  name: string,
): Promise<string> {
  const row = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, name, organization_id)
     VALUES ($1, 'unused', $2, $3, $4)
     RETURNING id`,
    [`notify-${crypto.randomUUID()}@test.invalid`, role, name, organizationId],
  );
  return row.rows[0]!.id;
}

async function createFixture(): Promise<NotificationFixture> {
  const suffix = crypto.randomUUID();
  const organization = await pool.query<{ id: string }>(
    `INSERT INTO organizations (name, slug, timezone)
     VALUES ('Notification Integration', $1, 'America/Los_Angeles')
     RETURNING id`,
    [`notification-${suffix}`],
  );
  const organizationId = organization.rows[0]!.id;
  const plants = await pool.query<{ id: string; code: string }>(
    `INSERT INTO plants (organization_id, code, name)
     VALUES ($1, 'A', 'Plant A'), ($1, 'B', 'Plant B')
     RETURNING id, code`,
    [organizationId],
  );
  const plantA = plants.rows.find((row) => row.code === 'A')!.id;
  const plantB = plants.rows.find((row) => row.code === 'B')!.id;
  const adminId = await insertUser(organizationId, 'admin', 'Notification Admin');
  const foremanAId = await insertUser(organizationId, 'foreman', 'Foreman A');
  const foremanBId = await insertUser(organizationId, 'foreman', 'Foreman B');
  const foremanBothId = await insertUser(organizationId, 'foreman', 'Foreman Both');
  const accountantId = await insertUser(organizationId, 'accountant', 'Accountant');
  await pool.query(
    `INSERT INTO user_plant_access (organization_id, user_id, plant_id)
     VALUES ($1, $2, $3), ($1, $4, $5), ($1, $6, $3), ($1, $6, $5)`,
    [organizationId, foremanAId, plantA, foremanBId, plantB, foremanBothId],
  );
  return {
    organizationId,
    plantA,
    plantB,
    adminId,
    foremanAId,
    foremanBId,
    foremanBothId,
    accountantId,
  };
}

async function createExceptionEvent(
  fixture: NotificationFixture,
  plantIds: string[],
  eventType: 'opened' | 'reopened' = 'opened',
): Promise<{ exceptionId: string; outboxId: string }> {
  const key = crypto.randomUUID();
  const fingerprint = crypto.createHash('sha256').update(`fingerprint:${key}`).digest('hex');
  const dedupe = crypto.createHash('sha256').update(`dedupe:${key}`).digest('hex');
  const exception = await pool.query<{ id: string }>(
    `INSERT INTO operational_exceptions
       (organization_id, dedupe_key, code, severity, source_type,
        source_key, source_fingerprint, occurred_at, title, status,
        acknowledged_at, acknowledged_by, resolved_at, resolved_by,
        resolution_reason)
     VALUES ($1, $2, 'identity_review', 'warning', 'identity_session',
             $3, $4, now(), 'Identity review', $5,
             NULL, NULL, NULL, NULL, NULL)
     RETURNING id`,
    [fixture.organizationId, dedupe, key, fingerprint, eventType === 'opened' ? 'open' : 'open'],
  );
  const exceptionId = exception.rows[0]!.id;
  for (const plantId of plantIds) {
    await pool.query(
      `INSERT INTO operational_exception_plants
         (exception_id, organization_id, plant_id)
       VALUES ($1, $2, $3)`,
      [exceptionId, fixture.organizationId, plantId],
    );
  }
  const event = await pool.query<{ id: string }>(
    `INSERT INTO operational_exception_events
       (organization_id, exception_id, sequence, event_type,
        from_status, to_status, snapshot)
     VALUES ($1, $2, 1, $3, $4, 'open', '{}'::jsonb)
     RETURNING id`,
    [fixture.organizationId, exceptionId, eventType, eventType === 'opened' ? null : 'resolved'],
  );
  const outbox = await pool.query<{ id: string }>(
    `SELECT id
     FROM operational_notification_outbox
     WHERE exception_event_id = $1 AND organization_id = $2`,
    [event.rows[0]!.id, fixture.organizationId],
  );
  return { exceptionId, outboxId: outbox.rows[0]!.id };
}

async function createSubscription(
  fixture: NotificationFixture,
  userId = fixture.adminId,
): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const saved = await upsertPushSubscription(client, {
      organizationId: fixture.organizationId,
      userId,
      subscription: {
        endpoint: `https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`,
        keys: { p256dh: 'p'.repeat(65), auth: 'a'.repeat(22) },
      },
      userAgent: 'ClockAI integration test',
    });
    await client.query('COMMIT');
    return saved.id;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function token(
  fixture: NotificationFixture,
  id: string,
  role: AuthUser['role'],
): string {
  return signAccessToken({
    id,
    role,
    name: 'Integration User',
    email: `${id}@test.invalid`,
    organizationId: fixture.organizationId,
  });
}

describe.skipIf(!run)('Phase 6 operational notifications + PostgreSQL integration', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/notifications', notificationsRouter);
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
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await pool.end();
  });

  it('materializes only admin + foremen with complete plant access, concurrently and idempotently', async () => {
    const fixture = await createFixture();
    const { outboxId } = await createExceptionEvent(fixture, [fixture.plantA, fixture.plantB]);

    await Promise.all([
      processOperationalNotificationOutbox(pool, { batchSize: 5 }),
      processOperationalNotificationOutbox(pool, { batchSize: 5 }),
      processOperationalNotificationOutbox(pool, { batchSize: 5 }),
    ]);
    const recipients = await pool.query<{ user_id: string }>(
      `SELECT user_id FROM user_notifications
       WHERE organization_id = $1 AND outbox_id = $2
       ORDER BY user_id`,
      [fixture.organizationId, outboxId],
    );
    expect(recipients.rows.map((row) => row.user_id).sort()).toEqual(
      [fixture.adminId, fixture.foremanBothId].sort(),
    );
    expect(recipients.rows.map((row) => row.user_id)).not.toContain(fixture.accountantId);
    expect(recipients.rows.map((row) => row.user_id)).not.toContain(fixture.foremanAId);
    expect(recipients.rows.map((row) => row.user_id)).not.toContain(fixture.foremanBId);

    // Simulate a lost success response after commit. Uniqueness prevents a
    // second inbox item or delivery on reprocessing.
    await pool.query(
      `UPDATE operational_notification_outbox SET processed_at = NULL WHERE id = $1`,
      [outboxId],
    );
    await processOperationalNotificationOutbox(pool);
    const count = await pool.query<{ count: number }>(
      `SELECT count(*)::integer AS count
       FROM user_notifications WHERE outbox_id = $1`,
      [outboxId],
    );
    expect(count.rows[0]?.count).toBe(2);
  });

  it('cannot overwrite another tenant during a concurrent endpoint race', async () => {
    const owner = await createFixture();
    const contenderFixture = await createFixture();
    const endpoint = `https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`;
    const first = await pool.connect();
    const second = await pool.connect();
    try {
      await first.query('BEGIN');
      await second.query('BEGIN');
      await upsertPushSubscription(first, {
        organizationId: owner.organizationId,
        userId: owner.adminId,
        subscription: {
          endpoint,
          keys: { p256dh: 'o'.repeat(65), auth: 'a'.repeat(22) },
        },
      });

      const racingInsert = upsertPushSubscription(second, {
        organizationId: contenderFixture.organizationId,
        userId: contenderFixture.adminId,
        subscription: {
          endpoint,
          keys: { p256dh: 'x'.repeat(65), auth: 'z'.repeat(22) },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      await first.query('COMMIT');
      await expect(racingInsert).rejects.toBeInstanceOf(PushSubscriptionOwnershipError);
      await second.query('ROLLBACK');

      const stored = await pool.query<{
        organization_id: string;
        user_id: string;
        p256dh: string;
      }>(
        `SELECT organization_id, user_id, p256dh
         FROM push_subscriptions WHERE endpoint_hash = $1`,
        [crypto.createHash('sha256').update(endpoint).digest('hex')],
      );
      expect(stored.rows).toEqual([
        {
          organization_id: owner.organizationId,
          user_id: owner.adminId,
          p256dh: 'o'.repeat(65),
        },
      ]);
    } finally {
      await first.query('ROLLBACK').catch(() => undefined);
      await second.query('ROLLBACK').catch(() => undefined);
      first.release();
      second.release();
    }
  });

  it('caps active push capabilities per user', async () => {
    const fixture = await createFixture();
    for (let index = 0; index < 5; index += 1) await createSubscription(fixture);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await expect(
        upsertPushSubscription(client, {
          organizationId: fixture.organizationId,
          userId: fixture.adminId,
          subscription: {
            endpoint: `https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`,
            keys: { p256dh: 'p'.repeat(65), auth: 'a'.repeat(22) },
          },
        }),
      ).rejects.toBeInstanceOf(PushSubscriptionLimitError);
      await client.query('ROLLBACK');
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('serializes concurrent quota claims for the same user', async () => {
    const fixture = await createFixture();
    for (let index = 0; index < 4; index += 1) await createSubscription(fixture);
    const first = await pool.connect();
    const second = await pool.connect();
    try {
      await first.query('BEGIN');
      await second.query('BEGIN');
      await upsertPushSubscription(first, {
        organizationId: fixture.organizationId,
        userId: fixture.adminId,
        subscription: {
          endpoint: `https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`,
          keys: { p256dh: 'f'.repeat(65), auth: 'a'.repeat(22) },
        },
      });
      const competingClaim = upsertPushSubscription(second, {
        organizationId: fixture.organizationId,
        userId: fixture.adminId,
        subscription: {
          endpoint: `https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`,
          keys: { p256dh: 's'.repeat(65), auth: 'b'.repeat(22) },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      await first.query('COMMIT');
      await expect(competingClaim).rejects.toBeInstanceOf(PushSubscriptionLimitError);
      await second.query('ROLLBACK');

      const active = await pool.query<{ count: number }>(
        `SELECT count(*)::integer AS count FROM push_subscriptions
         WHERE organization_id = $1 AND user_id = $2 AND active`,
        [fixture.organizationId, fixture.adminId],
      );
      expect(active.rows[0]?.count).toBe(5);
    } finally {
      await first.query('ROLLBACK').catch(() => undefined);
      await second.query('ROLLBACK').catch(() => undefined);
      first.release();
      second.release();
    }
  });

  it('keeps inbox/list/read operations isolated by user, tenant and role', async () => {
    const fixture = await createFixture();
    await createSubscription(fixture, fixture.foremanAId);
    await createExceptionEvent(fixture, [fixture.plantA]);
    await processOperationalNotificationOutbox(pool);
    const adminNotification = await pool.query<{ id: string }>(
      `SELECT id FROM user_notifications
       WHERE organization_id = $1 AND user_id = $2`,
      [fixture.organizationId, fixture.adminId],
    );
    const notificationId = adminNotification.rows[0]!.id;

    const adminList = await fetch(`${baseUrl}/api/notifications`, {
      headers: { Authorization: `Bearer ${token(fixture, fixture.adminId, 'admin')}` },
    });
    expect(adminList.status).toBe(200);
    expect((await adminList.json()).items).toHaveLength(1);

    const foremanNotification = await pool.query<{ id: string }>(
      `SELECT id FROM user_notifications
       WHERE organization_id = $1 AND user_id = $2`,
      [fixture.organizationId, fixture.foremanAId],
    );
    const foremanList = await fetch(`${baseUrl}/api/notifications`, {
      headers: {
        Authorization: `Bearer ${token(fixture, fixture.foremanAId, 'foreman')}`,
      },
    });
    expect(foremanList.status).toBe(200);
    expect((await foremanList.json()).items).toHaveLength(1);

    // Revocation is immediate for historical inbox rows as well; a former
    // plant assignee cannot keep reading an alert merely because it was once
    // materialized for that user.
    await pool.query(
      `DELETE FROM user_plant_access
       WHERE organization_id = $1 AND user_id = $2 AND plant_id = $3`,
      [fixture.organizationId, fixture.foremanAId, fixture.plantA],
    );
    const revokedList = await fetch(`${baseUrl}/api/notifications`, {
      headers: {
        Authorization: `Bearer ${token(fixture, fixture.foremanAId, 'foreman')}`,
      },
    });
    expect(revokedList.status).toBe(200);
    expect((await revokedList.json()).items).toHaveLength(0);

    let revokedPushSends = 0;
    const revokedSender: PushSender = {
      async send() {
        revokedPushSends += 1;
        return { statusCode: 201 };
      },
    };
    expect(
      await processPendingPushDeliveries(pool, revokedSender, { batchSize: 5 }),
    ).toMatchObject({ abandoned: 1 });
    expect(revokedPushSends).toBe(0);

    const foremanRead = await fetch(
      `${baseUrl}/api/notifications/${foremanNotification.rows[0]!.id}/read`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token(fixture, fixture.foremanAId, 'foreman')}`,
        },
      },
    );
    expect(foremanRead.status).toBe(404);

    const accountantList = await fetch(`${baseUrl}/api/notifications`, {
      headers: {
        Authorization: `Bearer ${token(fixture, fixture.accountantId, 'accountant')}`,
      },
    });
    expect(accountantList.status).toBe(403);

    const otherFixture = await createFixture();
    const crossTenantRead = await fetch(
      `${baseUrl}/api/notifications/${notificationId}/read`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token(otherFixture, otherFixture.adminId, 'admin')}`,
        },
      },
    );
    expect(crossTenantRead.status).toBe(404);
  });

  it('delivers a generic push once under concurrent workers', async () => {
    const fixture = await createFixture();
    await createSubscription(fixture);
    await createExceptionEvent(fixture, [fixture.plantA]);
    await processOperationalNotificationOutbox(pool);
    const payloads: string[] = [];
    const sender: PushSender = {
      async send(_subscription, payload) {
        payloads.push(payload);
        return { statusCode: 201 };
      },
    };
    await Promise.all([
      processPendingPushDeliveries(pool, sender, { batchSize: 5 }),
      processPendingPushDeliveries(pool, sender, { batchSize: 5 }),
    ]);
    expect(payloads).toEqual([serializeGenericOperationalPush()]);
    const delivery = await pool.query<{ status: string; attempts: number }>(
      `SELECT status, attempts
       FROM notification_deliveries
       WHERE organization_id = $1`,
      [fixture.organizationId],
    );
    expect(delivery.rows).toEqual([expect.objectContaining({ status: 'delivered', attempts: 1 })]);
  });

  it('retries temporary failures, fails at the cap and never changes the exception', async () => {
    const fixture = await createFixture();
    await createSubscription(fixture);
    const { exceptionId } = await createExceptionEvent(fixture, [fixture.plantA]);
    await processOperationalNotificationOutbox(pool);
    const sender: PushSender = {
      async send() {
        throw Object.assign(new Error('provider unavailable'), { statusCode: 503 });
      },
    };
    expect(
      await processPendingPushDeliveries(pool, sender, { batchSize: 1, maxAttempts: 2 }),
    ).toMatchObject({ retried: 1 });
    await pool.query(
      `UPDATE notification_deliveries SET available_at = now()
       WHERE organization_id = $1`,
      [fixture.organizationId],
    );
    expect(
      await processPendingPushDeliveries(pool, sender, { batchSize: 1, maxAttempts: 2 }),
    ).toMatchObject({ failed: 1 });
    const state = await pool.query<{ status: string; attempts: number }>(
      `SELECT status, attempts FROM notification_deliveries
       WHERE organization_id = $1`,
      [fixture.organizationId],
    );
    expect(state.rows).toEqual([expect.objectContaining({ status: 'failed', attempts: 2 })]);
    const exception = await pool.query<{ status: string }>(
      `SELECT status FROM operational_exceptions WHERE id = $1`,
      [exceptionId],
    );
    expect(exception.rows[0]?.status).toBe('open');
  });

  it('never pushes an already queued operational alert after the recipient becomes accountant', async () => {
    const fixture = await createFixture();
    const subscriptionId = await createSubscription(fixture);
    await createExceptionEvent(fixture, [fixture.plantA]);
    await processOperationalNotificationOutbox(pool);
    await pool.query(
      `UPDATE users SET role = 'accountant'
       WHERE id = $1 AND organization_id = $2`,
      [fixture.adminId, fixture.organizationId],
    );
    let sends = 0;
    const sender: PushSender = {
      async send() {
        sends += 1;
        return { statusCode: 201 };
      },
    };
    expect(await processPendingPushDeliveries(pool, sender, { batchSize: 1 })).toMatchObject({
      abandoned: 1,
    });
    expect(sends).toBe(0);
    const subscription = await pool.query<{ active: boolean }>(
      `SELECT active FROM push_subscriptions WHERE id = $1`,
      [subscriptionId],
    );
    expect(subscription.rows[0]?.active).toBe(false);
  });

  it('deactivates expired 404/410 endpoints and abandons every pending delivery', async () => {
    const fixture = await createFixture();
    const subscriptionId = await createSubscription(fixture);
    await createExceptionEvent(fixture, [fixture.plantA]);
    await createExceptionEvent(fixture, [fixture.plantA]);
    await processOperationalNotificationOutbox(pool, { batchSize: 10 });
    const sender: PushSender = {
      async send() {
        throw Object.assign(new Error('gone'), { statusCode: 410 });
      },
    };
    expect(await processPendingPushDeliveries(pool, sender, { batchSize: 1 })).toMatchObject({
      abandoned: 1,
    });
    const subscription = await pool.query<{ active: boolean }>(
      `SELECT active FROM push_subscriptions WHERE id = $1`,
      [subscriptionId],
    );
    expect(subscription.rows[0]?.active).toBe(false);
    const deliveries = await pool.query<{ status: string }>(
      `SELECT status FROM notification_deliveries
       WHERE push_subscription_id = $1`,
      [subscriptionId],
    );
    expect(deliveries.rows).toHaveLength(2);
    expect(deliveries.rows.every((row) => row.status === 'abandoned')).toBe(true);
  });
});
