import { Router } from 'express';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import { z } from 'zod';
import { query, queryOne, withTransaction } from '../db.js';
import { badRequest, conflict, notFound, unauthorized, HttpError } from '../errors.js';
import {
  requireAuth,
  requireKiosk,
  requireOrganization,
  requireRole,
} from '../middleware/auth.js';
import { inferPunchType } from '../services/punchInference.js';
import { lockedForSeconds, recordFailure, recordSuccess } from '../services/pinLimiter.js';
import { getSettings } from '../services/settingsService.js';
import { formatLocalTime, localDayBoundsUtc, localToUtc, workDateOf } from '../services/time.js';
import { storage } from '../storage.js';
import type { MealWindow, PunchType } from '../types.js';
import {
  accessiblePlantIds,
  assertPlantAccess,
  getDefaultOrganizationId,
  getDefaultPlantId,
} from '../services/tenantService.js';
import { recordAudit } from '../services/auditService.js';
import { ensurePeriodOpen } from '../services/payPeriodService.js';

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
  const organizationId = await getDefaultOrganizationId();
  const plantId = await getDefaultPlantId(organizationId);

  const lockSeconds = lockedForSeconds(body.employee_number);
  if (lockSeconds > 0) {
    throw new HttpError(429, `Bloqueado por intentos fallidos. Espera ${lockSeconds}s`, 'pin_locked');
  }

  const employee = await queryOne<{ id: string; full_name: string; pin_hash: string; default_shift_id: string | null }>(
    `SELECT id, full_name, pin_hash, default_shift_id FROM employees
     WHERE organization_id = $1 AND employee_number = $2 AND active`,
    [organizationId, body.employee_number]
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

  const settings = await getSettings(organizationId);
  const tz = settings.timezone;
  const now = new Date();
  const { startUtc, endUtc, workDate } = localDayBoundsUtc(now, tz);

  const lastPunch = await queryOne<{ punch_type: PunchType; punched_at: Date; id: string }>(
    `SELECT id, punch_type, punched_at FROM punches
     WHERE employee_id = $1 AND NOT voided AND punched_at BETWEEN $2 AND $3
       AND organization_id = $4
     ORDER BY punched_at DESC LIMIT 1`,
    [employee.id, startUtc, endUtc, organizationId]
  );

  // Deduplicación: una checada del mismo empleado dentro de la ventana
  // (default 2 min) es un doble tap — se regresa la existente sin insertar.
  // Solo cuenta hacia atrás: una checada futura (corrección mal fechada) no
  // debe tragarse las checadas reales del kiosco.
  const sinceLastMs = lastPunch ? now.getTime() - lastPunch.punched_at.getTime() : -1;
  if (lastPunch && sinceLastMs >= 0 && sinceLastMs < settings.duplicate_window_minutes * 60_000) {
    res.status(200).json({
      punch_id: lastPunch.id,
      employee_name: employee.full_name,
      punch_type_inferred: lastPunch.punch_type,
      punched_at: lastPunch.punched_at.toISOString(),
      punched_at_local: formatLocalTime(lastPunch.punched_at, tz),
      timezone: tz,
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
        `SELECT meal_windows FROM shifts WHERE id = $1 AND organization_id = $2`,
        [employee.default_shift_id, organizationId]
      );
      mealWindows = shift?.meal_windows ?? [];
    }
    punchType = inferPunchType(lastPunch?.punch_type ?? null, now, mealWindows, tz);
  }

  // Área del día si ya fue asignada (la más reciente si hay varias)
  const assignment = await queryOne<{ area_id: string }>(
    `SELECT area_id FROM daily_area_assignments
     WHERE employee_id = $1 AND work_date = $2
       AND organization_id = $3
     ORDER BY id DESC LIMIT 1`,
    [employee.id, workDate, organizationId]
  );

  const punch = await queryOne<{ id: string; punched_at: Date }>(
    `INSERT INTO punches
       (organization_id, plant_id, employee_id, punch_type, punched_at, captured_at, area_id, source)
     VALUES ($1, $2, $3, $4, $5, $5, $6, 'kiosk')
     RETURNING id, punched_at`,
    [organizationId, plantId, employee.id, punchType, now, assignment?.area_id ?? null]
  );

  res.status(201).json({
    punch_id: punch!.id,
    employee_name: employee.full_name,
    punch_type_inferred: punchType,
    punched_at: punch!.punched_at.toISOString(),
    // El kiosco muestra ESTA hora, formateada por el servidor: nunca la del dispositivo
    punched_at_local: formatLocalTime(punch!.punched_at, tz),
    timezone: tz,
  });
});

