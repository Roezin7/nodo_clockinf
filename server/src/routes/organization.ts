import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, withTransaction } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import {
  requireAdmin,
  requireAuth,
  requireOrganization,
  requireRole,
} from '../middleware/auth.js';
import { recordAudit } from '../services/auditService.js';
import { deviceRevocationReasons } from '../services/deviceHealth.js';
import { ALLOWED_TIMEZONE_IDS } from '../services/settingsService.js';
import { accessiblePlantIds, assertPlantAccess } from '../services/tenantService.js';

export const organizationRouter = Router();
organizationRouter.use(requireAuth);

organizationRouter.get('/', async (req, res) => {
  const organizationId = requireOrganization(req);
  const organization = await queryOne(
    `SELECT id, name, slug, timezone, active, created_at
     FROM organizations WHERE id = $1 AND active`,
    [organizationId]
  );
  if (!organization) throw notFound('Organización no encontrada');
  res.json(organization);
});

organizationRouter.patch('/', requireAdmin, async (req, res) => {
  const organizationId = requireOrganization(req);
  const body = z
    .object({
      name: z.string().trim().min(1).max(160),
      timezone: z.enum(ALLOWED_TIMEZONE_IDS),
    })
    .partial()
    .parse(req.body);
  if (!Object.keys(body).length) throw badRequest('Nada que actualizar');
  const row = await queryOne(
    `UPDATE organizations
     SET name = COALESCE($2, name), timezone = COALESCE($3, timezone)
     WHERE id = $1
     RETURNING id, name, slug, timezone, active, created_at`,
    [organizationId, body.name ?? null, body.timezone ?? null]
  );
  await recordAudit({
    organizationId,
    actorUserId: req.user!.id,
    action: 'organization.updated',
    entityType: 'organization',
    entityId: organizationId,
    metadata: body,
  });
  res.json(row);
});

export const plantsRouter = Router();
plantsRouter.use(requireAuth);

plantsRouter.get('/', async (req, res) => {
  const organizationId = requireOrganization(req);
  const plantIds = await accessiblePlantIds(req.user!);
  res.json(
    await query(
      `SELECT id, organization_id, code, name, active, created_at
       FROM plants
       WHERE organization_id = $1
         AND ($2::boolean OR id = ANY($3::uuid[]))
       ORDER BY code`,
      [organizationId, req.user!.role === 'admin' || req.user!.role === 'accountant', plantIds]
    )
  );
});

const plantSchema = z.object({
  code: z.string().trim().min(1).max(20).transform((value) => value.toUpperCase()),
  name: z.string().trim().min(1).max(120),
});

plantsRouter.post('/', requireAdmin, async (req, res) => {
  const organizationId = requireOrganization(req);
  const body = plantSchema.parse(req.body);
  const row = await queryOne<{ id: string }>(
    `INSERT INTO plants (organization_id, code, name)
     VALUES ($1, $2, $3) RETURNING *`,
    [organizationId, body.code, body.name]
  );
  await recordAudit({
    organizationId,
    actorUserId: req.user!.id,
    action: 'plant.created',
    entityType: 'plant',
    entityId: row!.id,
    metadata: body,
  });
  res.status(201).json(row);
});

plantsRouter.patch('/:id', requireAdmin, async (req, res) => {
  const organizationId = requireOrganization(req);
  const body = plantSchema.partial().extend({ active: z.boolean().optional() }).parse(req.body);
  if (!Object.keys(body).length) throw badRequest('Nada que actualizar');
  const row = await queryOne<{ id: string }>(
    `UPDATE plants
     SET code = COALESCE($3, code), name = COALESCE($4, name), active = COALESCE($5, active)
     WHERE id = $1 AND organization_id = $2
     RETURNING *`,
    [req.params.id, organizationId, body.code ?? null, body.name ?? null, body.active ?? null]
  );
  if (!row) throw notFound('Planta no encontrada');
  await recordAudit({
    organizationId,
    actorUserId: req.user!.id,
    action: 'plant.updated',
    entityType: 'plant',
    entityId: row.id,
    metadata: body,
  });
  res.json(row);
});

