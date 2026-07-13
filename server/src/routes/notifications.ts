import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { query, queryOne, withTransaction } from '../db.js';
import { HttpError, conflict, notFound } from '../errors.js';
import { requireAuth, requireOrganization, requireRole } from '../middleware/auth.js';
import { recordAudit } from '../services/auditService.js';
import {
  PushSubscriptionOwnershipError,
  PushSubscriptionLimitError,
  deactivatePushSubscription,
  isAllowedWebPushEndpoint,
  pushEndpointHash,
  upsertPushSubscription,
} from '../services/notifications.js';

export const notificationsRouter = Router();

// Operational alerts are intentionally unavailable to accountants. They only
// receive the closed time report through the reporting surface.
notificationsRouter.use(requireAuth, requireRole('admin', 'foreman'));

const listSchema = z.object({
  unread_only: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .default('false'),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

const HTTPS_URL = z
  .string()
  .url()
  .max(4_096)
  .refine((value) => value.startsWith('https://'), 'El endpoint debe usar HTTPS');
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const subscriptionSchema = z.object({
  endpoint: HTTPS_URL.refine(
    isAllowedWebPushEndpoint,
    'El endpoint no pertenece a un servicio Web Push compatible',
  ),
  keys: z.object({
    p256dh: z.string().min(40).max(512).regex(BASE64URL),
    auth: z.string().min(8).max(256).regex(BASE64URL),
  }),
});
const currentSubscriptionSchema = z.object({ endpoint: HTTPS_URL });

interface NotificationRow {
  id: string;
  event_type: 'opened' | 'acknowledged' | 'resolved' | 'reopened';
  severity: 'blocker' | 'warning';
  exception_code: string;
  title: string;
  body: string;
  action_url: string;
  read_at: Date | null;
  created_at: Date;
  total_count: number;
}

function currentPlantScopeSql(notificationAlias = 'n'): string {
  return `(
    $3::text = 'admin'
    OR (
      $3::text = 'foreman'
      AND EXISTS (
        SELECT 1
        FROM operational_exception_plants any_ep
        WHERE any_ep.exception_id = ${notificationAlias}.exception_id
          AND any_ep.organization_id = ${notificationAlias}.organization_id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM operational_exception_plants denied_ep
        WHERE denied_ep.exception_id = ${notificationAlias}.exception_id
          AND denied_ep.organization_id = ${notificationAlias}.organization_id
          AND NOT EXISTS (
            SELECT 1
            FROM user_plant_access access
            WHERE access.organization_id = denied_ep.organization_id
              AND access.plant_id = denied_ep.plant_id
              AND access.user_id = $2
          )
      )
    )
  )`;
}

notificationsRouter.get('/push-config', (req, res) => {
  requireOrganization(req);
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.json({
    enabled: config.webPush.enabled,
    public_key: config.webPush.publicKey,
  });
});

notificationsRouter.get('/unread-count', async (req, res) => {
  const organizationId = requireOrganization(req);
  const row = await queryOne<{ count: number }>(
    `SELECT count(*)::integer AS count
     FROM user_notifications n
     WHERE n.organization_id = $1 AND n.user_id = $2 AND n.read_at IS NULL
       AND ${currentPlantScopeSql()}`,
    [organizationId, req.user!.id, req.user!.role],
  );
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.json({ unread: row?.count ?? 0 });
});

notificationsRouter.get('/', async (req, res) => {
  const organizationId = requireOrganization(req);
  const filters = listSchema.parse(req.query);
  const params: unknown[] = [organizationId, req.user!.id, req.user!.role];
  const unreadFilter = filters.unread_only ? 'AND read_at IS NULL' : '';
  params.push(filters.limit, filters.offset);
  const rows = await query<NotificationRow>(
    `SELECT id, event_type, severity, exception_code, title, body,
            action_url, read_at, created_at,
            count(*) OVER()::integer AS total_count
     FROM user_notifications n
     WHERE n.organization_id = $1 AND n.user_id = $2 ${unreadFilter}
       AND ${currentPlantScopeSql()}
     ORDER BY n.created_at DESC, n.id DESC
     LIMIT $4 OFFSET $5`,
    params,
  );
  const total = rows[0]?.total_count ?? 0;
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.json({
    items: rows.map(({ total_count: _total, ...row }) => row),
    total,
    unread: await queryOne<{ count: number }>(
      `SELECT count(*)::integer AS count
       FROM user_notifications n
       WHERE n.organization_id = $1 AND n.user_id = $2 AND n.read_at IS NULL
         AND ${currentPlantScopeSql()}`,
      [organizationId, req.user!.id, req.user!.role],
    ).then((row) => row?.count ?? 0),
    next_offset: filters.offset + rows.length < total ? filters.offset + rows.length : null,
  });
});

notificationsRouter.post('/read-all', async (req, res) => {
  const organizationId = requireOrganization(req);
  const result = await query(
    `UPDATE user_notifications n
     SET read_at = now()
     WHERE n.organization_id = $1 AND n.user_id = $2 AND n.read_at IS NULL
       AND ${currentPlantScopeSql()}
     RETURNING n.id`,
    [organizationId, req.user!.id, req.user!.role],
  );
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.json({ updated: result.length });
});

notificationsRouter.post('/:id/read', async (req, res) => {
  const organizationId = requireOrganization(req);
  const notificationId = z.string().uuid().parse(req.params.id);
  const row = await queryOne<{ id: string; read_at: Date }>(
    `UPDATE user_notifications n
     SET read_at = COALESCE(read_at, now())
     WHERE n.id = $4 AND n.organization_id = $1 AND n.user_id = $2
       AND ${currentPlantScopeSql()}
     RETURNING n.id, n.read_at`,
    [organizationId, req.user!.id, req.user!.role, notificationId],
  );
  if (!row) throw notFound('Notificación no encontrada');
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.json(row);
});

notificationsRouter.post('/push-subscriptions', async (req, res) => {
  const organizationId = requireOrganization(req);
  if (!config.webPush.enabled) {
    throw new HttpError(503, 'Notificaciones push no configuradas', 'PUSH_DISABLED');
  }
  const subscription = subscriptionSchema.parse(req.body);
  try {
    const saved = await withTransaction(async (client) => {
      const row = await upsertPushSubscription(client, {
        organizationId,
        userId: req.user!.id,
        subscription,
        userAgent: req.get('user-agent'),
      });
      await recordAudit(
        {
          organizationId,
          actorUserId: req.user!.id,
          action: 'push_subscription.enabled',
          entityType: 'push_subscription',
          entityId: row.id,
        },
        client,
      );
      return row;
    });
    res.status(201).json(saved);
  } catch (error) {
    if (error instanceof PushSubscriptionOwnershipError) {
      throw conflict('La suscripción ya pertenece a otra cuenta', 'PUSH_SUBSCRIPTION_OWNED');
    }
    if (error instanceof PushSubscriptionLimitError) {
      throw new HttpError(
        429,
        'Máximo cinco dispositivos con avisos por usuario',
        'PUSH_SUBSCRIPTION_LIMIT',
      );
    }
    throw error;
  }
});

// Recovery endpoint for a browser that lost the local database ID but still
// owns the browser PushSubscription object.
notificationsRouter.delete('/push-subscriptions/current', async (req, res) => {
  const organizationId = requireOrganization(req);
  const body = currentSubscriptionSchema.parse(req.body);
  const endpointHash = pushEndpointHash(body.endpoint);
  const removed = await withTransaction(async (client) => {
    const existing = await client.query<{ id: string }>(
      `SELECT id
       FROM push_subscriptions
       WHERE endpoint_hash = $1 AND organization_id = $2 AND user_id = $3
       FOR UPDATE`,
      [endpointHash, organizationId, req.user!.id],
    );
    const id = existing.rows[0]?.id;
    if (!id) return false;
    await deactivatePushSubscription(client, {
      organizationId,
      userId: req.user!.id,
      subscriptionId: id,
    });
    await recordAudit(
      {
        organizationId,
        actorUserId: req.user!.id,
        action: 'push_subscription.disabled',
        entityType: 'push_subscription',
        entityId: id,
      },
      client,
    );
    return true;
  });
  if (!removed) throw notFound('Suscripción no encontrada');
  res.status(204).end();
});

notificationsRouter.delete('/push-subscriptions/:id', async (req, res) => {
  const organizationId = requireOrganization(req);
  const subscriptionId = z.string().uuid().parse(req.params.id);
  const removed = await withTransaction(async (client) => {
    const found = await deactivatePushSubscription(client, {
      organizationId,
      userId: req.user!.id,
      subscriptionId,
    });
    if (found) {
      await recordAudit(
        {
          organizationId,
          actorUserId: req.user!.id,
          action: 'push_subscription.disabled',
          entityType: 'push_subscription',
          entityId: subscriptionId,
        },
        client,
      );
    }
    return found;
  });
  if (!removed) throw notFound('Suscripción no encontrada');
  res.status(204).end();
});
