import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { query, queryOne, withTransaction } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { requireAdmin, requireAuth, requireOrganization } from '../middleware/auth.js';
import { recordAudit } from '../services/auditService.js';

export const usersRouter = Router();
usersRouter.use(requireAuth, requireAdmin);

const PUBLIC_COLS = `u.id, u.email, u.role, u.name, u.organization_id, u.active, u.created_at`;
const customerRole = z.enum(['admin', 'foreman', 'accountant']);

interface UserWithPlants {
  id: string;
  email: string;
  role: 'admin' | 'foreman' | 'accountant';
  name: string;
  organization_id: string;
  active: boolean;
  created_at: string;
  plant_ids: string[];
}

usersRouter.get('/', async (req, res) => {
  const organizationId = requireOrganization(req);
  res.json(
    await query<UserWithPlants>(
      `SELECT ${PUBLIC_COLS},
              COALESCE(array_agg(a.plant_id) FILTER (WHERE a.plant_id IS NOT NULL), '{}') AS plant_ids
       FROM users u
       LEFT JOIN user_plant_access a ON a.user_id = u.id AND a.organization_id = u.organization_id
       WHERE u.organization_id = $1
       GROUP BY u.id
       ORDER BY u.created_at`,
      [organizationId]
    )
  );
});

const createSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'Mínimo 8 caracteres'),
  role: customerRole,
  name: z.string().trim().min(1),
  plant_ids: z.array(z.string().uuid()).default([]),
});

async function validatePlantAssignments(
  organizationId: string,
  role: z.infer<typeof customerRole>,
  plantIds: string[],
  excludingUserId?: string
): Promise<void> {
  const unique = [...new Set(plantIds)];
  if (role === 'foreman' && unique.length !== 1) {
    throw badRequest('Cada foreman debe estar asignado exactamente a una planta');
  }
  if (role !== 'foreman' && unique.length) {
    throw badRequest('Solo los foremen requieren asignación de planta');
  }
  if (!unique.length) return;

  const valid = await query<{ id: string }>(
    `SELECT id FROM plants WHERE organization_id = $1 AND active AND id = ANY($2::uuid[])`,
    [organizationId, unique]
  );
  if (valid.length !== unique.length) throw badRequest('Una planta no pertenece a la organización');

  const occupied = await queryOne<{ name: string }>(
    `SELECT u.name
     FROM user_plant_access a
     JOIN users u ON u.id = a.user_id
     WHERE a.organization_id = $1 AND a.plant_id = $2
       AND u.role = 'foreman' AND u.active
       AND ($3::uuid IS NULL OR u.id <> $3)`,
    [organizationId, unique[0], excludingUserId ?? null]
  );
  if (occupied) throw conflict(`La planta ya tiene un foreman activo: ${occupied.name}`);
}

usersRouter.post('/', async (req, res) => {
  const organizationId = requireOrganization(req);
  const body = createSchema.parse(req.body);
  await validatePlantAssignments(organizationId, body.role, body.plant_ids);

  const row = await withTransaction(async (client) => {
    const inserted = await client.query<UserWithPlants>(
      `INSERT INTO users (email, password_hash, role, name, organization_id)
       VALUES (lower($1), $2, $3, $4, $5)
       RETURNING id, email, role, name, organization_id, active, created_at`,
      [body.email, await bcrypt.hash(body.password, 10), body.role, body.name, organizationId]
    );
    const user = inserted.rows[0]!;
    for (const plantId of body.plant_ids) {
      await client.query(
        `INSERT INTO user_plant_access (organization_id, user_id, plant_id) VALUES ($1, $2, $3)`,
        [organizationId, user.id, plantId]
      );
    }
    await recordAudit(
      {
        organizationId,
        actorUserId: req.user!.id,
        action: 'user.created',
        entityType: 'user',
        entityId: user.id,
        metadata: { role: body.role, plant_ids: body.plant_ids },
      },
      client
    );
    return { ...user, plant_ids: body.plant_ids };
  });
  res.status(201).json(row);
});

const patchSchema = z
  .object({
    name: z.string().trim().min(1),
    role: customerRole,
    active: z.boolean(),
    password: z.string().min(8),
    plant_ids: z.array(z.string().uuid()),
  })
  .partial();

usersRouter.patch('/:id', async (req, res) => {
  const organizationId = requireOrganization(req);
  const body = patchSchema.parse(req.body);
  const existing = await queryOne<UserWithPlants>(
    `SELECT ${PUBLIC_COLS},
            COALESCE(array_agg(a.plant_id) FILTER (WHERE a.plant_id IS NOT NULL), '{}') AS plant_ids
     FROM users u
     LEFT JOIN user_plant_access a ON a.user_id = u.id
     WHERE u.id = $1 AND u.organization_id = $2
     GROUP BY u.id`,
    [req.params.id, organizationId]
  );
  if (!existing) throw notFound('Usuario no encontrado');

  const nextRole = body.role ?? existing.role;
  const nextPlants = body.plant_ids ?? existing.plant_ids;
  await validatePlantAssignments(organizationId, nextRole, nextPlants, existing.id);

  if (existing.id === req.user!.id && (body.active === false || (body.role && body.role !== 'admin'))) {
    throw badRequest('No puedes desactivarte ni quitarte el rol admin a ti mismo');
  }
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [column, value] of Object.entries({ name: body.name, role: body.role, active: body.active })) {
    if (value === undefined) continue;
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  }
  if (body.password !== undefined) {
    params.push(await bcrypt.hash(body.password, 10));
    sets.push(`password_hash = $${params.length}`);
  }
  if (!sets.length && body.plant_ids === undefined) throw badRequest('Nada que actualizar');

  const row = await withTransaction(async (client) => {
    if (sets.length) {
      params.push(existing.id, organizationId);
      await client.query(
        `UPDATE users SET ${sets.join(', ')}
         WHERE id = $${params.length - 1} AND organization_id = $${params.length}`,
        params
      );
    }
    await client.query(`DELETE FROM user_plant_access WHERE user_id = $1 AND organization_id = $2`, [
      existing.id,
      organizationId,
    ]);
    for (const plantId of nextPlants) {
      await client.query(
        `INSERT INTO user_plant_access (organization_id, user_id, plant_id) VALUES ($1, $2, $3)`,
        [organizationId, existing.id, plantId]
      );
    }
    if (body.active === false) {
      await client.query(`UPDATE refresh_tokens SET revoked = true WHERE user_id = $1`, [existing.id]);
    }
    await recordAudit(
      {
        organizationId,
        actorUserId: req.user!.id,
        action: 'user.updated',
        entityType: 'user',
        entityId: existing.id,
        metadata: { fields: Object.keys(body), role: nextRole, plant_ids: nextPlants },
      },
      client
    );
    const updated = await client.query<UserWithPlants>(
      `SELECT id, email, role, name, organization_id, active, created_at
       FROM users WHERE id = $1 AND organization_id = $2`,
      [existing.id, organizationId]
    );
    return { ...updated.rows[0], plant_ids: nextPlants };
  });
  res.json(row);
});