plantsRouter.delete('/:id', requireAdmin, async (req, res) => {
  const organizationId = requireOrganization(req);
  const plant = await queryOne<{ id: string; name: string; active: boolean }>(
    `SELECT id, name, active FROM plants WHERE id = $1 AND organization_id = $2`,
    [req.params.id, organizationId],
  );
  if (!plant) throw notFound('Planta no encontrada');

  if (plant.active) {
    const activePlants = await queryOne<{ count: string }>(
      `SELECT count(*)::text AS count FROM plants WHERE organization_id = $1 AND active`,
      [organizationId],
    );
    if (Number(activePlants!.count) <= 1) {
      throw conflict('Debe conservar al menos una planta activa', 'last_active_plant');
    }
  }

  const usage = await queryOne<{ source: string }>(
    `SELECT source FROM (
       SELECT 'usuarios asignados' AS source FROM user_plant_access WHERE plant_id = $1
       UNION ALL SELECT 'checadas' FROM punches WHERE plant_id = $1
       UNION ALL SELECT 'horas manuales' FROM manual_time_entries WHERE plant_id = $1
       UNION ALL SELECT 'asignaciones de área' FROM daily_area_assignments WHERE plant_id = $1
       UNION ALL SELECT 'checadores' FROM devices WHERE plant_id = $1
       UNION ALL SELECT 'recibos de checador' FROM device_event_receipts WHERE plant_id = $1
       UNION ALL SELECT 'sesiones biométricas' FROM identity_sessions WHERE plant_id = $1
       UNION ALL SELECT 'intentos biométricos' FROM identity_attempts WHERE plant_id = $1
       UNION ALL SELECT 'revisiones biométricas' FROM identity_review_decisions WHERE plant_id = $1
       UNION ALL SELECT 'incidencias operativas' FROM operational_exception_plants WHERE plant_id = $1
     ) references_found
     LIMIT 1`,
    [plant.id],
  );
  if (usage) {
    throw conflict(
      `No se puede eliminar ${plant.name} porque tiene ${usage.source}. Desactívala para conservar el historial.`,
      'plant_has_history',
      { source: usage.source },
    );
  }

  try {
    await withTransaction(async (client) => {
      await client.query(`DELETE FROM plants WHERE id = $1 AND organization_id = $2`, [plant.id, organizationId]);
      await recordAudit({
        organizationId,
        actorUserId: req.user!.id,
        action: 'plant.deleted',
        entityType: 'plant',
        entityId: plant.id,
        metadata: { name: plant.name },
      }, client);
    });
  } catch (error) {
    if (error && typeof error === 'object' && (error as { code?: string }).code === '23503') {
      throw conflict('No se puede eliminar una planta con historial o relaciones activas. Desactívala en su lugar.', 'plant_has_history');
    }
    throw error;
  }
  res.status(204).end();
});

export const devicesRouter = Router();
devicesRouter.use(requireAuth, requireRole('admin', 'foreman'));

function databaseConstraint(error: unknown): string | undefined {
  return error && typeof error === 'object'
    ? (error as { constraint?: string }).constraint
    : undefined;
}

devicesRouter.get('/', async (req, res) => {
  const organizationId = requireOrganization(req);
  const plantIds = await accessiblePlantIds(req.user!);
  res.json(
    await query(
      `SELECT d.id, d.organization_id, d.plant_id, p.name AS plant_name,
              d.name, d.public_id, d.active, d.last_seen_at, d.last_sync_at,
              d.enrolled_at, d.last_heartbeat_at, d.pending_event_count,
              d.rejected_event_count, d.app_version,
              d.camera_status, d.storage_status, d.clock_skew_seconds,
              d.last_error, d.created_at
       FROM devices d JOIN plants p ON p.id = d.plant_id
       WHERE d.organization_id = $1
         AND ($2::boolean OR d.plant_id = ANY($3::uuid[]))
       ORDER BY p.code, d.name`,
      [organizationId, req.user!.role === 'admin', plantIds]
    )
  );
});