/**
 * Subida de foto en background (después de confirmar la checada).
 * El kiosco reintenta con cola local si falla; la checada nunca depende de esto.
 */
punchesRouter.post('/:id/photo', requireKiosk, upload.single('photo'), async (req, res) => {
  if (!req.file) throw badRequest('Falta archivo photo');
  const organizationId = await getDefaultOrganizationId();
  const punch = await queryOne<{ id: string; punched_at: Date; photo_key: string | null }>(
    `SELECT id, punched_at, photo_key FROM punches WHERE id = $1 AND organization_id = $2`,
    [req.params.id, organizationId]
  );
  if (!punch) throw notFound('Checada no encontrada');
  if (punch.photo_key) {
    res.json({ ok: true, already: true });
    return;
  }
  const workDate = workDateOf(punch.punched_at, (await getSettings(organizationId)).timezone);
  const key = `${organizationId}/punches/${workDate}/${punch.id}.jpg`;
  await storage.put(key, req.file.buffer, req.file.mimetype || 'image/jpeg');
  await query(`UPDATE punches SET photo_key = $1 WHERE id = $2`, [key, punch.id]);
  res.json({ ok: true, photo_key: key });
});

const manualSchema = z
  .object({
    employee_id: z.string().uuid(),
    plant_id: z.string().uuid(),
    punch_type: z.enum(['shift_in', 'shift_out', 'meal_out', 'meal_in']),
    /** Instante absoluto con offset explícito… */
    punched_at: z.string().datetime({ offset: true }).optional(),
    /** …o hora local de planta 'YYYY-MM-DDTHH:mm' (el servidor la convierte con SU zona). */
    punched_at_local: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/).optional(),
    area_id: z.string().uuid().nullish(),
    reason: z.string().trim().min(3, 'La razón es obligatoria'),
    /** Si corrige una checada existente, esta se anula en la misma operación. */
    correction_of: z.string().uuid().nullish(),
  })
  .refine((b) => b.punched_at || b.punched_at_local, {
    message: 'Falta punched_at o punched_at_local',
  });

/**
 * Corrección manual (solo admin). La checada original nunca se edita:
 * si correction_of viene, la original se marca voided (con auditoría en
 * punch_voids) y la nueva la referencia.
 */
