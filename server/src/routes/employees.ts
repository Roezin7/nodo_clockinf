import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import multer from 'multer';
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
import { storage } from '../storage.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

export const employeesRouter = Router();
employeesRouter.use(requireAuth, requireRole('admin', 'foreman', 'accountant'));

export interface EmployeeRow {
  id: string;
  organization_id: string;
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

const SAFE_COLS = `id, organization_id, employee_number, full_name, default_shift_id,
  active, hired_at, deactivated_at, created_at`;
const ADMIN_COLS = `id, organization_id, employee_number, full_name, social_security, phone,
  enrollment_photo_key, default_shift_id, active, hired_at, deactivated_at, created_at`;

/** PIN aleatorio de 4 dígitos, imprimible para la credencial. */
export function generatePin(): string {
  return crypto.randomInt(0, 10000).toString().padStart(4, '0');
}

employeesRouter.get('/', async (req, res) => {
  const organizationId = requireOrganization(req);
  const active = req.query.active as string | undefined;
  const search = (req.query.search as string | undefined)?.trim();
  const where = ['organization_id = $1'];
  const params: unknown[] = [organizationId];
  if (active === 'true' || active === 'false') {
    params.push(active === 'true');
    where.push(`active = $${params.length}`);
  }
  if (search) {
    params.push(`%${search}%`);
    where.push(`(full_name ILIKE $${params.length} OR employee_number::text ILIKE $${params.length})`);
  }
  const cols = req.user!.role === 'admin' ? ADMIN_COLS : SAFE_COLS;
  res.json(
    await query(
      `SELECT ${cols} FROM employees WHERE ${where.join(' AND ')} ORDER BY employee_number`,
      params
    )
  );
});

employeesRouter.get('/:id', async (req, res) => {
  const organizationId = requireOrganization(req);
  const admin = req.user!.role === 'admin';
  const row = await queryOne<EmployeeRow>(
    `SELECT ${admin ? ADMIN_COLS : SAFE_COLS}
     FROM employees WHERE id = $1 AND organization_id = $2`,
    [req.params.id, organizationId]
  );
  if (!row) throw notFound('Empleado no encontrado');
  res.json({
    ...row,
    enrollment_photo_url:
      admin && row.enrollment_photo_key ? await storage.viewUrl(row.enrollment_photo_key) : undefined,
  });
});

/** Foto de enrolamiento. Se conserva solo durante la relación activa. */
employeesRouter.post('/:id/photo', requireAdmin, upload.single('photo'), async (req, res) => {
  if (!req.file) throw badRequest('Falta archivo photo');
  const organizationId = requireOrganization(req);
  const emp = await queryOne<{ id: string }>(
    `SELECT id FROM employees WHERE id = $1 AND organization_id = $2`,
    [req.params.id, organizationId]
  );
  if (!emp) throw notFound('Empleado no encontrado');
  const key = `${organizationId}/enrollment/${emp.id}.jpg`;
  await storage.put(key, req.file.buffer, req.file.mimetype || 'image/jpeg');
  await query(
    `UPDATE employees SET enrollment_photo_key = $1 WHERE id = $2 AND organization_id = $3`,
    [key, emp.id, organizationId]
  );
  await recordAudit({
    organizationId,
    actorUserId: req.user!.id,
    action: 'employee.enrollment_photo_updated',
    entityType: 'employee',
    entityId: emp.id,
  });
  res.json({ ok: true, photo_key: key, photo_url: await storage.viewUrl(key) });
});

const createSchema = z.object({
  full_name: z.string().trim().min(1),
  social_security: z.string().trim().optional().nullable(),
  phone: z.string().trim().optional().nullable(),
  default_shift_id: z.string().uuid().optional().nullable(),
  hired_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  pin: z.string().regex(/^\d{4}$/).optional(),
  hourly_rate: z.coerce.number().nonnegative().optional(),
});

employeesRouter.post('/', requireAdmin, async (req, res) => {
  const organizationId = requireOrganization(req);
  const body = createSchema.parse(req.body);
  const pin = body.pin ?? generatePin();
  const row = await queryOne<{ id: string; employee_number: number }>(
    `INSERT INTO employees
       (organization_id, full_name, social_security, phone, default_shift_id, hired_at, pin_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${ADMIN_COLS}`,
    [
      organizationId,
      body.full_name,
      body.social_security ?? null,
      body.phone ?? null,
      body.default_shift_id ?? null,
      body.hired_at ?? null,
      await bcrypt.hash(pin, 10),
    ]
  );
  if (body.hourly_rate !== undefined) {
    await query(
      `INSERT INTO employee_rates
       (organization_id, employee_id, hourly_rate, effective_from, created_by)
       VALUES ($1, $2, $3, COALESCE($4::date, current_date), $5)`,
      [organizationId, row!.id, body.hourly_rate, body.hired_at ?? null, req.user!.id]
    );
  }
  await recordAudit({
    organizationId,
    actorUserId: req.user!.id,
    action: 'employee.created',
    entityType: 'employee',
    entityId: row!.id,
  });
  res.status(201).json({ ...row, pin });
});

const patchSchema = createSchema.partial().omit({ pin: true, hourly_rate: true });

employeesRouter.patch('/:id', requireAdmin, async (req, res) => {
  const organizationId = requireOrganization(req);
  const body = patchSchema.parse(req.body);
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [col, value] of Object.entries(body)) {
    params.push(value);
    sets.push(`${col} = $${params.length}`);
  }
  if (!sets.length) throw badRequest('Nada que actualizar');
  params.push(req.params.id, organizationId);
  const row = await queryOne<{ id: string }>(
    `UPDATE employees SET ${sets.join(', ')}
     WHERE id = $${params.length - 1} AND organization_id = $${params.length}
     RETURNING ${ADMIN_COLS}`,
    params
  );
  if (!row) throw notFound('Empleado no encontrado');
  await recordAudit({
    organizationId,
    actorUserId: req.user!.id,
    action: 'employee.updated',
    entityType: 'employee',
    entityId: row.id,
    metadata: { fields: Object.keys(body) },
  });
  res.json(row);
});

