import { Router } from 'express';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { badRequest } from '../errors.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { dayDetail } from '../services/attendanceService.js';
import { config } from '../config.js';
import { query } from '../db.js';

export const attendanceRouter = Router();
attendanceRouter.use(requireAuth);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

attendanceRouter.get('/today', async (_req, res) => {
  const today = DateTime.now().setZone(config.plantTimezone).toISODate()!;
  res.json({ date: today, rows: await dayDetail(today) });
});

attendanceRouter.get('/day/:date', async (req, res) => {
  if (!DATE_RE.test(req.params.date)) throw badRequest('Fecha inválida (YYYY-MM-DD)');
  res.json({ date: req.params.date, rows: await dayDetail(req.params.date) });
});

// Asignación de área del día (bulk)
export const assignmentsRouter = Router();
assignmentsRouter.use(requireAuth);

const assignSchema = z.object({
  work_date: z.string().regex(DATE_RE),
  area_id: z.string().uuid(),
  employee_ids: z.array(z.string().uuid()).min(1),
});

assignmentsRouter.post('/daily', requireAdmin, async (req, res) => {
  const body = assignSchema.parse(req.body);
  for (const employeeId of body.employee_ids) {
    await query(
      `INSERT INTO daily_area_assignments (employee_id, work_date, area_id)
       VALUES ($1, $2::date, $3)
       ON CONFLICT (employee_id, work_date, area_id) DO NOTHING`,
      [employeeId, body.work_date, body.area_id]
    );
  }
  res.status(201).json({ ok: true, count: body.employee_ids.length });
});

assignmentsRouter.get('/daily', async (req, res) => {
  const date = typeof req.query.date === 'string' && DATE_RE.test(req.query.date)
    ? req.query.date
    : DateTime.now().setZone(config.plantTimezone).toISODate()!;
  res.json(
    await query(
      `SELECT d.id, d.employee_id, d.work_date, d.area_id, a.name AS area_name, e.full_name, e.employee_number
       FROM daily_area_assignments d
       JOIN areas a ON a.id = d.area_id
       JOIN employees e ON e.id = d.employee_id
       WHERE d.work_date = $1::date
       ORDER BY e.employee_number`,
      [date]
    )
  );
});
