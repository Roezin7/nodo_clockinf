import { Router } from 'express';
import { z } from 'zod';
import { badRequest } from '../errors.js';
import {
  requireAuth,
  requireAdmin,
  requireOrganization,
  requireRole,
} from '../middleware/auth.js';
import { dayDetail } from '../services/attendanceService.js';
import { getSettings } from '../services/settingsService.js';
import { todayLocal } from '../services/time.js';
import { query } from '../db.js';
import { accessiblePlantIds, assertPlantAccess } from '../services/tenantService.js';

export const attendanceRouter = Router();
attendanceRouter.use(requireAuth, requireRole('admin', 'foreman', 'accountant'));

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

attendanceRouter.get('/today', async (req, res) => {
  const organizationId = requireOrganization(req);
  const today = todayLocal((await getSettings(organizationId)).timezone);
  const plants = req.user!.role === 'foreman' ? await accessiblePlantIds(req.user!) : undefined;
  res.json({ date: today, rows: await dayDetail(organizationId, today, plants) });
});

attendanceRouter.get('/day/:date', async (req, res) => {
  if (!DATE_RE.test(req.params.date)) throw badRequest('Fecha inválida (YYYY-MM-DD)');
  const organizationId = requireOrganization(req);
  const plants = req.user!.role === 'foreman' ? await accessiblePlantIds(req.user!) : undefined;
  res.json({ date: req.params.date, rows: await dayDetail(organizationId, req.params.date, plants) });
});

// Asignación de área del día (bulk)
export const assignmentsRouter = Router();
assignmentsRouter.use(requireAuth);

const assignSchema = z.object({
  work_date: z.string().regex(DATE_RE),
  plant_id: z.string().uuid(),
  area_id: z.string().uuid(),
  employee_ids: z.array(z.string().uuid()).min(1),
});

assignmentsRouter.post('/daily', requireAdmin, async (req, res) => {
  const body = assignSchema.parse(req.body);
  const organizationId = requireOrganization(req);
  await assertPlantAccess(req, body.plant_id);
  let count = 0;
  for (const employeeId of body.employee_ids) {
    const inserted = await query(
      `INSERT INTO daily_area_assignments
         (organization_id, plant_id, employee_id, work_date, area_id)
       SELECT $1, $2, e.id, $3::date, a.id
       FROM employees e, areas a
       WHERE e.id = $4 AND e.organization_id = $1
         AND a.id = $5 AND a.organization_id = $1
       ON CONFLICT (employee_id, work_date, area_id) DO NOTHING
       RETURNING id`,
      [organizationId, body.plant_id, body.work_date, employeeId, body.area_id]
    );
    count += inserted.length;
  }
  res.status(201).json({ ok: true, count });
});

assignmentsRouter.get('/daily', async (req, res) => {
  const organizationId = requireOrganization(req);
  const date = typeof req.query.date === 'string' && DATE_RE.test(req.query.date)
    ? req.query.date
    : todayLocal((await getSettings(organizationId)).timezone);
  const plants = req.user!.role === 'foreman' ? await accessiblePlantIds(req.user!) : undefined;
  res.json(
    await query(
      `SELECT d.id, d.employee_id, d.work_date, d.area_id, a.name AS area_name, e.full_name, e.employee_number
       FROM daily_area_assignments d
       JOIN areas a ON a.id = d.area_id
       JOIN employees e ON e.id = d.employee_id
       WHERE d.work_date = $1::date AND d.organization_id = $2
         AND ($3::uuid[] IS NULL OR d.plant_id = ANY($3::uuid[]))
       ORDER BY e.employee_number`,
      [date, organizationId, plants ?? null]
    )
  );
});
