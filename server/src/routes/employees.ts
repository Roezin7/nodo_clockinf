import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import multer from 'multer';
import { z } from 'zod';
import { query, queryOne, withTransaction } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import {
  requireAdmin,
  requireAuth,
  requireOrganization,
  requireRole,
} from '../middleware/auth.js';
import { recordAudit } from '../services/auditService.js';
import { decryptSensitiveValue, encryptSensitiveValue } from '../services/piiCrypto.js';
import { storage } from '../storage.js';
import {
  FACE_IMAGE_MAX_BYTES,
  FACE_IMAGE_MIME_TYPES,
  supportedFaceImage,
} from '../services/identityService.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: FACE_IMAGE_MAX_BYTES } });

export const employeesRouter = Router();
employeesRouter.use(requireAuth, requireRole('admin', 'foreman'));
// Employee lists contain personal data and the admin variants also expose
// wage rates/SSN on demand. Never allow a browser, proxy or service worker to
// retain any response from this router.
employeesRouter.use((_req, res, next) => {
  res.header('Cache-Control', 'private, no-store, max-age=0');
  res.header('Pragma', 'no-cache');
  next();
});

export interface EmployeeRow {
  id: string;
  organization_id: string;
  employee_number: number;
  full_name: string;
  social_security: string | null;
  phone: string | null;
  pin_hash: string;
  enrollment_photo_key: string | null;
  current_biometric_enrollment_id: string | null;
  default_shift_id: string | null;
  active: boolean;
  hired_at: string | null;
  deactivated_at: string | null;
  created_at: string;
}

function adminEmployeeResponse(row: EmployeeRow): Omit<EmployeeRow, 'enrollment_photo_key'> {
  const { enrollment_photo_key: _internalPhotoKey, ...publicEmployee } = row;
  return { ...publicEmployee, social_security: decryptSensitiveValue(row.social_security) };
}

const SAFE_COLS = `id, organization_id, employee_number, full_name, default_shift_id,
  active, hired_at, deactivated_at, created_at`;
const ADMIN_COLS = `id, organization_id, employee_number, full_name, social_security, phone,
  enrollment_photo_key, current_biometric_enrollment_id, default_shift_id, active, hired_at,
  deactivated_at, created_at`;
const SAFE_LIST_COLS = `e.id, e.organization_id, e.employee_number, e.full_name,
  e.default_shift_id, e.active, e.hired_at, e.deactivated_at, e.created_at`;
const ADMIN_LIST_COLS = `${SAFE_LIST_COLS}, e.phone, e.current_biometric_enrollment_id,
  be.status AS biometric_enrollment_status,
  CASE WHEN current_rate.id IS NULL THEN NULL ELSE jsonb_build_object(
    'hourly_rate', current_rate.hourly_rate::text,
    'effective_from', current_rate.effective_from
  ) END AS current_rate`;

const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const [year, month, day] = value.split('-').map(Number);
    const parsed = new Date(Date.UTC(year!, month! - 1, day!));
    return (
      parsed.getUTCFullYear() === year &&
      parsed.getUTCMonth() === month! - 1 &&
      parsed.getUTCDate() === day
    );
  }, 'La fecha no existe');

/** Decimal exacto: nunca pasa por Number para no redondear una tarifa. */
export const hourlyRateSchema = z
  .string()
  .trim()
  .regex(
    /^(?:0|[1-9]\d{0,7})(?:\.\d{1,4})?$/,
    'La tasa debe ser un decimal entre 0 y 99999999.9999 con máximo 4 decimales'
  );

function canonicalHourlyRate(value: string): string {
  const [whole, fraction = ''] = value.split('.');
  return `${whole}.${fraction.padEnd(4, '0')}`;
}

/** PIN aleatorio de 4 dígitos, imprimible para la credencial. */
export function generatePin(): string {
  return crypto.randomInt(0, 10000).toString().padStart(4, '0');
}