employeesRouter.post('/:id/deactivate', requireAdmin, async (req, res) => {
  const organizationId = requireOrganization(req);
  const row = await queryOne<{ id: string; enrollment_photo_key: string | null }>(
    `UPDATE employees SET active = false, deactivated_at = current_date
     WHERE id = $1 AND organization_id = $2 RETURNING ${ADMIN_COLS}`,
    [req.params.id, organizationId]
  );
  if (!row) throw notFound('Empleado no encontrado');
  if (row.enrollment_photo_key) {
    try {
      await storage.remove(row.enrollment_photo_key);
      await query(
        `UPDATE employees SET enrollment_photo_key = NULL WHERE id = $1 AND organization_id = $2`,
        [req.params.id, organizationId]
      );
    } catch (err) {
      console.error('No se pudo borrar la foto de enrolamiento:', err);
    }
  }
  await recordAudit({
    organizationId,
    actorUserId: req.user!.id,
    action: 'employee.deactivated',
    entityType: 'employee',
    entityId: row.id,
  });
  res.json({ ...row, enrollment_photo_key: null });
});

employeesRouter.post('/:id/reactivate', requireAdmin, async (req, res) => {
  const organizationId = requireOrganization(req);
  const row = await queryOne<{ id: string }>(
    `UPDATE employees SET active = true, deactivated_at = NULL
     WHERE id = $1 AND organization_id = $2 RETURNING ${ADMIN_COLS}`,
    [req.params.id, organizationId]
  );
  if (!row) throw notFound('Empleado no encontrado');
  await recordAudit({
    organizationId,
    actorUserId: req.user!.id,
    action: 'employee.reactivated',
    entityType: 'employee',
    entityId: row.id,
  });
  res.json(row);
});

employeesRouter.post('/:id/reset-pin', requireAdmin, async (req, res) => {
  const organizationId = requireOrganization(req);
  const pin = generatePin();
  const row = await queryOne<{ id: string }>(
    `UPDATE employees SET pin_hash = $1 WHERE id = $2 AND organization_id = $3 RETURNING id`,
    [await bcrypt.hash(pin, 10), req.params.id, organizationId]
  );
  if (!row) throw notFound('Empleado no encontrado');
  await recordAudit({
    organizationId,
    actorUserId: req.user!.id,
    action: 'employee.pin_reset',
    entityType: 'employee',
    entityId: row.id,
  });
  res.json({ id: row.id, pin });
});

const rateSchema = z.object({
  hourly_rate: z.coerce.number().nonnegative(),
  effective_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  effective_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
});

employeesRouter.get('/:id/rates', requireAdmin, async (req, res) => {
  const organizationId = requireOrganization(req);
  const employee = await queryOne(
    `SELECT id FROM employees WHERE id = $1 AND organization_id = $2`,
    [req.params.id, organizationId]
  );
  if (!employee) throw notFound('Empleado no encontrado');
  res.json(
    await query(
      `SELECT id, employee_id, hourly_rate, effective_from, effective_to, created_at
       FROM employee_rates
       WHERE employee_id = $1 AND organization_id = $2
       ORDER BY effective_from DESC`,
      [req.params.id, organizationId]
    )
  );
});

employeesRouter.post('/:id/rates', requireAdmin, async (req, res) => {
  const organizationId = requireOrganization(req);
  const body = rateSchema.parse(req.body);
  const employee = await queryOne(
    `SELECT id FROM employees WHERE id = $1 AND organization_id = $2`,
    [req.params.id, organizationId]
  );
  if (!employee) throw notFound('Empleado no encontrado');
  const row = await queryOne<{ id: string }>(
    `INSERT INTO employee_rates
       (organization_id, employee_id, hourly_rate, effective_from, effective_to, created_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [
      organizationId,
      req.params.id,
      body.hourly_rate,
      body.effective_from,
      body.effective_to ?? null,
      req.user!.id,
    ]
  );
  await recordAudit({
    organizationId,
    actorUserId: req.user!.id,
    action: 'employee.rate_created',
    entityType: 'employee_rate',
    entityId: row!.id,
    metadata: { employee_id: req.params.id, effective_from: body.effective_from },
  });
  res.status(201).json(row);
});
