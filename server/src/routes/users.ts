import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { query, queryOne } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';

export const usersRouter = Router();
usersRouter.use(requireAuth, requireAdmin);

const PUBLIC_COLS = `id, email, role, name, active, created_at`;

usersRouter.get('/', async (_req, res) => {
  res.json(await query(`SELECT ${PUBLIC_COLS} FROM users ORDER BY created_at`));
});

const createSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'Mínimo 8 caracteres'),
  role: z.enum(['admin', 'supervisor']),
  name: z.string().trim().min(1),
});

usersRouter.post('/', async (req, res) => {
  const body = createSchema.parse(req.body);
  const row = await queryOne(
    `INSERT INTO users (email, password_hash, role, name)
     VALUES (lower($1), $2, $3, $4) RETURNING ${PUBLIC_COLS}`,
    [body.email, await bcrypt.hash(body.password, 10), body.role, body.name]
  );
  res.status(201).json(row);
});

const patchSchema = z
  .object({
    name: z.string().trim().min(1),
    role: z.enum(['admin', 'supervisor']),
    active: z.boolean(),
    password: z.string().min(8),
  })
  .partial();

usersRouter.patch('/:id', async (req, res) => {
  const body = patchSchema.parse(req.body);
  if (req.params.id === req.user!.id && (body.active === false || body.role === 'supervisor')) {
    throw badRequest('No puedes desactivarte ni quitarte el rol admin a ti mismo');
  }
  const sets: string[] = [];
  const params: unknown[] = [];
  if (body.name !== undefined) {
    params.push(body.name);
    sets.push(`name = $${params.length}`);
  }
  if (body.role !== undefined) {
    params.push(body.role);
    sets.push(`role = $${params.length}`);
  }
  if (body.active !== undefined) {
    params.push(body.active);
    sets.push(`active = $${params.length}`);
  }
  if (body.password !== undefined) {
    params.push(await bcrypt.hash(body.password, 10));
    sets.push(`password_hash = $${params.length}`);
  }
  if (!sets.length) throw badRequest('Nada que actualizar');
  params.push(req.params.id);
  const row = await queryOne(
    `UPDATE users SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING ${PUBLIC_COLS}`,
    params
  );
  if (!row) throw notFound('Usuario no encontrado');
  // Al desactivar, sus refresh tokens dejan de servir
  if (body.active === false) {
    await query(`UPDATE refresh_tokens SET revoked = true WHERE user_id = $1`, [req.params.id]);
  }
  res.json(row);
});
