import { Router } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { query, queryOne, withTransaction } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import {
  requireAuth,
  requireKiosk,
  requireOrganization,
  requireRole,
} from '../middleware/auth.js';
import { recordAudit } from '../services/auditService.js';
import type { FaceAttemptResult } from '../services/faceProvider.js';
import {
  FACE_IMAGE_MAX_BYTES,
  FACE_IMAGE_MIME_TYPES,
  startIdentitySession,
  submitIdentityAttempt,
  supportedFaceImage,
} from '../services/identityService.js';
import { accessiblePlantIds, assertPlantAccess } from '../services/tenantService.js';
import { storage } from '../storage.js';

export const kioskIdentityRouter = Router();
export const identityReviewsRouter = Router();

kioskIdentityRouter.use(
  requireKiosk,
  rateLimit({
    windowMs: 60_000,
    limit: 600,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.device!.id,
  })
);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: FACE_IMAGE_MAX_BYTES, files: 1, fields: 4 },
});

const punchType = z.enum(['shift_in', 'shift_out', 'meal_out', 'meal_in']);
const startSchema = z
  .object({
    employee_number: z.number().int().positive(),
    punch_type: punchType,
    client_event_id: z.string().uuid(),
    client_installation_id: z.string().uuid(),
    client_sequence: z.number().int().positive(),
    captured_at: z.string().datetime({ offset: true }),
  })
  .strict();

kioskIdentityRouter.post('/sessions', async (req, res) => {
  const body = startSchema.parse(req.body);
  const result = await startIdentitySession(req.device!, body);
  res.status(result.duplicate ? 200 : 201).json(result);
});

const debugResult = z.enum([
  'match',
  'no_match',
  'no_face',
  'multiple_faces',
  'liveness_failed',
  'quality_failed',
  'provider_error',
  'provider_unavailable',
  'no_enrollment',
  'review_only',
]);

const attemptFields = z
  .object({
    client_attempt_id: z.string().uuid(),
    captured_at: z.string().datetime({ offset: true }),
    fake_result: debugResult.optional(),
  })
  .strict();

kioskIdentityRouter.post(
  '/sessions/:id/attempts',
  upload.single('photo'),
  async (req, res) => {
    if (!req.file) throw badRequest('Falta archivo photo');
    const fields = attemptFields.parse(req.body);
    const contentType = req.file.mimetype.toLowerCase();
    if (!(FACE_IMAGE_MIME_TYPES as readonly string[]).includes(contentType)) {
      throw badRequest('La foto debe ser JPEG, PNG o WebP');
    }
    if (!supportedFaceImage(req.file.buffer, contentType)) {
      throw badRequest('El contenido no corresponde al tipo de imagen declarado');
    }
    if (fields.fake_result && process.env.NODE_ENV !== 'test' && process.env.NODE_ENV !== 'development') {
      throw forbidden('fake_result sólo está disponible en test/desarrollo');
    }
    const result = await submitIdentityAttempt(req.device!, {
      sessionId: z.string().uuid().parse(req.params.id),
      clientAttemptId: fields.client_attempt_id,
      capturedAt: fields.captured_at,
      photo: req.file.buffer,
      contentType,
      debugOutcome: fields.fake_result as FaceAttemptResult | undefined,
    });
    res.status(result.duplicate ? 200 : 201).json(result);
  }
);

identityReviewsRouter.use(requireAuth, requireRole('admin', 'foreman'));