employeesRouter.get('/', async (req, res) => {
  const organizationId = requireOrganization(req);
  const active = req.query.active as string | undefined;
  const search = (req.query.search as string | undefined)?.trim();
  const where = ['e.organization_id = $1'];
  const params: unknown[] = [organizationId];
  if (active === 'true' || active === 'false') {
    params.push(active === 'true');
    where.push(`e.active = $${params.length}`);
  }
  if (search) {
    params.push(`%${search}%`);
    where.push(
      `(e.full_name ILIKE $${params.length} OR e.employee_number::text ILIKE $${params.length})`
    );
  }
  if (req.user!.role !== 'admin') {
    res.json(
      await query(
        `SELECT ${SAFE_LIST_COLS}
         FROM employees e
         WHERE ${where.join(' AND ')}
         ORDER BY e.employee_number`,
        params
      )
    );
    return;
  }
  res.json(
    await query(
      `SELECT ${ADMIN_LIST_COLS}
       FROM employees e
       JOIN organizations o ON o.id = e.organization_id
       LEFT JOIN biometric_enrollments be
         ON be.id = e.current_biometric_enrollment_id
        AND be.employee_id = e.id
        AND be.organization_id = e.organization_id
       LEFT JOIN LATERAL (
         SELECT r.id, r.hourly_rate, r.effective_from
         FROM employee_rates r
         WHERE r.employee_id = e.id
           AND r.organization_id = e.organization_id
           AND r.effective_from <= (now() AT TIME ZONE o.timezone)::date
           AND (r.effective_to IS NULL
             OR r.effective_to >= (now() AT TIME ZONE o.timezone)::date)
         ORDER BY r.effective_from DESC
         LIMIT 1
       ) current_rate ON true
       WHERE ${where.join(' AND ')}
       ORDER BY e.employee_number`,
      params
    )
  );
});

employeesRouter.get('/:id', async (req, res) => {
  const organizationId = requireOrganization(req);
  const admin = req.user!.role === 'admin';
  const row = admin
    ? await queryOne<EmployeeRow & { enrollment_photo_key: string | null }>(
        `SELECT e.id, e.organization_id, e.employee_number, e.full_name,
                e.social_security, e.phone, e.enrollment_photo_key,
                e.current_biometric_enrollment_id, e.default_shift_id, e.active,
                e.hired_at, e.deactivated_at, e.created_at,
                be.status AS biometric_enrollment_status,
                CASE WHEN current_rate.id IS NULL THEN NULL ELSE jsonb_build_object(
                  'hourly_rate', current_rate.hourly_rate::text,
                  'effective_from', current_rate.effective_from
                ) END AS current_rate
         FROM employees e
         JOIN organizations o ON o.id = e.organization_id
         LEFT JOIN biometric_enrollments be
           ON be.id = e.current_biometric_enrollment_id
          AND be.employee_id = e.id
          AND be.organization_id = e.organization_id
         LEFT JOIN LATERAL (
           SELECT r.id, r.hourly_rate, r.effective_from
           FROM employee_rates r
           WHERE r.employee_id = e.id
             AND r.organization_id = e.organization_id
             AND r.effective_from <= (now() AT TIME ZONE o.timezone)::date
             AND (r.effective_to IS NULL
               OR r.effective_to >= (now() AT TIME ZONE o.timezone)::date)
           ORDER BY r.effective_from DESC
           LIMIT 1
         ) current_rate ON true
         WHERE e.id = $1 AND e.organization_id = $2`,
        [req.params.id, organizationId]
      )
    : await queryOne<EmployeeRow>(
        `SELECT ${SAFE_COLS}
         FROM employees WHERE id = $1 AND organization_id = $2`,
        [req.params.id, organizationId]
  );
  if (!row) throw notFound('Empleado no encontrado');
  const enrollmentPhotoKey = row.enrollment_photo_key;
  res.json({
    ...(admin ? adminEmployeeResponse(row) : row),
    enrollment_photo_url:
      admin && enrollmentPhotoKey ? await storage.viewUrl(enrollmentPhotoKey) : undefined,
  });
});

