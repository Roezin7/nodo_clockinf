import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import multer from 'multer';
import { z } from 'zod';
import { query, queryOne } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { storage } from '../storage.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

export const employeesRouter = Router();
employeesRouter.use(requireAuth);

export interface EmployeeRow {
  id: string;
  employee_number: number;
  full_name: string;
  social_security: string | null;
  phone: string | null;
  pin_hash: string;
  enrollment_photo_key: string | null;
  default_shift_id: string | null;
  active: boolean;
  hired_at: string | null;
  deactivated_at: string | null;
  created_at: string;
}

const PUBLIC_COLS = `id, employee_number, full_name, social_security, phone,
  enrollment_photo_key, default_shift_id, active, hired_at, deactivated_at, created_at`;

/** PIN aleatorio de 4 dígitos, imprimible para la credencial. */
export function generatePin(): string {
  return crypto.randomInt(0, 10000).toString().padStart(4, '0');
}

employeesRouter.get('/', async (req, res) => {
  const active = req.query.active as string | undefined;
  const search = (req.query.search as string | undefined)?.trim();
  const where: string[] = [];
  const params: unknown[] = [];
  if (active === 'true' || active === 'false') {
    params.push(active === 'true');
    where.push(`active = $${params.length}`);
  }
  if (search) {
    params.push(`%${search}%`);
    where.push(`(full_name ILIKE $${params.length} OR employee_number::text ILIKE $${params.length})`);
  }
  const rows = await query(
    `SELECT ${PUBLIC_COLS} FROM employees
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY employee_number`,
    params
  );
  res.json(rows);
});

employeesRouter.get('/:id', async (req, res) => {
  const row = await queryOne<{ enrollment_photo_key: string | null }>(
    `SELECT ${PUBLIC_COLS} FROM employees WHERE id = $1`,
    [req.params.id]
  );
  if (!row) throw notFound('Empleado no encontrado');
  res.json({
    ...row,
    enrollment_photo_url: row.enrollment_photo_key ? await storage.viewUrl(row.enrollment_photo_key) : null,
  });
});

/** Foto de enrolamiento (referencia para verificación facial). Se conserva mientras el empleado esté activo. */
employeesRouter.post('/:id/photo', requireAdmin, upload.single('photo'), async (req, res) => {
  if (!req.file) throw badRequest('Falta archivo photo');
  const emp = await queryOne<{ id: string }>(`SELECT id FROM employees WHERE id = $1`, [req.params.id]);
  if (!emp) throw notFound('Empleado no encontrado');
  const key = `enrollment/${emp.id}.jpg`;
  await storage.put(key, req.file.buffer, req.file.mimetype || 'image/jpeg');
  await query(`UPDATE employees SET enrollment_photo_key = $1 WHERE id = $2`, [key, emp.id]);
  res.json({ ok: true, photo_key: key, photo_url: await storage.viewUrl(key) });
});

const createSchema = z.object({
  full_name: z.string().trim().min(1),
  social_security: z.string().trim().optional().nullable(),
  phone: z.string().trim().optional().nullable(),
  default_shift_id: z.string().uuid().optional().nullable(),
  hired_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  pin: z.string().regex(/^\d{4}$/).optional(),
});

employeesRouter.post('/', requireAdmin, async (req, res) => {
  const body = createSchema.parse(req.body);
  const pin = body.pin ?? generatePin();
  const pinHash = await bcrypt.hash(pin, 10);
  const row = await queryOne<{ id: string; employee_number: number }>(
    `INSERT INTO employees (full_name, social_security, phone, default_shift_id, hired_at, pin_hash)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${PUBLIC_COLS}`,
    [body.full_name, body.social_security ?? null, body.phone ?? null,
     body.default_shift_id ?? null, body.hired_at ?? null, pinHash]
  );
  // El PIN en claro se devuelve UNA sola vez, para imprimirlo; solo se guarda el hash.
  res.status(201).json({ ...row, pin });
});

const patchSchema = createSchema.partial().omit({ pin: true });

employeesRouter.patch('/:id', requireAdmin, async (req, res) => {
  const body = patchSchema.parse(req.body);
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [col, value] of Object.entries(body)) {
    params.push(value);
    sets.push(`${col} = $${params.length}`);
  }
  if (!sets.length) {
    res.json(await queryOne(`SELECT ${PUBLIC_COLS} FROM employees WHERE id = $1`, [req.params.id]));
    return;
  }
  params.push(req.params.id);
  const row = await queryOne(
    `UPDATE employees SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING ${PUBLIC_COLS}`,
    params
  );
  if (!row) throw notFound('Empleado no encontrado');
  res.json(row);
});

employeesRouter.post('/:id/deactivate', requireAdmin, async (req, res) => {
  const row = await queryOne(
    `UPDATE employees SET active = false, deactivated_at = current_date
     WHERE id = $1 RETURNING ${PUBLIC_COLS}`,
    [req.params.id]
  );
  if (!row) throw notFound('Empleado no encontrado');
  res.json(row);
});

employeesRouter.post('/:id/reactivate', requireAdmin, async (req, res) => {
  const row = await queryOne(
    `UPDATE employees SET active = true, deactivated_at = NULL
     WHERE id = $1 RETURNING ${PUBLIC_COLS}`,
    [req.params.id]
  );
  if (!row) throw notFound('Empleado no encontrado');
  res.json(row);
});

employeesRouter.post('/:id/reset-pin', requireAdmin, async (req, res) => {
  const pin = generatePin();
  const pinHash = await bcrypt.hash(pin, 10);
  const row = await queryOne<{ id: string }>(
    `UPDATE employees SET pin_hash = $1 WHERE id = $2 RETURNING id`,
    [pinHash, req.params.id]
  );
  if (!row) throw notFound('Empleado no encontrado');
  res.json({ id: row.id, pin });
});