const reviewListSchema = z.object({
  status: z.enum(['pending', 'resolved', 'all']).default('pending'),
  plant_id: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

interface ReviewListRow {
  session_id: string;
  punch_id: string;
  employee_id: string;
  employee_number: number;
  employee_name: string;
  plant_id: string;
  plant_name: string;
  punch_type: string;
  punched_at: Date;
  identity_status: string;
  session_status: string;
  review_reason: string | null;
  provider: string;
  provider_liveness_capable: boolean;
  liveness_status: string;
  similarity: string | number | null;
  attempt_count: number;
  decision_count: number;
  latest_evidence_key: string | null;
  enrollment_photo_key: string | null;
  total_count: number;
}

identityReviewsRouter.get('/', async (req, res) => {
  const organizationId = requireOrganization(req);
  const filters = reviewListSchema.parse(req.query);
  if (filters.plant_id) await assertPlantAccess(req, filters.plant_id);
  const where = ['s.organization_id = $1'];
  const params: unknown[] = [organizationId];
  if (req.user!.role === 'foreman') {
    params.push(await accessiblePlantIds(req.user!));
    where.push(`s.plant_id = ANY($${params.length}::uuid[])`);
  }
  if (filters.plant_id) {
    params.push(filters.plant_id);
    where.push(`s.plant_id = $${params.length}`);
  }
  if (filters.status === 'pending') where.push(`p.identity_status = 'identity_review'`);
  if (filters.status === 'resolved') {
    where.push(`p.identity_status IN ('review_approved', 'review_rejected')`);
  }
  if (filters.status === 'all') {
    where.push(`p.identity_status IN ('identity_review', 'review_approved', 'review_rejected')`);
  }
  params.push(filters.limit, filters.offset);
  const rows = await query<ReviewListRow>(
    `SELECT s.id AS session_id, p.id AS punch_id, e.id AS employee_id,
            e.employee_number, e.full_name AS employee_name, pl.id AS plant_id,
            pl.name AS plant_name, p.punch_type, p.punched_at, p.identity_status,
            s.status AS session_status, s.review_reason, s.provider,
            s.provider_liveness_capable, s.liveness_status, s.similarity,
            (SELECT count(*)::integer FROM identity_attempts a
             WHERE a.session_id = s.id OR a.session_id IN (
               SELECT al.alias_session_id FROM identity_session_punch_aliases al
               WHERE al.canonical_session_id = s.id
             )) AS attempt_count,
            (SELECT count(*)::integer FROM identity_review_decisions d WHERE d.session_id = s.id) AS decision_count,
            latest.evidence_key AS latest_evidence_key,
            b.photo_key AS enrollment_photo_key, count(*) OVER()::integer AS total_count
     FROM identity_sessions s
     JOIN punches p ON p.identity_session_id = s.id
     JOIN employees e ON e.id = s.employee_id AND e.organization_id = s.organization_id
     JOIN plants pl ON pl.id = s.plant_id AND pl.organization_id = s.organization_id
     LEFT JOIN biometric_enrollments b ON b.id = s.enrollment_id
     LEFT JOIN LATERAL (
       SELECT a.evidence_key FROM identity_attempts a
       WHERE (a.session_id = s.id OR a.session_id IN (
           SELECT al.alias_session_id FROM identity_session_punch_aliases al
           WHERE al.canonical_session_id = s.id
         ))
         AND NOT EXISTS (SELECT 1 FROM identity_evidence_purges ep WHERE ep.attempt_id = a.id)
       ORDER BY a.created_at DESC LIMIT 1
     ) latest ON true
     WHERE ${where.join(' AND ')}
     ORDER BY p.punched_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const total = rows[0]?.total_count ?? 0;
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.json({
    items: rows.map((row) => ({
        ...row,
        similarity: row.similarity === null ? null : Number(row.similarity),
        has_attempt_photo: Boolean(row.latest_evidence_key),
        has_enrollment_photo: Boolean(row.enrollment_photo_key),
        latest_evidence_key: undefined,
        enrollment_photo_key: undefined,
        total_count: undefined,
      })),
    total,
    next_offset: filters.offset + rows.length < total ? filters.offset + rows.length : null,
  });
});

interface ReviewDetailSession {
  session_id: string;
  organization_id: string;
  plant_id: string;
  plant_name: string;
  device_id: string;
  device_name: string;
  employee_id: string;
  employee_number: number;
  employee_name: string;
  enrollment_id: string | null;
  enrollment_photo_key: string | null;
  punch_id: string;
  punch_photo_key: string | null;
  punch_type: string;
  punched_at: Date;
  captured_at: Date;
  offline: boolean;
  identity_status: string;
  identity_bypass_reason: string | null;
  session_status: string;
  review_reason: string | null;
  provider: string;
  provider_liveness_capable: boolean;
  liveness_status: string;
  similarity: string | number | null;
  server_started_at: Date;
}

async function loadReviewDetail(req: Parameters<typeof requireOrganization>[0], sessionId: string) {
  const organizationId = requireOrganization(req);
  const session = await queryOne<ReviewDetailSession>(
    `SELECT s.id AS session_id, s.organization_id, s.plant_id, pl.name AS plant_name,
            s.device_id, dv.name AS device_name, s.employee_id, e.employee_number,
            e.full_name AS employee_name, s.enrollment_id,
            b.photo_key AS enrollment_photo_key, p.id AS punch_id,
            p.photo_key AS punch_photo_key, p.punch_type,
            p.punched_at, p.captured_at, p.offline, p.identity_status,
            p.identity_bypass_reason, s.status AS session_status, s.review_reason,
            s.provider, s.provider_liveness_capable, s.liveness_status, s.similarity,
            s.server_started_at
     FROM identity_sessions s
     JOIN punches p ON p.identity_session_id = s.id
     JOIN employees e ON e.id = s.employee_id AND e.organization_id = s.organization_id
     JOIN plants pl ON pl.id = s.plant_id AND pl.organization_id = s.organization_id
     JOIN devices dv ON dv.id = s.device_id AND dv.organization_id = s.organization_id
     LEFT JOIN biometric_enrollments b ON b.id = s.enrollment_id
     WHERE s.id = $1 AND s.organization_id = $2`,
    [sessionId, organizationId]
  );
  if (!session) throw notFound('Revisión de identidad no encontrada');
  await assertPlantAccess(req, session.plant_id);
  return session;
}

identityReviewsRouter.get('/:id', async (req, res) => {
  const session = await loadReviewDetail(req, req.params.id);
  const attempts = await query<{
    id: string;
    client_attempt_id: string;
    attempt_number: number | null;
    consumes_attempt: boolean;
    result: string;
    provider: string;
    liveness_status: string;
    similarity: string | number | null;
    evidence_key: string | null;
    purged_at: Date | null;
    captured_at: Date;
    created_at: Date;
    source_session_id: string;
    semantic_duplicate: boolean;
    source_enrollment_id: string | null;
    source_enrollment_photo_key: string | null;
  }>(
    `SELECT a.id, a.client_attempt_id, a.attempt_number, a.consumes_attempt, a.result,
            a.provider, a.liveness_status, a.similarity,
            CASE WHEN ep.attempt_id IS NULL THEN a.evidence_key END AS evidence_key,
            ep.purged_at, a.captured_at, a.created_at,
            a.session_id AS source_session_id, (a.session_id <> $1::uuid) AS semantic_duplicate,
            src.enrollment_id AS source_enrollment_id,
            src_enrollment.photo_key AS source_enrollment_photo_key
     FROM identity_attempts a
     JOIN identity_sessions src ON src.id = a.session_id
     LEFT JOIN biometric_enrollments src_enrollment ON src_enrollment.id = src.enrollment_id
     LEFT JOIN identity_evidence_purges ep ON ep.attempt_id = a.id
     WHERE a.organization_id = $2 AND (
       a.session_id = $1 OR a.session_id IN (
         SELECT al.alias_session_id FROM identity_session_punch_aliases al
         WHERE al.canonical_session_id = $1
       )
     )
     ORDER BY a.created_at`,
    [session.session_id, session.organization_id]
  );
  const decisions = await query<{
    id: string;
    decision: string;
    reason: string;
    decided_by: string;
    decided_by_name: string;
    created_at: Date;
  }>(
    `SELECT d.id, d.decision, d.reason, d.decided_by, u.name AS decided_by_name, d.created_at
     FROM identity_review_decisions d
     JOIN users u ON u.id = d.decided_by AND u.organization_id = d.organization_id
     WHERE d.session_id = $1 AND d.organization_id = $2
     ORDER BY d.created_at`,
    [session.session_id, session.organization_id]
  );
  const aliases = await query<{
    session_id: string;
    status: string;
    review_reason: string | null;
    provider: string;
    liveness_status: string;
    similarity: string | number | null;
    client_event_id: string;
    enrollment_id: string | null;
    enrollment_photo_key: string | null;
    created_at: Date;
  }>(
    `SELECT s.id AS session_id, s.status, s.review_reason, s.provider,
            s.liveness_status, s.similarity, s.client_event_id, s.enrollment_id,
            b.photo_key AS enrollment_photo_key, al.created_at
     FROM identity_session_punch_aliases al
     JOIN identity_sessions s ON s.id = al.alias_session_id
     LEFT JOIN biometric_enrollments b ON b.id = s.enrollment_id
     WHERE al.canonical_session_id = $1 AND al.organization_id = $2
     ORDER BY al.created_at`,
    [session.session_id, session.organization_id]
  );
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.json({
    session: {
      id: session.session_id,
      status: session.session_status,
      review_reason: session.review_reason,
      provider: session.provider,
      provider_liveness_capable: session.provider_liveness_capable,
      liveness_status: session.liveness_status,
      similarity: session.similarity === null ? null : Number(session.similarity),
      server_started_at: session.server_started_at,
    },
    punch: {
      id: session.punch_id,
      punch_type: session.punch_type,
      punched_at: session.punched_at,
      captured_at: session.captured_at,
      offline: session.offline,
      identity_status: session.identity_status,
      identity_bypass_reason: session.identity_bypass_reason,
      photo_url: session.punch_photo_key
        ? await storage.viewUrl(session.punch_photo_key)
        : null,
    },
    employee: {
      id: session.employee_id,
      employee_number: session.employee_number,
      full_name: session.employee_name,
      enrollment_id: session.enrollment_id,
      enrollment_photo_url: session.enrollment_photo_key
        ? await storage.viewUrl(session.enrollment_photo_key)
        : null,
    },
    plant: { id: session.plant_id, name: session.plant_name },
    device: { id: session.device_id, name: session.device_name },
    attempts: await Promise.all(
      attempts.map(async ({ evidence_key, similarity, source_enrollment_photo_key, ...attempt }) => ({
        ...attempt,
        similarity: similarity === null ? null : Number(similarity),
        evidence_url: evidence_key ? await storage.viewUrl(evidence_key) : null,
        source_enrollment_photo_url: source_enrollment_photo_key
          ? await storage.viewUrl(source_enrollment_photo_key)
          : null,
      }))
    ),
    aliases: await Promise.all(
      aliases.map(async ({ enrollment_photo_key, ...alias }) => ({
        ...alias,
        similarity: alias.similarity === null ? null : Number(alias.similarity),
        enrollment_photo_url: enrollment_photo_key
          ? await storage.viewUrl(enrollment_photo_key)
          : null,
      }))
    ),
    decisions,
  });
});

const decisionSchema = z
  .object({
    decision: z.enum(['approve', 'reject']),
    reason: z.string().trim().min(3).max(500),
  })
  .strict();

identityReviewsRouter.post('/:id/decisions', async (req, res) => {
  const body = decisionSchema.parse(req.body);
  const detail = await loadReviewDetail(req, req.params.id);
  const identityStatus = body.decision === 'approve' ? 'review_approved' : 'review_rejected';
  const result = await withTransaction(async (client) => {
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext('identity-review'), hashtext($1))`,
      [detail.punch_id]
    );
    const locked = await client.query<{ identity_status: string; punched_at: Date }>(
      `SELECT identity_status, punched_at FROM punches
       WHERE id = $1 AND organization_id = $2 AND identity_session_id = $3
       FOR UPDATE`,
      [detail.punch_id, detail.organization_id, detail.session_id]
    );
    if (!locked.rows[0]) throw notFound('Checada de la revisión no encontrada');
    const prior = await client.query<{
      id: string;
      decision: 'approve' | 'reject';
      reason: string;
      decided_by: string;
      created_at: Date;
    }>(
      `SELECT id, decision, reason, decided_by, created_at
       FROM identity_review_decisions
       WHERE session_id = $1 AND punch_id = $2`,
      [detail.session_id, detail.punch_id]
    );
    if (prior.rows[0]) {
      if (prior.rows[0].decision !== body.decision || prior.rows[0].reason !== body.reason) {
        throw conflict('La revisión ya tiene una decisión final diferente', 'identity_review_final');
      }
      return { decision: prior.rows[0], duplicate: true };
    }
    if (locked.rows[0].identity_status !== 'identity_review') {
      throw conflict('La checada ya no está pendiente de revisión', 'identity_review_not_pending');
    }
    const missingEvidence = await client.query<{ client_event_id: string }>(
      `SELECT r.client_event_id
       FROM device_event_receipts r
       JOIN identity_sessions es
         ON es.device_id = r.device_id AND es.client_event_id = r.client_event_id
        AND es.employee_id = r.employee_id AND es.organization_id = r.organization_id
       WHERE r.punch_id = $1 AND r.evidence_status = 'captured'
         AND NOT EXISTS (
           SELECT 1 FROM identity_attempts a WHERE a.session_id = es.id
         )
       ORDER BY r.created_at`,
      [detail.punch_id]
    );
    if (missingEvidence.rows.length) {
      throw conflict(
        'Aún hay fotografías del kiosco pendientes de sincronizar',
        'identity_evidence_pending',
        { client_event_ids: missingEvidence.rows.map((row) => row.client_event_id) }
      );
    }
    const inserted = await client.query(
      `INSERT INTO identity_review_decisions
         (organization_id, plant_id, session_id, punch_id, employee_id,
          decision, reason, decided_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, decision, reason, decided_by, created_at`,
      [
        detail.organization_id,
        detail.plant_id,
        detail.session_id,
        detail.punch_id,
        detail.employee_id,
        body.decision,
        body.reason,
        req.user!.id,
      ]
    );
    // Deliberately project only identity_status. Time, type, voided and every
    // payroll-bearing field remain untouched by an identity rejection.
    await client.query(`UPDATE punches SET identity_status = $2 WHERE id = $1`, [
      detail.punch_id,
      identityStatus,
    ]);
    await recordAudit(
      {
        organizationId: detail.organization_id,
        actorUserId: req.user!.id,
        action: `identity_review.${body.decision}`,
        entityType: 'punch',
        entityId: detail.punch_id,
        reason: body.reason,
        metadata: {
          session_id: detail.session_id,
          previous_identity_status: locked.rows[0].identity_status,
          new_identity_status: identityStatus,
          punched_at_unchanged: locked.rows[0].punched_at.toISOString(),
        },
      },
      client
    );
    return { decision: inserted.rows[0], duplicate: false };
  });
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.status(result.duplicate ? 200 : 201).json({
    ok: true,
    duplicate: result.duplicate,
    identity_status: identityStatus,
    decision: result.decision,
  });
});