punchesRouter.post('/manual', requireAuth, requireRole('admin', 'foreman'), async (req, res) => {
  const body = manualSchema.parse(req.body);
  const userId = req.user!.id;
  const organizationId = requireOrganization(req);
  await assertPlantAccess(req, body.plant_id);
  const settings = await getSettings(organizationId);
  const punchedAt = body.punched_at_local
    ? localToUtc(body.punched_at_local, settings.timezone)
    : new Date(body.punched_at!);
  // Una checada fechada en el futuro rompe la inferencia y la deduplicación del kiosco
  if (punchedAt > new Date()) {
    throw badRequest('La checada no puede tener fecha/hora en el futuro');
  }

  const employee = await queryOne<{ id: string }>(
    `SELECT id FROM employees WHERE id = $1 AND organization_id = $2`,
    [body.employee_id, organizationId]
  );
  if (!employee) throw notFound('Empleado no encontrado');

  const created = await withTransaction(async (client) => {
    const workDate = workDateOf(punchedAt, settings.timezone);
    await ensurePeriodOpen(client, organizationId, workDate, settings.timezone);
    if (body.correction_of) {
      const orig = await client.query<{
        id: string;
        voided: boolean;
        employee_id: string;
        plant_id: string | null;
        punched_at: Date;
      }>(
        `SELECT id, voided, employee_id, plant_id, punched_at FROM punches
         WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
        [body.correction_of, organizationId]
      );
      if (!orig.rows[0]) throw notFound('Checada a corregir no encontrada');
      if (orig.rows[0].employee_id !== body.employee_id || orig.rows[0].plant_id !== body.plant_id) {
        throw badRequest('La corrección debe conservar empleado y planta');
      }
      if (workDateOf(orig.rows[0].punched_at, settings.timezone) !== workDate) {
        throw badRequest('La corrección debe permanecer en el mismo día de trabajo');
      }
      if (!orig.rows[0].voided) {
        await client.query(
          `INSERT INTO punch_voids (organization_id, punch_id, voided_by, reason)
           VALUES ($1, $2, $3, $4)`,
          [organizationId, body.correction_of, userId, body.reason]
        );
        await client.query(`UPDATE punches SET voided = true WHERE id = $1`, [body.correction_of]);
        await recordAudit(
          {
            organizationId,
            actorUserId: userId,
            action: 'punch.voided_for_correction',
            entityType: 'punch',
            entityId: body.correction_of,
            reason: body.reason,
          },
          client
        );
      }
    }
    const inserted = await client.query(
      `INSERT INTO punches
         (organization_id, plant_id, employee_id, punch_type, punched_at, captured_at,
          area_id, source, created_by, correction_of, correction_reason)
       VALUES ($1, $2, $3, $4, $5, $5, $6, 'manual', $7, $8, $9)
       RETURNING *`,
      [
        organizationId, body.plant_id, body.employee_id, body.punch_type, punchedAt,
        body.area_id ?? null, userId, body.correction_of ?? null, body.reason,
      ]
    );
    await recordAudit(
      {
        organizationId,
        actorUserId: userId,
        action: 'punch.manual_created',
        entityType: 'punch',
        entityId: inserted.rows[0].id as string,
        reason: body.reason,
        metadata: {
          employee_id: body.employee_id,
          plant_id: body.plant_id,
          correction_of: body.correction_of ?? null,
        },
      },
      client
    );
    return inserted.rows[0] as Record<string, unknown>;
  });

  res.status(201).json(created);
});

/** Anulación sin reemplazo (solo admin), con auditoría. */
punchesRouter.post('/:id/void', requireAuth, requireRole('admin', 'foreman'), async (req, res) => {
  const body = z.object({ reason: z.string().trim().min(3, 'La razón es obligatoria') }).parse(req.body);
  const userId = req.user!.id;
  const organizationId = requireOrganization(req);
  const settings = await getSettings(organizationId);
  await withTransaction(async (client) => {
    const orig = await client.query<{ id: string; voided: boolean; plant_id: string | null; punched_at: Date }>(
      `SELECT id, voided, plant_id, punched_at FROM punches
       WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
      [req.params.id, organizationId]
    );
    if (!orig.rows[0]) throw notFound('Checada no encontrada');
    await ensurePeriodOpen(
      client,
      organizationId,
      workDateOf(orig.rows[0].punched_at, settings.timezone),
      settings.timezone
    );
    if (!orig.rows[0].plant_id) throw badRequest('La checada histórica no tiene planta asignada');
    await assertPlantAccess(req, orig.rows[0].plant_id);
    if (orig.rows[0].voided) throw conflict('La checada ya está anulada');
    await client.query(
      `INSERT INTO punch_voids (organization_id, punch_id, voided_by, reason)
       VALUES ($1, $2, $3, $4)`,
      [organizationId, req.params.id, userId, body.reason]
    );
    await client.query(`UPDATE punches SET voided = true WHERE id = $1`, [req.params.id]);
    await recordAudit(
      {
        organizationId,
        actorUserId: userId,
        action: 'punch.voided',
        entityType: 'punch',
        entityId: String(req.params.id),
        reason: body.reason,
      },
      client
    );
  });
  res.json({ ok: true });
});

const listSchema = z.object({
  employee: z.string().uuid().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  include_voided: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

punchesRouter.get('/', requireAuth, requireRole('admin', 'foreman'), async (req, res) => {
  const q = listSchema.parse(req.query);
  const organizationId = requireOrganization(req);
  const where: string[] = ['p.organization_id = $1'];
  const params: unknown[] = [organizationId];
  if (req.user!.role === 'foreman') {
    params.push(await accessiblePlantIds(req.user!));
    where.push(`p.plant_id = ANY($${params.length}::uuid[])`);
  }
  if (q.employee) {
    params.push(q.employee);
    where.push(`p.employee_id = $${params.length}`);
  }
  let tzParam = '';
  if (q.from || q.to) {
    params.push((await getSettings(organizationId)).timezone);
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