devicesRouter.post('/', requireAdmin, async (req, res) => {
  const organizationId = requireOrganization(req);
  const body = z
    .object({ plant_id: z.string().uuid(), name: z.string().trim().min(1).max(100) })
    .parse(req.body);
  await assertPlantAccess(req, body.plant_id);
  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  let row: Record<string, unknown>;
  try {
    row = await withTransaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO devices (organization_id, plant_id, name, token_hash)
         VALUES ($1, $2, $3, $4)
         RETURNING id, organization_id, plant_id, name, public_id, active,
                   enrolled_at, created_at`,
        [organizationId, body.plant_id, body.name, tokenHash]
      );
      await recordAudit(
        {
          organizationId,
          actorUserId: req.user!.id,
          action: 'device.created',
          entityType: 'device',
          entityId: inserted.rows[0]!.id as string,
          metadata: { plant_id: body.plant_id, name: body.name },
        },
        client
      );
      return inserted.rows[0] as Record<string, unknown>;
    });
  } catch (error) {
    if (databaseConstraint(error) === 'devices_plant_id_name_key') {
      throw conflict('Ya existe un dispositivo con ese nombre en la planta', 'device_name_conflict');
    }
    throw error;
  }
  res.status(201).json({ ...row, enrollment_token: token });
});

devicesRouter.post('/:id/reissue', requireAdmin, async (req, res) => {
  const organizationId = requireOrganization(req);
  const body = z.object({ reason: z.string().trim().min(3) }).strict().parse(req.body);
  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const row = await withTransaction(async (client) => {
    const current = await client.query<{
      id: string;
      active: boolean;
      enrolled_at: Date | null;
      plant_id: string;
      name: string;
    }>(
      `SELECT id, active, enrolled_at, plant_id, name
       FROM devices
       WHERE id = $1 AND organization_id = $2
       FOR UPDATE`,
      [req.params.id, organizationId]
    );
    const device = current.rows[0];
    if (!device) throw notFound('Dispositivo no encontrado');
    if (!device.active) throw conflict('El dispositivo está revocado', 'device_inactive');
    if (device.enrolled_at) {
      throw conflict(
        'Un dispositivo enrolado debe revocarse; su credencial no puede reemitirse',
        'device_already_enrolled'
      );
    }
    const updated = await client.query(
      `UPDATE devices SET token_hash = $2
       WHERE id = $1
       RETURNING id, organization_id, plant_id, name, public_id, active,
                 enrolled_at, created_at`,
      [device.id, tokenHash]
    );
    await recordAudit(
      {
        organizationId,
        actorUserId: req.user!.id,
        action: 'device.enrollment_reissued',
        entityType: 'device',
        entityId: device.id,
        reason: body.reason,
        metadata: { plant_id: device.plant_id, name: device.name },
      },
      client
    );
    return updated.rows[0] as Record<string, unknown>;
  });
  res.status(201).json({ ...row, enrollment_token: token });
});

devicesRouter.post('/:id/revoke', requireAdmin, async (req, res) => {
  const organizationId = requireOrganization(req);
  const body = z
    .object({ reason: z.string().trim().min(3), force: z.boolean().default(false) })
    .parse(req.body);
  await withTransaction(async (client) => {
    const result = await client.query<{
      id: string;
      enrolled_at: Date | null;
      pending_event_count: number;
      rejected_event_count: number;
      last_heartbeat_at: Date | null;
      storage_status: 'unknown' | 'ready' | 'degraded' | 'unavailable';
    }>(
      `SELECT id, enrolled_at, pending_event_count, rejected_event_count,
              last_heartbeat_at, storage_status
       FROM devices
       WHERE id = $1 AND organization_id = $2
       FOR UPDATE`,
      [req.params.id, organizationId]
    );
    const device = result.rows[0];
    if (!device) throw notFound('Dispositivo no encontrado');
    const reasons = deviceRevocationReasons(device);
    const health = {
      enrolled: Boolean(device.enrolled_at),
      pending_event_count: device.pending_event_count,
      rejected_event_count: device.rejected_event_count,
      last_heartbeat_at: device.last_heartbeat_at,
      storage_status: device.storage_status,
    };
    if (reasons.length && !body.force) {
      throw conflict(
        'El dispositivo tiene estado local sin confirmar; resuelve los bloqueos o usa force',
        'device_has_pending_events',
        { reasons, health }
      );
    }
    await client.query(`UPDATE devices SET active = false WHERE id = $1`, [device.id]);
    await recordAudit(
      {
        organizationId,
        actorUserId: req.user!.id,
        action: 'device.revoked',
        entityType: 'device',
        entityId: device.id,
        reason: body.reason,
        metadata: {
          force: body.force,
          reasons,
          health,
        },
      },
      client
    );
  });
  res.json({ ok: true });
});
