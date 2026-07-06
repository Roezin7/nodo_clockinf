import { Router } from 'express';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import { z } from 'zod';
import { query, queryOne } from '../db.js';
import { badRequest, notFound, unauthorized, HttpError } from '../errors.js';
import { requireAuth, requireKiosk } from '../middleware/auth.js';
import { inferPunchType } from '../services/punchInference.js';
import { lockedForSeconds, recordFailure, recordSuccess } from '../services/pinLimiter.js';
import { getSettings } from '../services/settingsService.js';
import { localDayBoundsUtc, workDateOf } from '../services/time.js';
import { storage } from '../storage.js';
import { config } from '../config.js';
import type { MealWindow, PunchType } from '../types.js';

export const punchesRouter = Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

interface PunchRow {
  id: string;
  employee_id: string;
  punch_type: PunchType;
  punched_at: Date;
  area_id: string | null;
  source: string;
  photo_key: string | null;
  face_check_status: string;
  voided: boolean;
  correction_of: string | null;
  correction_reason: string | null;
  created_by: string | null;
  created_at: Date;
}

const ingestSchema = z.object({
  employee_number: z.number().int().positive(),
  pin: z.string().regex(/^\d{4}$/),
  punch_type: z.enum(['shift_in', 'shift_out', 'meal_out', 'meal_in']).nullish(),
  source: z.literal('kiosk'),
});

/**
 * Ingesta desde kiosco. Valida PIN, infiere tipo por secuencia, deduplica.
 * La foto NO viaja aquí: se sube después a /api/punches/:id/photo para que
 * la respuesta salga en <300ms y no detenga la fila.
 */
punchesRouter.post('/ingest', requireKiosk, async (req, res) => {
  const body = ingestSchema.parse(req.body);

  const lockSeconds = lockedForSeconds(body.employee_number);
  if (lockSeconds > 0) {
    throw new HttpError(429, `Bloqueado por intentos fallidos. Espera ${lockSeconds}s`, 'pin_locked');
  }

  const employee = await queryOne<{ id: string; full_name: string; pin_hash: string; default_shift_id: string | null }>(
    `SELECT id, full_name, pin_hash, default_shift_id FROM employees
     WHERE employee_number = $1 AND active`,
    [body.employee_number]
  );
  // Mensaje genérico: no revelar si el número existe
  if (!employee) {
    recordFailure(body.employee_number);
    throw unauthorized('Número o PIN incorrecto');
  }
  if (!(await bcrypt.compare(body.pin, employee.pin_hash))) {
    recordFailure(body.employee_number);
    throw unauthorized('Número o PIN incorrecto');
  }
  recordSuccess(body.employee_number);

  const now = new Date();
  const { startUtc, endUtc, workDate } = localDayBoundsUtc(now, config.plantTimezone);

  const lastPunch = await queryOne<{ punch_type: PunchType; punched_at: Date; id: string }>(
    `SELECT id, punch_type, punched_at FROM punches
     WHERE employee_id = $1 AND NOT voided AND punched_at BETWEEN $2 AND $3
     ORDER BY punched_at DESC LIMIT 1`,
    [employee.id, startUtc, endUtc]
  );

  // Deduplicación: una checada del mismo empleado dentro de la ventana
  // (default 2 min) es un doble tap — se regresa la existente sin insertar.
  const settings = await getSettings();
  if (lastPunch && now.getTime() - lastPunch.punched_at.getTime() < settings.duplicate_window_minutes * 60_000) {
    res.status(200).json({
      punch_id: lastPunch.id,
      employee_name: employee.full_name,
      punch_type_inferred: lastPunch.punch_type,
      punched_at: lastPunch.punched_at.toISOString(),
      duplicate: true,
    });
    return;
  }

  let punchType: PunchType;
  if (body.punch_type) {
    punchType = body.punch_type;
  } else {
    let mealWindows: MealWindow[] = [];
    if (employee.default_shift_id) {
      const shift = await queryOne<{ meal_windows: MealWindow[] }>(
        `SELECT meal_windows FROM shifts WHERE id = $1`,
        [employee.default_shift_id]
      );
      mealWindows = shift?.meal_windows ?? [];
    }
    punchType = inferPunchType(lastPunch?.punch_type ?? null, now, mealWindows, config.plantTimezone);
  }

  // Área del día si ya fue asignada (la más reciente si hay varias)
  const assignment = await queryOne<{ area_id: string }>(
    `SELECT area_id FROM daily_area_assignments
     WHERE employee_id = $1 AND work_date = $2
     ORDER BY id DESC LIMIT 1`,
    [employee.id, workDate]
  );

  const punch = await queryOne<{ id: string; punched_at: Date }>(
    `INSERT INTO punches (employee_id, punch_type, punched_at, area_id, source)
     VALUES ($1, $2, $3, $4, 'kiosk')
     RETURNING id, punched_at`,
    [employee.id, punchType, now, assignment?.area_id ?? null]
  );

  res.status(201).json({
    punch_id: punch!.id,
    employee_name: employee.full_name,
    punch_type_inferred: punchType,
    punched_at: punch!.punched_at.toISOString(),
  });
});

/**
 * Subida de foto en background (después de confirmar la checada).
 * El kiosco reintenta con cola local si falla; la checada nunca depende de esto.
 */
punchesRouter.post('/:id/photo', requireKiosk, upload.single('photo'), async (req, res) => {
  if (!req.file) throw badRequest('Falta archivo photo');
  const punch = await queryOne<{ id: string; punched_at: Date; photo_key: string | null }>(
    `SELECT id, punched_at, photo_key FROM punches WHERE id = $1`,
    [req.params.id]
  );
  if (!punch) throw notFound('Checada no encontrada');
  if (punch.photo_key) {
    res.json({ ok: true, already: true });
    return;
  }
  const workDate = workDateOf(punch.punched_at, config.plantTimezone);
  const key = `punches/${workDate}/${punch.id}.jpg`;
  await storage.put(key, req.file.buffer, req.file.mimetype || 'image/jpeg');
  await query(`UPDATE punches SET photo_key = $1 WHERE id = $2`, [key, punch.id]);
  res.json({ ok: true, photo_key: key });
});

const listSchema = z.object({
  employee: z.string().uuid().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  include_voided: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

punchesRouter.get('/', requireAuth, async (req, res) => {
  const q = listSchema.parse(req.query);
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.employee) {
    params.push(q.employee);
    where.push(`p.employee_id = $${params.length}`);
  }
  let tzParam = '';
  if (q.from || q.to) {
    params.push(config.plantTimezone);
    tzParam = `$${params.length}`;
  }
  if (q.from) {
    params.push(q.from);
    where.push(`(p.punched_at AT TIME ZONE ${tzParam})::date >= $${params.length}::date`);
  }
  if (q.to) {
    params.push(q.to);
    where.push(`(p.punched_at AT TIME ZONE ${tzParam})::date <= $${params.length}::date`);
  }
  if (q.include_voided !== 'true') where.push(`NOT p.voided`);
  params.push(q.limit);

  const rows = await query<PunchRow & { full_name: string; employee_number: number; area_name: string | null }>(
    `SELECT p.*, e.full_name, e.employee_number, a.name AS area_name
     FROM punches p
     JOIN employees e ON e.id = p.employee_id
     LEFT JOIN areas a ON a.id = p.area_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY p.punched_at DESC
     LIMIT $${params.length}`,
    params
  );

  const withUrls = await Promise.all(
    rows.map(async (row) => ({
      ...row,
      photo_url: row.photo_key ? await storage.viewUrl(row.photo_key) : null,
    }))
  );
  res.json(withUrls);
});