/** Nueva versión inmutable de enrolamiento; las anteriores conservan auditoría. */
employeesRouter.post('/:id/photo', requireAdmin, upload.single('photo'), async (req, res) => {
  if (!req.file) throw badRequest('Falta archivo photo');
  const contentType = req.file.mimetype.toLowerCase();
  if (!(FACE_IMAGE_MIME_TYPES as readonly string[]).includes(contentType)) {
    throw badRequest('La foto debe ser JPEG, PNG o WebP');
  }
  if (!supportedFaceImage(req.file.buffer, contentType)) {
    throw badRequest('El contenido no corresponde al tipo de imagen declarado');
  }
  const organizationId = requireOrganization(req);
  const hash = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
  const extension = contentType === 'image/png' ? 'png' : contentType === 'image/webp' ? 'webp' : 'jpg';
  let uploadedKey: string | null = null;
  let enrollment: Record<string, unknown>;
  try {
    enrollment = await withTransaction(async (client) => {
      const employee = await client.query<{ id: string }>(
        `SELECT id FROM employees WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
        [req.params.id, organizationId]
      );
      if (!employee.rows[0]) throw notFound('Empleado no encontrado');
      const versionResult = await client.query<{ version: number }>(
        `SELECT COALESCE(max(version), 0)::integer + 1 AS version
         FROM biometric_enrollments WHERE employee_id = $1 AND organization_id = $2`,
        [employee.rows[0].id, organizationId]
      );
      const version = versionResult.rows[0]!.version;
      const id = crypto.randomUUID();
      const key = `${organizationId}/enrollment/${employee.rows[0].id}/v${version}-${hash}.${extension}`;
      await storage.put(key, req.file!.buffer, contentType);
      uploadedKey = key;
      const inserted = await client.query(
        `INSERT INTO biometric_enrollments
           (id, organization_id, employee_id, version, photo_key, photo_sha256,
            content_type, byte_size, provider, integrity_status, status, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'review_only', 'verified', 'ready', $9)
         RETURNING id, version, status, provider, integrity_status, created_at`,
        [
          id,
          organizationId,
          employee.rows[0].id,
          version,
          key,
          hash,
          contentType,
          req.file!.buffer.length,
          req.user!.id,
        ]
      );
      await client.query(
        `UPDATE employees
         SET enrollment_photo_key = $1, current_biometric_enrollment_id = $2
         WHERE id = $3 AND organization_id = $4`,
        [key, id, employee.rows[0].id, organizationId]
      );
      await recordAudit(
        {
          organizationId,
          actorUserId: req.user!.id,
          action: 'employee.biometric_enrollment_version_created',
          entityType: 'employee',
          entityId: employee.rows[0].id,
          metadata: { enrollment_id: id, version, photo_sha256: hash },
        },
        client
      );
      return inserted.rows[0] as Record<string, unknown>;
    });
  } catch (error) {
    if (uploadedKey) {
      let provenUnreferenced = false;
      try {
        provenUnreferenced = !(await queryOne(
          `SELECT id FROM biometric_enrollments
           WHERE organization_id = $1 AND photo_key = $2 LIMIT 1`,
          [organizationId, uploadedKey]
        ));
      } catch {
        // COMMIT may have succeeded before a lost connection. Unknown DB state
        // means preserve bytes; an orphan leak is safer than broken evidence.
      }
      if (provenUnreferenced) {
        try {
          await storage.remove(uploadedKey);
        } catch {
          // Content-addressed/versioned orphan can be reconciled later.
        }
      }
    }
    throw error;
  }
  // Signing a view URL happens after commit and must never trigger deletion of
  // the now-referenced immutable object if the signing service has an outage.
  res.status(201).json({
    ok: true,
    biometric_enrollment: enrollment,
    photo_url: await storage.viewUrl(uploadedKey!),
  });
});

const employeeFieldsSchema = z.object({
  full_name: z.string().trim().min(1),
  social_security: z.string().trim().optional().nullable(),
  phone: z.string().trim().optional().nullable(),
  default_shift_id: z.string().uuid().optional().nullable(),
  hired_at: isoDateSchema.optional().nullable(),
});
const createSchema = employeeFieldsSchema
  .extend({
    pin: z.string().regex(/^\d{4}$/).optional(),
    hourly_rate: hourlyRateSchema.optional(),
    rate_effective_from: isoDateSchema.optional(),
  })
  .strict()
  .superRefine((body, context) => {
    if ((body.hourly_rate === undefined) !== (body.rate_effective_from === undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'hourly_rate y rate_effective_from deben enviarse juntos',
        path: body.hourly_rate === undefined ? ['hourly_rate'] : ['rate_effective_from'],
      });
    }
    if (
      body.hired_at &&
      body.rate_effective_from &&
      body.rate_effective_from < body.hired_at
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'La tasa inicial no puede comenzar antes de la contratación',
        path: ['rate_effective_from'],
      });
    }
  });

employeesRouter.post('/', requireAdmin, async (req, res) => {
  const organizationId = requireOrganization(req);
  const body = createSchema.parse(req.body);
  const pin = body.pin ?? generatePin();
  const pinHash = await bcrypt.hash(pin, 10);
  const result = await withTransaction(async (client) => {
    const inserted = await client.query<EmployeeRow>(
      `INSERT INTO employees
         (organization_id, full_name, social_security, phone, default_shift_id, hired_at, pin_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${ADMIN_COLS}`,
      [
        organizationId,
        body.full_name,
        encryptSensitiveValue(body.social_security),
        body.phone ?? null,
        body.default_shift_id ?? null,
        body.hired_at ?? null,
        pinHash,
      ]
    );
    const row = inserted.rows[0]!;
    let currentRate: { hourly_rate: string; effective_from: string } | null = null;
    if (body.hourly_rate !== undefined) {
      const rate = await client.query<{ id: string; hourly_rate: string; effective_from: string }>(
        `INSERT INTO employee_rates
           (organization_id, employee_id, hourly_rate, effective_from, created_by)
         VALUES (
           $1, $2, $3,
           $4::date,
           $5
         )
         RETURNING id, hourly_rate::text, effective_from`,
        [organizationId, row.id, body.hourly_rate, body.rate_effective_from, req.user!.id]
      );
      currentRate = {
        hourly_rate: rate.rows[0]!.hourly_rate,
        effective_from: rate.rows[0]!.effective_from,
      };
      await recordAudit(
        {
          organizationId,
          actorUserId: req.user!.id,
          action: 'employee.rate_initialized',
          entityType: 'employee_rate',
          entityId: rate.rows[0]!.id,
          metadata: {
            employee_id: row.id,
            old: null,
            new: {
              hourly_rate: rate.rows[0]!.hourly_rate,
              effective_from: rate.rows[0]!.effective_from,
              effective_to: null,
            },
          },
        },
        client
      );
    }
    await recordAudit(
      {
        organizationId,
        actorUserId: req.user!.id,
        action: 'employee.created',
        entityType: 'employee',
        entityId: row.id,
      },
      client
    );
    return { row, currentRate };
  });
  res.status(201).json({
    ...adminEmployeeResponse(result.row), current_rate: result.currentRate, pin,
  });
});

const patchSchema = employeeFieldsSchema.partial().strict();

employeesRouter.patch('/:id', requireAdmin, async (req, res) => {
  const organizationId = requireOrganization(req);
  const body = patchSchema.parse(req.body);
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [col, value] of Object.entries(body)) {
    params.push(col === 'social_security' ? encryptSensitiveValue(value as string | null) : value);
    sets.push(`${col} = $${params.length}`);
  }
  if (!sets.length) throw badRequest('Nada que actualizar');
  params.push(req.params.id, organizationId);
  const row = await withTransaction(async (client) => {
    const employee = await client.query<{ id: string }>(
      `SELECT id FROM employees
       WHERE id = $1 AND organization_id = $2
       FOR UPDATE`,
      [req.params.id, organizationId]
    );
    if (!employee.rows[0]) throw notFound('Empleado no encontrado');
    if (body.hired_at) {
      const firstRate = await client.query<{ effective_from: string }>(
        `SELECT effective_from
         FROM employee_rates
         WHERE employee_id = $1 AND organization_id = $2
         ORDER BY effective_from
         LIMIT 1
         FOR UPDATE`,
        [req.params.id, organizationId]
      );
      if (firstRate.rows[0] && body.hired_at > firstRate.rows[0].effective_from) {
        throw conflict(
          `La contratación no puede quedar después de la primera tasa (${firstRate.rows[0].effective_from})`,
          'RATE_HIRE_AFTER_FIRST_RATE',
          { first_rate_effective_from: firstRate.rows[0].effective_from }
        );
      }
    }
    const updated = await client.query<EmployeeRow>(
      `UPDATE employees SET ${sets.join(', ')}
       WHERE id = $${params.length - 1} AND organization_id = $${params.length}
       RETURNING ${ADMIN_COLS}`,
      params
    );
    await recordAudit(
      {
        organizationId,
        actorUserId: req.user!.id,
        action: 'employee.updated',
        entityType: 'employee',
        entityId: updated.rows[0]!.id,
        metadata: { fields: Object.keys(body) },
      },
      client
    );
    return updated.rows[0]!;
  });
  res.json(adminEmployeeResponse(row));
});

employeesRouter.post('/:id/deactivate', requireAdmin, async (req, res) => {
  const organizationId = requireOrganization(req);
  const row = await queryOne<EmployeeRow>(
    `UPDATE employees
     SET active = false, deactivated_at = current_date,
         enrollment_photo_key = NULL, current_biometric_enrollment_id = NULL
     WHERE id = $1 AND organization_id = $2 RETURNING ${ADMIN_COLS}`,
    [req.params.id, organizationId]
  );
  if (!row) throw notFound('Empleado no encontrado');
  await recordAudit({
    organizationId,
    actorUserId: req.user!.id,
    action: 'employee.deactivated',
    entityType: 'employee',
    entityId: row.id,
  });
  res.json(adminEmployeeResponse(row));
});

employeesRouter.post('/:id/reactivate', requireAdmin, async (req, res) => {
  const organizationId = requireOrganization(req);
  const row = await queryOne<EmployeeRow>(
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
  res.json(adminEmployeeResponse(row));
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

const rateChangeSchema = z.object({
  hourly_rate: hourlyRateSchema,
  effective_from: isoDateSchema,
  reason: z.string().trim().min(3).max(2_000),
});

interface RateHistoryRow {
  id: string;
  hourly_rate: string;
  effective_from: string;
  effective_to: string | null;
}

function databaseErrorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' ? (error as { code?: string }).code : undefined;
}

employeesRouter.get('/:id/rates', requireAdmin, async (req, res) => {
  const organizationId = requireOrganization(req);
  const employee = await queryOne(
    `SELECT id FROM employees WHERE id = $1 AND organization_id = $2`,
    [req.params.id, organizationId]
  );
  if (!employee) throw notFound('Empleado no encontrado');
  res.json(
    await query(
      `SELECT id, hourly_rate::text, effective_from, effective_to,
              reason, created_at
       FROM employee_rates
       WHERE employee_id = $1 AND organization_id = $2
       ORDER BY effective_from DESC`,
      [req.params.id, organizationId]
    )
);
});

/**
 * Reemplazo explícito del endpoint inseguro que permitía intervalos arbitrarios.
 * Mantenerlo como 410 hace visible la migración a clientes antiguos.
 */
employeesRouter.post('/:id/rates', requireAdmin, (_req, res) => {
  res.status(410).json({
    error: 'Este endpoint fue retirado; usa POST /api/employees/:id/rates/change',
    code: 'RATE_ENDPOINT_RETIRED',
  });
});

employeesRouter.post('/:id/rates/change', requireAdmin, async (req, res) => {
  const organizationId = requireOrganization(req);
  const body = rateChangeSchema.parse(req.body);
  let row: RateHistoryRow & { reason: string; created_at: string };
  try {
    row = await withTransaction(async (client) => {
      // Advisory + row lock serialize all changes for one employee, including
      // concurrent requests arriving on different application instances.
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtext('employee-rate'), hashtext($1))`,
        [`${organizationId}:${req.params.id}`]
      );
      const employeeResult = await client.query<{ id: string; hired_at: string | null }>(
        `SELECT id, hired_at
         FROM employees
         WHERE id = $1 AND organization_id = $2
         FOR UPDATE`,
        [req.params.id, organizationId]
      );
      const employee = employeeResult.rows[0];
      if (!employee) throw notFound('Empleado no encontrado');
      if (employee.hired_at && body.effective_from < employee.hired_at) {
        throw conflict(
          'La tasa no puede iniciar antes de la fecha de contratación',
          'RATE_BEFORE_HIRE'
        );
      }

      const historyResult = await client.query<RateHistoryRow>(
        `SELECT id, hourly_rate::text, effective_from, effective_to
         FROM employee_rates
         WHERE employee_id = $1 AND organization_id = $2
         ORDER BY effective_from
         FOR UPDATE`,
        [employee.id, organizationId]
      );
      const history = historyResult.rows;
      const exact = history.find((rate) => rate.effective_from === body.effective_from);
      if (exact) {
        throw conflict(
          'Ya existe una tasa que inicia en esa fecha',
          'RATE_DATE_CONFLICT',
          { effective_from: body.effective_from }
        );
      }

      const covering = history.find(
        (rate) =>
          rate.effective_from < body.effective_from &&
          (rate.effective_to === null || rate.effective_to >= body.effective_from)
      );
      if (covering && covering.hourly_rate === canonicalHourlyRate(body.hourly_rate)) {
        throw conflict('La tasa nueva es igual a la vigente', 'RATE_UNCHANGED');
      }

      const next = history.find((rate) => rate.effective_from > body.effective_from);
      // The new fact applies through the day before the next known rate (or
      // indefinitely). Protect every finalized/reviewing payroll week touched
      // by that interval, not merely the week containing effective_from.
      const lockedPeriods = await client.query<{
        week_start: string;
        week_end: string;
        status: 'ready_for_review' | 'final';
      }>(
        `SELECT week_start, week_end, status
         FROM pay_periods
         WHERE organization_id = $1
           AND status IN ('ready_for_review', 'final')
           AND week_end >= $2::date
           AND ($3::date IS NULL OR week_start < $3::date)
         ORDER BY week_start
         LIMIT 20`,
        [organizationId, body.effective_from, next?.effective_from ?? null]
      );
      if (lockedPeriods.rows[0]) {
        const period = lockedPeriods.rows[0];
        throw conflict(
          period.status === 'final'
            ? 'La vigencia alcanzaría un periodo final; reabre todas las semanas afectadas antes de cambiar la tasa'
            : 'La vigencia alcanzaría un periodo en revisión; reanuda todas las semanas afectadas antes de cambiar la tasa',
          'RATE_PERIOD_LOCKED',
          {
            status: period.status,
            week_start: period.week_start,
            week_end: period.week_end,
            affected_locked_periods: lockedPeriods.rows.length,
            proposed_end_exclusive: next?.effective_from ?? null,
          }
        );
      }
      let closedEffectiveTo: string | null = null;
      if (covering) {
        const closed = await client.query<{ effective_to: string }>(
          `UPDATE employee_rates
           SET effective_to = $3::date - 1
           WHERE id = $1 AND organization_id = $2
           RETURNING effective_to`,
          [covering.id, organizationId, body.effective_from]
        );
        closedEffectiveTo = closed.rows[0]!.effective_to;
      }
      const inserted = await client.query<RateHistoryRow & { reason: string; created_at: string }>(
        `INSERT INTO employee_rates
           (organization_id, employee_id, hourly_rate, effective_from,
            effective_to, reason, created_by)
         VALUES ($1, $2, $3, $4, $5::date - 1, $6, $7)
         RETURNING id, hourly_rate::text, effective_from, effective_to,
                   reason, created_at`,
        [
          organizationId,
          employee.id,
          body.hourly_rate,
          body.effective_from,
          next?.effective_from ?? null,
          body.reason,
          req.user!.id,
        ]
      );
      const created = inserted.rows[0]!;
      await recordAudit(
        {
          organizationId,
          actorUserId: req.user!.id,
          action: 'employee.rate_changed',
          entityType: 'employee_rate',
          entityId: created.id,
          reason: body.reason,
          metadata: {
            employee_id: employee.id,
            old: covering
              ? {
                  rate_id: covering.id,
                  hourly_rate: covering.hourly_rate,
                  effective_from: covering.effective_from,
                  effective_to_before: covering.effective_to,
                  effective_to_after: closedEffectiveTo,
                }
              : null,
            new: {
              hourly_rate: created.hourly_rate,
              effective_from: created.effective_from,
              effective_to: created.effective_to,
            },
          },
        },
        client
      );
      return created;
    });
  } catch (error) {
    if (databaseErrorCode(error) === '23P01' || databaseErrorCode(error) === '23505') {
      throw conflict(
        'El historial cambió al mismo tiempo; recarga y vuelve a intentarlo',
        'RATE_HISTORY_CONFLICT'
      );
    }
    throw error;
  }
  res.status(201).json(row);
});
