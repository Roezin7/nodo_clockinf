import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, withTransaction } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { requireAuth, requireOrganization, requireRole } from '../middleware/auth.js';
import { recordAudit } from '../services/auditService.js';
import { accessiblePlantIds, assertPlantAccess } from '../services/tenantService.js';
import { ensurePeriodOpen } from '../services/payPeriodService.js';
import { getSettings } from '../services/settingsService.js';

export const manualTimeRouter = Router();
manualTimeRouter.use(requireAuth, requireRole('admin', 'foreman'));

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const listSchema = z.object({
  from: z.string().regex(DATE_RE).optional(),
  to: z.string().regex(DATE_RE).optional(),
  employee_id: z.string().uuid().optional(),
  plant_id: z.string().uuid().optional(),
  include_voided: z.enum(['true', 'false']).default('false'),
});

manualTimeRouter.get('/', async (req, res) => {
  const organizationId = requireOrganization(req);
  const filters = listSchema.parse(req.query);
  const where = ['m.organization_id = $1'];
  const params: unknown[] = [organizationId];

  if (req.user!.role === 'foreman') {
    params.push(await accessiblePlantIds(req.user!));
    where.push(`m.plant_id = ANY($${params.length}::uuid[])`);
  }
  for (const [column, value] of [
    ['employee_id', filters.employee_id],
    ['plant_id', filters.plant_id],
  ] as const) {
    if (!value) continue;
    params.push(value);
    where.push(`m.${column} = $${params.length}`);
  }
  if (filters.from) {
    params.push(filters.from);
    where.push(`m.work_date >= $${params.length}::date`);
  }
  if (filters.to) {
    params.push(filters.to);
    where.push(`m.work_date <= $${params.length}::date`);
  }
  if (filters.include_voided !== 'true') where.push('m.voided_at IS NULL');

  res.json(
    await query(
      `SELECT m.id, m.employee_id, e.employee_number, e.full_name, m.plant_id,
              p.name AS plant_name, m.work_date, m.duration_seconds::double precision, m.reason,
              m.created_by, u.name AS created_by_name, m.created_at,
              m.voided_at, m.voided_by, m.void_reason
       FROM manual_time_entries m
       JOIN employees e ON e.id = m.employee_id
       JOIN plants p ON p.id = m.plant_id
       JOIN users u ON u.id = m.created_by
       WHERE ${where.join(' AND ')}
       ORDER BY m.work_date DESC, m.created_at DESC`,
      params
    )
  );
});

const createSchema = z.object({
  employee_id: z.string().uuid(),
  plant_id: z.string().uuid(),
  work_date: z.string().regex(DATE_RE),
  hours: z.number().finite().positive(),
  reason: z.string().trim().min(3, 'La razón es obligatoria'),
});

manualTimeRouter.post('/', async (req, res) => {
  const organizationId = requireOrganization(req);
  const body = createSchema.parse(req.body);
  const durationSeconds = Math.round(body.hours * 3600);
  if (!Number.isSafeInteger(durationSeconds) || durationSeconds <= 0) {
    throw badRequest('La duración debe representar al menos un segundo');
  }
  await assertPlantAccess(req, body.plant_id);
  const employee = await queryOne<{ id: string }>(
    `SELECT id FROM employees WHERE id = $1 AND organization_id = $2 AND active`,
    [body.employee_id, organizationId]
  );
  if (!employee) throw notFound('Empleado activo no encontrado');

  const row = await withTransaction(async (client) => {
    const settings = await getSettings(organizationId);
    await ensurePeriodOpen(client, organizationId, body.work_date, settings.timezone);
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO manual_time_entries
         (organization_id, employee_id, plant_id, work_date, duration_seconds, reason, created_by)
       VALUES ($1, $2, $3, $4::date, $5, $6, $7)
       RETURNING id, organization_id, employee_id, plant_id, work_date,
                 duration_seconds::double precision AS duration_seconds,
                 reason, created_by, created_at, voided_at, voided_by, void_reason`,
      [
        organizationId,
        body.employee_id,
        body.plant_id,
        body.work_date,
        durationSeconds,
        body.reason,
        req.user!.id,
      ]
    );
    await recordAudit(
      {
        organizationId,
        actorUserId: req.user!.id,
        action: 'manual_time.created',
        entityType: 'manual_time_entry',
        entityId: inserted.rows[0]!.id,
        reason: body.reason,
        metadata: {
          employee_id: body.employee_id,
          plant_id: body.plant_id,
          work_date: body.work_date,
          duration_seconds: durationSeconds,
        },
      },
      client
    );
    return inserted.rows[0];
  });
  res.status(201).json(row);
});

manualTimeRouter.post('/:id/void', async (req, res) => {
  const organizationId = requireOrganization(req);
  const body = z.object({ reason: z.string().trim().min(3) }).parse(req.body);
  const entry = await queryOne<{ id: string; plant_id: string; work_date: string; voided_at: Date | null }>(
    `SELECT id, plant_id, work_date, voided_at FROM manual_time_entries
     WHERE id = $1 AND organization_id = $2`,
    [req.params.id, organizationId]
  );
  if (!entry) throw notFound('Horas manuales no encontradas');
  await assertPlantAccess(req, entry.plant_id);
  if (entry.voided_at) throw conflict('Estas horas manuales ya fueron anuladas');
  const settings = await getSettings(organizationId);

  await withTransaction(async (client) => {
    await ensurePeriodOpen(client, organizationId, entry.work_date, settings.timezone);
    const updated = await client.query(
      `UPDATE manual_time_entries
       SET voided_at = now(), voided_by = $3, void_reason = $4
       WHERE id = $1 AND organization_id = $2 AND voided_at IS NULL
       RETURNING id`,
      [entry.id, organizationId, req.user!.id, body.reason]
    );
    if (updated.rowCount === 0) throw conflict('Estas horas manuales ya fueron anuladas');
    await recordAudit(
      {
        organizationId,
        actorUserId: req.user!.id,
        action: 'manual_time.voided',
        entityType: 'manual_time_entry',
        entityId: entry.id,
        reason: body.reason,
      },
      client
    );
  });
  res.json({ ok: true });
});
