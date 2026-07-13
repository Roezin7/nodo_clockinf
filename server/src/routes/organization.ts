import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import {
  requireAdmin,
  requireAuth,
  requireOrganization,
  requireRole,
} from '../middleware/auth.js';
import { recordAudit } from '../services/auditService.js';
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

export const devicesRouter = Router();
devicesRouter.use(requireAuth, requireRole('admin', 'foreman'));

devicesRouter.get('/', async (req, res) => {
  const organizationId = requireOrganization(req);
  const plantIds = await accessiblePlantIds(req.user!);
  res.json(
    await query(
      `SELECT d.id, d.organization_id, d.plant_id, p.name AS plant_name,
              d.name, d.public_id, d.active, d.last_seen_at, d.last_sync_at,
              d.app_version, d.created_at
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
  const row = await queryOne<{ id: string }>(
    `INSERT INTO devices (organization_id, plant_id, name, token_hash)
     VALUES ($1, $2, $3, $4)
     RETURNING id, organization_id, plant_id, name, public_id, active, created_at`,
    [organizationId, body.plant_id, body.name, tokenHash]
  );
  await recordAudit({
    organizationId,
    actorUserId: req.user!.id,
    action: 'device.created',
    entityType: 'device',
    entityId: row!.id,
    metadata: { plant_id: body.plant_id, name: body.name },
  });
  res.status(201).json({ ...row, enrollment_token: token });
});

devicesRouter.post('/:id/revoke', requireAdmin, async (req, res) => {
  const organizationId = requireOrganization(req);
  const body = z.object({ reason: z.string().trim().min(3) }).parse(req.body);
  const row = await queryOne<{ id: string }>(
    `UPDATE devices SET active = false
     WHERE id = $1 AND organization_id = $2 RETURNING id`,
    [req.params.id, organizationId]
  );
  if (!row) throw notFound('Dispositivo no encontrado');
  await recordAudit({
    organizationId,
    actorUserId: req.user!.id,
    action: 'device.revoked',
    entityType: 'device',
    entityId: row.id,
    reason: body.reason,
  });
  res.json({ ok: true });
});
