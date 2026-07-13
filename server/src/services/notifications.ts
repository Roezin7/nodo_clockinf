import crypto from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import webPush from 'web-push';
import type { EnabledWebPushConfig } from './pushConfig.js';

export const GENERIC_OPERATIONAL_PUSH_PAYLOAD = Object.freeze({
  title: 'ClockAI',
  body: 'Hay una actualización operativa pendiente.',
  url: '/exceptions',
  tag: 'clockai-operational-update',
});

export interface PushSubscriptionInput {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

export interface StoredPushSubscription {
  id: string;
  active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface PushSender {
  send(subscription: PushSubscriptionInput, payload: string): Promise<{ statusCode?: number }>;
}

export interface NotificationWorkerResult {
  processed: number;
  deferred: number;
}

export interface PushDeliveryWorkerResult {
  delivered: number;
  retried: number;
  abandoned: number;
  failed: number;
}

export class PushSubscriptionOwnershipError extends Error {
  constructor() {
    super('La suscripción ya pertenece a otra cuenta');
  }
}

export class PushSubscriptionLimitError extends Error {
  constructor() {
    super('Se alcanzó el límite de dispositivos con avisos');
  }
}

export class InvalidPushEndpointError extends Error {
  constructor() {
    super('El endpoint no pertenece a un servicio Web Push compatible');
  }
}

export const MAX_ACTIVE_PUSH_SUBSCRIPTIONS_PER_USER = 5;

/**
 * Browser subscriptions are capabilities, but the API is still attacker
 * controlled. Restrict server-side POSTs to the push services used by the
 * supported Safari/Chromium/Firefox/Edge browsers to prevent SSRF.
 */
export function isAllowedWebPushEndpoint(value: string): boolean {
  try {
    const endpoint = new URL(value);
    if (
      endpoint.protocol !== 'https:' ||
      endpoint.username !== '' ||
      endpoint.password !== '' ||
      (endpoint.port !== '' && endpoint.port !== '443')
    ) {
      return false;
    }
    const host = endpoint.hostname.toLowerCase().replace(/\.$/, '');
    return (
      host === 'fcm.googleapis.com' ||
      host === 'updates.push.services.mozilla.com' ||
      host === 'web.push.apple.com' ||
      host.endsWith('.notify.windows.com')
    );
  } catch {
    return false;
  }
}

type ConnectionPool = Pick<Pool, 'connect'>;

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : 'unknown notification error';
  return message.replace(/[\r\n]+/g, ' ').slice(0, 1_000);
}

function providerStatus(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const status = (error as { statusCode?: unknown }).statusCode;
  return typeof status === 'number' && Number.isInteger(status) ? status : null;
}

export function notificationRetryDelaySeconds(attempt: number): number {
  const safeAttempt = Math.max(1, Math.floor(attempt));
  return Math.min(3_600, 15 * 2 ** Math.min(8, safeAttempt - 1));
}

export function pushEndpointHash(endpoint: string): string {
  return crypto.createHash('sha256').update(endpoint).digest('hex');
}

export function serializeGenericOperationalPush(): string {
  return JSON.stringify(GENERIC_OPERATIONAL_PUSH_PAYLOAD);
}

export function createWebPushSender(config: EnabledWebPushConfig): PushSender {
  return {
    async send(subscription, payload) {
      const response = await webPush.sendNotification(subscription, payload, {
        vapidDetails: {
          subject: config.subject,
          publicKey: config.publicKey,
          privateKey: config.privateKey,
        },
        TTL: 300,
        urgency: 'normal',
        topic: 'clockai-operational-update',
        timeout: 10_000,
      });
      return { statusCode: response.statusCode };
    },
  };
}

export async function upsertPushSubscription(
  client: PoolClient,
  input: {
    organizationId: string;
    userId: string;
    subscription: PushSubscriptionInput;
    userAgent?: string | null;
  },
): Promise<StoredPushSubscription> {
  if (!isAllowedWebPushEndpoint(input.subscription.endpoint)) {
    throw new InvalidPushEndpointError();
  }
  const endpointHash = pushEndpointHash(input.subscription.endpoint);
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`, [
    input.organizationId,
    `push-subscriptions:${input.userId}`,
  ]);
  const existing = await client.query<{
    id: string;
    organization_id: string;
    user_id: string;
  }>(
    `SELECT id, organization_id, user_id
     FROM push_subscriptions
     WHERE endpoint_hash = $1
     FOR UPDATE`,
    [endpointHash],
  );
  const owner = existing.rows[0];
  if (
    owner &&
    (owner.organization_id !== input.organizationId || owner.user_id !== input.userId)
  ) {
    throw new PushSubscriptionOwnershipError();
  }

  const active = await client.query<{ count: number }>(
    `SELECT count(*)::integer AS count
     FROM push_subscriptions
     WHERE organization_id = $1 AND user_id = $2 AND active
       AND endpoint_hash <> $3`,
    [input.organizationId, input.userId, endpointHash],
  );
  if ((active.rows[0]?.count ?? 0) >= MAX_ACTIVE_PUSH_SUBSCRIPTIONS_PER_USER) {
    throw new PushSubscriptionLimitError();
  }

  const result = await client.query<StoredPushSubscription>(
    `INSERT INTO push_subscriptions
       (organization_id, user_id, endpoint, endpoint_hash, p256dh,
        auth_secret, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (endpoint_hash) DO UPDATE SET
       endpoint = EXCLUDED.endpoint,
       p256dh = EXCLUDED.p256dh,
       auth_secret = EXCLUDED.auth_secret,
       user_agent = EXCLUDED.user_agent,
       active = true,
       consecutive_failures = 0,
       disabled_at = NULL,
       updated_at = now()
     WHERE push_subscriptions.organization_id = EXCLUDED.organization_id
       AND push_subscriptions.user_id = EXCLUDED.user_id
     RETURNING id, active, created_at, updated_at`,
    [
      input.organizationId,
      input.userId,
      input.subscription.endpoint,
      endpointHash,
      input.subscription.keys.p256dh,
      input.subscription.keys.auth,
      input.userAgent?.slice(0, 1_000) ?? null,
    ],
  );
  const saved = result.rows[0];
  // Two tenants may race after both observe an absent endpoint. The
  // ownership predicate makes the losing ON CONFLICT a zero-row operation.
  if (!saved) throw new PushSubscriptionOwnershipError();
  return saved;
}

export async function deactivatePushSubscription(
  client: PoolClient,
  input: { organizationId: string; userId: string; subscriptionId: string },
): Promise<boolean> {
  const result = await client.query<{ id: string }>(
    `UPDATE push_subscriptions
     SET active = false, disabled_at = COALESCE(disabled_at, now()), updated_at = now()
     WHERE id = $1 AND organization_id = $2 AND user_id = $3
     RETURNING id`,
    [input.subscriptionId, input.organizationId, input.userId],
  );
  if (!result.rows[0]) return false;
  await client.query(
    `UPDATE notification_deliveries
     SET status = 'abandoned', last_error = 'subscription_unsubscribed', updated_at = now()
     WHERE push_subscription_id = $1
       AND organization_id = $2
       AND user_id = $3
       AND status = 'pending'`,
    [input.subscriptionId, input.organizationId, input.userId],
  );
  return true;
}

async function insertNotificationsForOutbox(
  client: PoolClient,
  outboxId: string,
): Promise<void> {
  await client.query(
    `INSERT INTO user_notifications
       (organization_id, user_id, outbox_id, exception_id,
        exception_event_id, event_type, severity, exception_code,
        title, body, action_url)
     SELECT o.organization_id, u.id, o.id, e.id, ev.id, o.event_type,
            e.severity, e.code,
            CASE o.event_type
              WHEN 'opened' THEN 'Nueva alerta operativa'
              WHEN 'reopened' THEN 'Alerta operativa reabierta'
              WHEN 'acknowledged' THEN 'Alerta operativa reconocida'
              ELSE 'Alerta operativa resuelta'
            END,
            e.title,
            '/exceptions'
     FROM operational_notification_outbox o
     JOIN operational_exception_events ev
       ON ev.id = o.exception_event_id
      AND ev.organization_id = o.organization_id
     JOIN operational_exceptions e
       ON e.id = ev.exception_id
      AND e.organization_id = ev.organization_id
     JOIN users u
       ON u.organization_id = o.organization_id
      AND u.active
     WHERE o.id = $1
       AND (
         u.role = 'admin'
         OR (
           u.role = 'foreman'
           AND EXISTS (
             SELECT 1
             FROM operational_exception_plants any_ep
             WHERE any_ep.exception_id = e.id
               AND any_ep.organization_id = e.organization_id
           )
           AND NOT EXISTS (
             SELECT 1
             FROM operational_exception_plants denied_ep
             WHERE denied_ep.exception_id = e.id
               AND denied_ep.organization_id = e.organization_id
               AND NOT EXISTS (
                 SELECT 1
                 FROM user_plant_access access
                 WHERE access.organization_id = denied_ep.organization_id
                   AND access.plant_id = denied_ep.plant_id
                   AND access.user_id = u.id
               )
           )
         )
       )
     ON CONFLICT (outbox_id, user_id) DO NOTHING`,
    [outboxId],
  );

  // A retry may encounter an inbox row that already exists. Rebuild the
  // idempotent delivery edge before the outbox is declared processed.
  await client.query(
    `INSERT INTO notification_deliveries
       (organization_id, user_id, notification_id, push_subscription_id)
     SELECT n.organization_id, n.user_id, n.id, s.id
     FROM user_notifications n
     JOIN push_subscriptions s
       ON s.organization_id = n.organization_id
      AND s.user_id = n.user_id
      AND s.active
     WHERE n.outbox_id = $1
     ON CONFLICT (notification_id, push_subscription_id) DO NOTHING`,
    [outboxId],
  );
}

async function processOneOutbox(pool: ConnectionPool): Promise<'none' | 'processed' | 'deferred'> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query<{ id: string; attempts: number }>(
      `SELECT id, attempts
       FROM operational_notification_outbox
       WHERE processed_at IS NULL AND available_at <= now()
       ORDER BY available_at, created_at, id
       FOR UPDATE SKIP LOCKED
       LIMIT 1`,
    );
    const outbox = result.rows[0];
    if (!outbox) {
      await client.query('COMMIT');
      return 'none';
    }

    await client.query('SAVEPOINT notification_materialization');
    try {
      await insertNotificationsForOutbox(client, outbox.id);
      await client.query(
        `UPDATE operational_notification_outbox
         SET processed_at = now(), last_error = NULL
         WHERE id = $1`,
        [outbox.id],
      );
      await client.query('RELEASE SAVEPOINT notification_materialization');
      await client.query('COMMIT');
      return 'processed';
    } catch (error) {
      await client.query('ROLLBACK TO SAVEPOINT notification_materialization');
      const nextAttempt = outbox.attempts + 1;
      await client.query(
        `UPDATE operational_notification_outbox
         SET attempts = $2,
             available_at = now() + ($3::integer * interval '1 second'),
             last_error = $4
         WHERE id = $1`,
        [outbox.id, nextAttempt, notificationRetryDelaySeconds(nextAttempt), errorText(error)],
      );
      await client.query('COMMIT');
      return 'deferred';
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function processOperationalNotificationOutbox(
  pool: ConnectionPool,
  options: { batchSize?: number } = {},
): Promise<NotificationWorkerResult> {
  const batchSize = Math.max(1, Math.min(200, Math.floor(options.batchSize ?? 50)));
  const result: NotificationWorkerResult = { processed: 0, deferred: 0 };
  for (let index = 0; index < batchSize; index += 1) {
    const outcome = await processOneOutbox(pool);
    if (outcome === 'none') break;
    result[outcome] += 1;
  }
  return result;
}

interface LockedDelivery {
  id: string;
  attempts: number;
  push_subscription_id: string;
  endpoint: string;
  p256dh: string;
  auth_secret: string;
  recipient_active: boolean;
  recipient_role: string;
  recipient_scope_allowed: boolean;
}

async function processOnePushDelivery(
  pool: ConnectionPool,
  sender: PushSender,
  maxAttempts: number,
): Promise<'none' | keyof PushDeliveryWorkerResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query<LockedDelivery>(
      `SELECT d.id, d.attempts, d.push_subscription_id,
              s.endpoint, s.p256dh, s.auth_secret,
              u.active AS recipient_active, u.role AS recipient_role,
              CASE
                WHEN u.role = 'admin' THEN true
                WHEN u.role = 'foreman' THEN
                  EXISTS (
                    SELECT 1
                    FROM user_notifications n
                    JOIN operational_exception_plants any_ep
                      ON any_ep.exception_id = n.exception_id
                     AND any_ep.organization_id = n.organization_id
                    WHERE n.id = d.notification_id
                      AND n.organization_id = d.organization_id
                  )
                  AND NOT EXISTS (
                    SELECT 1
                    FROM user_notifications n
                    JOIN operational_exception_plants denied_ep
                      ON denied_ep.exception_id = n.exception_id
                     AND denied_ep.organization_id = n.organization_id
                    WHERE n.id = d.notification_id
                      AND n.organization_id = d.organization_id
                      AND NOT EXISTS (
                        SELECT 1 FROM user_plant_access access
                        WHERE access.organization_id = denied_ep.organization_id
                          AND access.plant_id = denied_ep.plant_id
                          AND access.user_id = d.user_id
                      )
                  )
                ELSE false
              END AS recipient_scope_allowed
       FROM notification_deliveries d
       JOIN push_subscriptions s
         ON s.id = d.push_subscription_id
        AND s.organization_id = d.organization_id
        AND s.user_id = d.user_id
        AND s.active
       JOIN users u
         ON u.id = d.user_id
        AND u.organization_id = d.organization_id
       WHERE d.status = 'pending' AND d.available_at <= now()
       ORDER BY d.available_at, d.created_at, d.id
       FOR UPDATE OF d, s SKIP LOCKED
       LIMIT 1`,
    );
    const delivery = result.rows[0];
    if (!delivery) {
      await client.query('COMMIT');
      return 'none';
    }

    if (
      !delivery.recipient_active ||
      (delivery.recipient_role !== 'admin' && delivery.recipient_role !== 'foreman')
    ) {
      await client.query(
        `UPDATE push_subscriptions
         SET active = false, disabled_at = now(), updated_at = now()
         WHERE id = $1`,
        [delivery.push_subscription_id],
      );
      await client.query(
        `UPDATE notification_deliveries
         SET status = 'abandoned', last_error = 'recipient_ineligible', updated_at = now()
         WHERE push_subscription_id = $1 AND status = 'pending'`,
        [delivery.push_subscription_id],
      );
      await client.query('COMMIT');
      return 'abandoned';
    }

    if (!delivery.recipient_scope_allowed) {
      await client.query(
        `UPDATE notification_deliveries
         SET status = 'abandoned', last_error = 'recipient_scope_revoked', updated_at = now()
         WHERE id = $1`,
        [delivery.id],
      );
      await client.query('COMMIT');
      return 'abandoned';
    }

    try {
      const response = await sender.send(
        {
          endpoint: delivery.endpoint,
          keys: { p256dh: delivery.p256dh, auth: delivery.auth_secret },
        },
        serializeGenericOperationalPush(),
      );
      await client.query(
        `UPDATE notification_deliveries
         SET status = 'delivered', attempts = attempts + 1,
             last_attempt_at = now(), delivered_at = now(),
             last_response_status = $2, last_error = NULL, updated_at = now()
         WHERE id = $1`,
        [delivery.id, response.statusCode ?? 201],
      );
      await client.query(
        `UPDATE push_subscriptions
         SET consecutive_failures = 0, last_success_at = now(), updated_at = now()
         WHERE id = $1`,
        [delivery.push_subscription_id],
      );
      await client.query('COMMIT');
      return 'delivered';
    } catch (error) {
      const status = providerStatus(error);
      const nextAttempt = delivery.attempts + 1;
      const message = errorText(error);
      if (status === 404 || status === 410) {
        await client.query(
          `UPDATE push_subscriptions
           SET active = false, consecutive_failures = consecutive_failures + 1,
               last_failure_at = now(), disabled_at = now(), updated_at = now()
           WHERE id = $1`,
          [delivery.push_subscription_id],
        );
        await client.query(
          `UPDATE notification_deliveries
           SET status = 'abandoned',
               attempts = attempts + CASE WHEN id = $2 THEN 1 ELSE 0 END,
               last_attempt_at = CASE WHEN id = $2 THEN now() ELSE last_attempt_at END,
               last_response_status = CASE WHEN id = $2 THEN $3 ELSE last_response_status END,
               last_error = 'push_subscription_expired', updated_at = now()
           WHERE push_subscription_id = $1 AND status = 'pending'`,
          [delivery.push_subscription_id, delivery.id, status],
        );
        await client.query('COMMIT');
        return 'abandoned';
      }

      const terminal = nextAttempt >= maxAttempts;
      await client.query(
        `UPDATE notification_deliveries
         SET status = $2, attempts = $3, last_attempt_at = now(),
             available_at = CASE
               WHEN $2 = 'pending'
               THEN now() + ($4::integer * interval '1 second')
               ELSE available_at
             END,
             last_response_status = $5, last_error = $6, updated_at = now()
         WHERE id = $1`,
        [
          delivery.id,
          terminal ? 'failed' : 'pending',
          nextAttempt,
          notificationRetryDelaySeconds(nextAttempt),
          status,
          message,
        ],
      );
      await client.query(
        `UPDATE push_subscriptions
         SET consecutive_failures = consecutive_failures + 1,
             last_failure_at = now(), updated_at = now()
         WHERE id = $1`,
        [delivery.push_subscription_id],
      );
      await client.query('COMMIT');
      return terminal ? 'failed' : 'retried';
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function processPendingPushDeliveries(
  pool: ConnectionPool,
  sender: PushSender,
  options: { batchSize?: number; maxAttempts?: number } = {},
): Promise<PushDeliveryWorkerResult> {
  const batchSize = Math.max(1, Math.min(200, Math.floor(options.batchSize ?? 50)));
  const maxAttempts = Math.max(1, Math.min(20, Math.floor(options.maxAttempts ?? 8)));
  const result: PushDeliveryWorkerResult = {
    delivered: 0,
    retried: 0,
    abandoned: 0,
    failed: 0,
  };
  for (let index = 0; index < batchSize; index += 1) {
    const outcome = await processOnePushDelivery(pool, sender, maxAttempts);
    if (outcome === 'none') break;
    result[outcome] += 1;
  }
  return result;
}
