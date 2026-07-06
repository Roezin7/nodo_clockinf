import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne } from '../db.js';
import { notFound } from '../errors.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';

// Catálogos: turnos y áreas
export const shiftsRouter = Router();
shiftsRouter.use(requireAuth);

const mealWindowSchema = z.object({
  name: z.string().min(1),
  start: z.string().regex(/^\d{2}:\d{2}$/),
  end: z.string().regex(/^\d{2}:\d{2}$/),
  paid: z.boolean(),
});

const shiftSchema = z.object({
  name: z.string().trim().min(1),
  start_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
  end_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
  tolerance_minutes: z.number().int().min(0).max(120).default(5),
  meal_windows: z.array(mealWindowSchema).default([]),
});

shiftsRouter.get('/', async (_req, res) => {
  res.json(await query(`SELECT * FROM shifts ORDER BY start_time`));
});

shiftsRouter.post('/', requireAdmin, async (req, res) => {
  const body = shiftSchema.parse(req.body);
  const row = await queryOne(
    `INSERT INTO shifts (name, start_time, end_time, tolerance_minutes, meal_windows)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [body.name, body.start_time, body.end_time, body.tolerance_minutes, JSON.stringify(body.meal_windows)]
  );
  res.status(201).json(row);
});

shiftsRouter.patch('/:id', requireAdmin, async (req, res) => {
  const body = shiftSchema.partial().parse(req.body);
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [col, value] of Object.entries(body)) {
    params.push(col === 'meal_windows' ? JSON.stringify(value) : value);
    sets.push(`${col} = $${params.length}`);
  }
  if (!sets.length) {
    res.json(await queryOne(`SELECT * FROM shifts WHERE id = $1`, [req.params.id]));
    return;
  }
  params.push(req.params.id);
  const row = await queryOne(
    `UPDATE shifts SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
    params
  );
  if (!row) throw notFound('Turno no encontrado');
  res.json(row);
});

export const areasRouter = Router();
areasRouter.use(requireAuth);

areasRouter.get('/', async (_req, res) => {
  res.json(await query(`SELECT * FROM areas ORDER BY name`));
});

areasRouter.post('/', requireAdmin, async (req, res) => {
  const body = z.object({ name: z.string().trim().min(1) }).parse(req.body);
  const row = await queryOne(`INSERT INTO areas (name) VALUES ($1) RETURNING *`, [body.name]);
  res.status(201).json(row);
});
