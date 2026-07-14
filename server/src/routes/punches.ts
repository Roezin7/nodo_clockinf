import { Router } from 'express';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { query, queryOne, withTransaction } from '../db.js';
import { badRequest, conflict, notFound, unauthorized, HttpError } from '../errors.js';
import {
  requireAuth,
  requireKiosk,
  requireOrganization,
  requireRole,
} from '../middleware/auth.js';
import { lockedForSeconds, recordFailure, recordSuccess } from '../services/pinLimiter.js';
import { getSettings } from '../services/settingsService.js';
import { formatLocalTime, localToUtc, workDateOf } from '../services/time.js';
import { storage } from '../storage.js';
import type { PunchType } from '../types.js';
import { accessiblePlantIds, assertPlantAccess } from '../services/tenantService.js';
import { recordAudit } from '../services/auditService.js';
import { ensurePeriodOpen } from '../services/payPeriodService.js';
import {
  deviceEventMatches,
  normalizeCapturedAtSnapshot,
  sortDeviceEvents,
  validateCapturedAt,
} from '../services/deviceSync.js';
import {
  FACE_IMAGE_MAX_BYTES,
  FACE_IMAGE_MIME_TYPES,
  punchPhotoAttemptId,
  resolvePunchIdentity,
  supportedFaceImage,
  type PunchIdentityResolution,
} from '../services/identityService.js';

export const punchesRouter = Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: FACE_IMAGE_MAX_BYTES } });

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

const punchTypeSchema = z.enum(['shift_in', 'shift_out', 'meal_out', 'meal_in']);
const identityBypassSchema = z.enum([
  'camera_unavailable',
  'provider_unavailable',
  'offline',
  'incomplete_session',
  'legacy_pin',
]);
const deviceEventSchema = z
  .object({
    employee_number: z.number().int().positive(),
    punch_type: punchTypeSchema,
    client_event_id: z.string().uuid(),
    client_installation_id: z.string().uuid(),
    captured_at: z.string().datetime({ offset: true }),
    client_sequence: z.number().int().positive(),
    client_clock_skew_seconds: z.number().int().nullable(),
    evidence_status: z.enum(['captured', 'camera_unavailable']),
    identity_session_id: z.string().uuid().nullish(),
    identity_bypass_reason: identityBypassSchema.nullish(),
  })
  .strict();
const ingestSchema = deviceEventSchema.extend({
  pin: z.string().regex(/^\d{4}$/).nullish(),
  source: z.literal('kiosk'),
});
const syncSchema = z.object({ events: z.array(z.unknown()).min(1).max(100) }).strict();

/**
 * One-time enrollment exchange. The enrollment code can never authenticate a
 * kiosk request: it is atomically replaced by a fresh permanent credential.
 */
punchesRouter.post('/kiosk/enroll', async (req, res) => {
  const body = z
    .object({
      enrollment_token: z.string().min(20).max(512),
      // 32 random bytes encoded as unpadded base64url are 43 characters.
      proposed_device_token: z
        .string()
        .min(43)
        .max(172)
        .regex(/^[A-Za-z0-9_-]+$/),
    })
    .strict()
    .parse(req.body);
  const enrollmentHash = crypto
    .createHash('sha256')
    .update(body.enrollment_token)
    .digest('hex');
  const deviceTokenHash = crypto
    .createHash('sha256')
    .update(body.proposed_device_token)
    .digest('hex');
  type EnrollmentDevice = {
    id: string;
    public_id: string;
    name: string;
    organization_id: string;
    plant_id: string;
    plant_code: string;
    plant_name: string;
    timezone: string;
    enrolled_at: Date;
  };
  let device = await queryOne<EnrollmentDevice>(
    `UPDATE devices d
     SET token_hash = $2, enrolled_at = now(), last_seen_at = now()
     FROM plants p, organizations o
     WHERE d.token_hash = $1 AND d.enrolled_at IS NULL AND d.active
       AND p.id = d.plant_id AND p.organization_id = d.organization_id AND p.active
       AND o.id = d.organization_id AND o.active
     RETURNING d.id, d.public_id, d.name, d.organization_id, d.plant_id,
               p.code AS plant_code, p.name AS plant_name, o.timezone, d.enrolled_at`,
    [enrollmentHash, deviceTokenHash]
  );
  let alreadyEnrolled = false;
  if (!device) {
    // Lost-response recovery: possession of the proposed credential is enough
    // to prove the caller can authenticate this already-enrolled device.
    device = await queryOne<EnrollmentDevice>(
      `SELECT d.id, d.public_id, d.name, d.organization_id, d.plant_id,
              p.code AS plant_code, p.name AS plant_name, o.timezone, d.enrolled_at
       FROM devices d
       JOIN plants p ON p.id = d.plant_id AND p.organization_id = d.organization_id AND p.active
       JOIN organizations o ON o.id = d.organization_id AND o.active
       WHERE d.token_hash = $1 AND d.enrolled_at IS NOT NULL AND d.active`,
      [deviceTokenHash]
    );
    alreadyEnrolled = Boolean(device);
  }
  if (!device) throw unauthorized('Código de activación inválido o ya utilizado');
  res.status(alreadyEnrolled ? 200 : 201).json({
    device,
    server_time: new Date().toISOString(),
    already_enrolled: alreadyEnrolled,
  });
});

interface ExistingDevicePunch {
  id: string;
  employee_number: number;
  employee_name: string;
  punch_type: PunchType;
  punched_at: Date;
  captured_at: Date;
  client_installation_id: string;
  client_sequence: string | number;
  client_clock_skew_seconds: number | null;
  evidence_status: 'captured' | 'camera_unavailable';
  identity_session_id: string | null;
  identity_bypass_reason: string | null;
  identity_status: 'verified' | 'identity_review' | 'review_approved' | 'review_rejected' | 'not_required';
}

interface DeviceEvent {
  employee_number: number;
  punch_type: PunchType;
  client_event_id: string;
  client_installation_id: string;
  captured_at: string;
  client_sequence: number;
  client_clock_skew_seconds: number | null;
  evidence_status: 'captured' | 'camera_unavailable';
  identity_session_id?: string | null;
  identity_bypass_reason?: PunchIdentityResolution['bypassReason'];
}

async function existingDevicePunch(
  deviceId: string,
  clientEventId: string
): Promise<ExistingDevicePunch | null> {
  const receipt = await queryOne<ExistingDevicePunch>(
    `SELECT p.id, e.employee_number, e.full_name AS employee_name,
            p.punch_type, p.punched_at, r.captured_at, r.client_installation_id,
            r.client_sequence, r.client_clock_skew_seconds,
            r.evidence_status, r.submitted_identity_session_id AS identity_session_id,
            r.submitted_identity_bypass_reason AS identity_bypass_reason,
            p.identity_status
     FROM device_event_receipts r
     JOIN punches p ON p.id = r.punch_id AND p.device_id = r.device_id
     JOIN employees e ON e.id = r.employee_id AND e.organization_id = r.organization_id
     WHERE r.device_id = $1 AND r.client_event_id = $2`,
    [deviceId, clientEventId]
  );
  if (receipt) return receipt;
  // Migration/rollback compatibility for a punch written before receipts.
  return queryOne<ExistingDevicePunch>(
    `SELECT p.id, e.employee_number, e.full_name AS employee_name,
            p.punch_type, p.punched_at, p.captured_at, p.client_installation_id,
            p.client_sequence, p.client_clock_skew_seconds,
            p.evidence_status, p.identity_session_id, p.identity_bypass_reason,
            p.identity_status
     FROM punches p
     JOIN employees e ON e.id = p.employee_id AND e.organization_id = p.organization_id
     WHERE p.device_id = $1 AND p.client_event_id = $2`,
    [deviceId, clientEventId]
  );
}

async function insertDeviceReceipt(
  client: PoolClient,
  input: {
    organizationId: string;
    plantId: string;
    deviceId: string;
    punchId: string;
    employeeId: string;
    event: DeviceEvent;
    identity: Pick<PunchIdentityResolution, 'sessionId' | 'bypassReason'>;
    disposition: 'new_punch' | 'semantic_duplicate';
  }
): Promise<void> {
  await client.query(
    `INSERT INTO device_event_receipts
       (organization_id, plant_id, device_id, client_event_id, client_installation_id,
        client_sequence, client_clock_skew_seconds,
        punch_id, employee_id, punch_type, captured_at, evidence_status, disposition,
        identity_session_id, identity_bypass_reason, submitted_identity_session_id,
        submitted_identity_bypass_reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
             $14, $15, $16, $17)`,
    [
      input.organizationId,
      input.plantId,
      input.deviceId,
      input.event.client_event_id,
      input.event.client_installation_id,
      input.event.client_sequence,
      input.event.client_clock_skew_seconds,
      input.punchId,
      input.employeeId,
      input.event.punch_type,
      new Date(input.event.captured_at),
      input.event.evidence_status,
      input.disposition,
      input.identity.sessionId,
      input.identity.bypassReason,
      input.event.identity_session_id ?? null,
      input.event.identity_bypass_reason ?? null,
    ]
  );
}

async function semanticDuplicatePunch(
  client: PoolClient,
  deviceId: string,
  employeeId: string,
  event: DeviceEvent
): Promise<ExistingDevicePunch | null> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`, [
    deviceId,
    employeeId,
  ]);
  const result = await client.query<ExistingDevicePunch>(
    `SELECT p.id, e.employee_number, e.full_name AS employee_name,
            p.punch_type, p.punched_at, $5::timestamptz AS captured_at,
            $4::uuid AS client_installation_id, $6::bigint AS client_sequence,
            $7::text AS evidence_status, $8::integer AS client_clock_skew_seconds,
            p.identity_session_id, p.identity_bypass_reason, p.identity_status
     FROM punches p
     JOIN employees e ON e.id = p.employee_id AND e.organization_id = p.organization_id
     WHERE p.device_id = $1 AND p.employee_id = $2 AND p.punch_type = $3
       AND p.identity_status IN ('verified', 'identity_review')
       AND p.client_installation_id = $4::uuid
       AND abs(extract(epoch FROM (p.captured_at - $5::timestamptz))) <= 3
       AND p.evidence_status = $7
       AND p.client_clock_skew_seconds IS NOT DISTINCT FROM $8::integer
     ORDER BY abs(extract(epoch FROM (p.captured_at - $5::timestamptz))), p.created_at
     LIMIT 1`,
    [
      deviceId,
      employeeId,
      event.punch_type,
      event.client_installation_id,
      new Date(event.captured_at),
      event.client_sequence,
      event.evidence_status,
      event.client_clock_skew_seconds,
    ]
  );
  return result.rows[0] ?? null;
}

async function lockOpenSemanticCandidate(
  client: PoolClient,
  semantic: ExistingDevicePunch
): Promise<ExistingDevicePunch | null> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext('identity-review'), hashtext($1))`, [
    semantic.id,
  ]);
  const current = await client.query<{
    identity_status: ExistingDevicePunch['identity_status'];
    identity_session_id: string | null;
    identity_bypass_reason: string | null;
  }>(
    `SELECT identity_status, identity_session_id, identity_bypass_reason
     FROM punches WHERE id = $1 FOR UPDATE`,
    [semantic.id]
  );
  if (
    !current.rows[0] ||
    !['verified', 'identity_review'].includes(current.rows[0].identity_status)
  ) {
    return null;
  }
  return { ...semantic, ...current.rows[0] };
}

async function preserveSemanticIdentityAlias(
  client: PoolClient,
  input: {
    organizationId: string;
    plantId: string;
    deviceId: string;
    employeeId: string;
    semantic: ExistingDevicePunch;
    aliasSessionId: string | null;
    aliasIdentityStatus: 'verified' | 'identity_review';
  }
): Promise<ExistingDevicePunch['identity_status']> {
  if (
    !input.aliasSessionId ||
    !input.semantic.identity_session_id ||
    input.aliasSessionId === input.semantic.identity_session_id
  ) {
    return input.semantic.identity_status;
  }
  const inserted = await client.query<{ alias_session_id: string }>(
    `INSERT INTO identity_session_punch_aliases
       (alias_session_id, canonical_punch_id, canonical_session_id,
        organization_id, plant_id, device_id, employee_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (alias_session_id) DO NOTHING
     RETURNING alias_session_id`,
    [
      input.aliasSessionId,
      input.semantic.id,
      input.semantic.identity_session_id,
      input.organizationId,
      input.plantId,
      input.deviceId,
      input.employeeId,
    ]
  );
  if (!inserted.rows[0]) {
    const existing = await client.query<{
      canonical_punch_id: string;
      canonical_session_id: string;
    }>(
      `SELECT canonical_punch_id, canonical_session_id
       FROM identity_session_punch_aliases WHERE alias_session_id = $1`,
      [input.aliasSessionId]
    );
    if (
      !existing.rows[0] ||
      existing.rows[0].canonical_punch_id !== input.semantic.id ||
      existing.rows[0].canonical_session_id !== input.semantic.identity_session_id
    ) {
      throw conflict(
        'La sesión alias ya pertenece a otra checada',
        'identity_alias_payload_conflict'
      );
    }
  }
  if (input.aliasIdentityStatus === 'identity_review' && input.semantic.identity_status === 'verified') {
    await client.query(
      `UPDATE punches SET identity_status = 'identity_review', face_check_status = 'pending'
       WHERE id = $1 AND identity_status = 'verified'`,
      [input.semantic.id]
    );
    return 'identity_review';
  }
  return input.semantic.identity_status;
}

function successfulSyncResult(
  status: 'accepted' | 'duplicate',
  event: DeviceEvent,
  punch: ExistingDevicePunch,
  timezone: string
) {
  return {
    client_event_id: event.client_event_id,
    client_sequence: event.client_sequence,
    status,
    punch_id: punch.id,
    employee_name: punch.employee_name,
    punch_type: punch.punch_type,
    punched_at: punch.punched_at.toISOString(),
    punched_at_local: formatLocalTime(punch.punched_at, timezone),
    timezone,
    evidence_status: punch.evidence_status,
    identity_status: punch.identity_status,
  } as const;
}

function databaseConstraint(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  return (error as { constraint?: string }).constraint;
}

/**
 * Online kiosk ingestion. The server receipt time is authoritative for payroll;
 * captured_at remains immutable evidence of the tablet clock. Idempotency is by
 * device + client event UUID and never expires.
 * La foto NO viaja aquí: se sube después a /api/punches/:id/photo para que
 * la respuesta salga en <300ms y no detenga la fila.
 */
punchesRouter.post('/ingest', requireKiosk, async (req, res) => {
  const body = ingestSchema.parse(req.body);
  const device = req.device!;
  const organizationId = device.organizationId;
  const plantId = device.plantId;
  const settings = await getSettings(organizationId);

  const existing = await existingDevicePunch(device.id, body.client_event_id);
  if (existing) {
    if (!deviceEventMatches(existing, body)) {
      throw conflict(
        'El UUID del evento ya existe con datos diferentes',
        'client_event_payload_conflict'
      );
    }
    res.status(200).json({
      punch_id: existing.id,
      employee_name: existing.employee_name,
      punch_type: existing.punch_type,
      punch_type_inferred: existing.punch_type,
      punched_at: existing.punched_at.toISOString(),
      punched_at_local: formatLocalTime(existing.punched_at, settings.timezone),
      timezone: settings.timezone,
      evidence_status: existing.evidence_status,
      identity_status: existing.identity_status,
      duplicate: true,
    });
    return;
  }

  const employee = await queryOne<{ id: string; full_name: string; pin_hash: string; default_shift_id: string | null }>(
    `SELECT id, full_name, pin_hash, default_shift_id FROM employees
     WHERE organization_id = $1 AND employee_number = $2 AND active`,
    [organizationId, body.employee_number]
  );
  if (!employee) {
    if (body.pin) recordFailure(organizationId, body.employee_number);
    throw unauthorized(body.pin ? 'Número o PIN incorrecto' : 'Empleado activo no encontrado');
  }
  if (body.pin) {
    const lockSeconds = lockedForSeconds(organizationId, body.employee_number);
    if (lockSeconds > 0) {
      throw new HttpError(429, `Bloqueado por intentos fallidos. Espera ${lockSeconds}s`, 'pin_locked');
    }
    if (!(await bcrypt.compare(body.pin, employee.pin_hash))) {
      recordFailure(organizationId, body.employee_number);
      throw unauthorized('Número o PIN incorrecto');
    }
    recordSuccess(organizationId, body.employee_number);
  }

  const tz = settings.timezone;
  const receivedAt = new Date();
  const capturedAt = new Date(body.captured_at);
  let created: { punch: ExistingDevicePunch; duplicate: boolean };
  try {
    created = await withTransaction(async (client) => {
      const identity = await resolvePunchIdentity(client, {
        device,
        employeeId: employee.id,
        employeeNumber: body.employee_number,
        clientEventId: body.client_event_id,
        clientInstallationId: body.client_installation_id,
        clientSequence: body.client_sequence,
        capturedAt,
        punchType: body.punch_type,
        identitySessionId: body.identity_session_id ?? null,
        bypassReason:
          body.identity_bypass_reason ?? (body.pin ? 'legacy_pin' : 'incomplete_session'),
        offline: false,
        onlineReceivedAt: receivedAt,
      });
      const workDate = workDateOf(identity.payableAt, tz);
      await ensurePeriodOpen(client, organizationId, workDate, tz);
      let semantic = await semanticDuplicatePunch(client, device.id, employee.id, body);
      if (semantic) semantic = await lockOpenSemanticCandidate(client, semantic);
      if (semantic && identity.sessionId && !semantic.identity_session_id) semantic = null;
      if (semantic) {
        const canonicalIdentityStatus = await preserveSemanticIdentityAlias(client, {
          organizationId,
          plantId,
          deviceId: device.id,
          employeeId: employee.id,
          semantic,
          aliasSessionId: identity.sessionId,
          aliasIdentityStatus: identity.identityStatus,
        });
        await insertDeviceReceipt(client, {
          organizationId,
          plantId,
          deviceId: device.id,
          punchId: semantic.id,
          employeeId: employee.id,
          event: body,
          identity: {
            sessionId: semantic.identity_session_id,
            bypassReason: semantic.identity_bypass_reason as PunchIdentityResolution['bypassReason'],
          },
          disposition: 'semantic_duplicate',
        });
        await recordAudit(
          {
            organizationId,
            actorDeviceId: device.id,
            action: 'punch.kiosk_semantic_duplicate',
            entityType: 'punch',
            entityId: semantic.id,
            metadata: {
              client_event_id: body.client_event_id,
              client_installation_id: body.client_installation_id,
              client_sequence: body.client_sequence,
              client_clock_skew_seconds: body.client_clock_skew_seconds,
              captured_at: body.captured_at,
            },
          },
          client
        );
        return {
          punch: {
            ...semantic,
            identity_status: canonicalIdentityStatus,
            identity_session_id: body.identity_session_id ?? null,
            identity_bypass_reason: body.identity_bypass_reason ?? null,
          },
          duplicate: true,
        };
      }
      const assignment = await client.query<{ area_id: string }>(
        `SELECT area_id FROM daily_area_assignments
         WHERE employee_id = $1 AND work_date = $2
           AND organization_id = $3 AND plant_id = $4
         ORDER BY id DESC LIMIT 1`,
        [employee.id, workDate, organizationId, plantId]
      );
      const inserted = await client.query<{ id: string; punched_at: Date }>(
        `INSERT INTO punches
           (organization_id, plant_id, device_id, client_event_id, client_installation_id,
            client_sequence,
            client_clock_skew_seconds, evidence_status, employee_id, punch_type, punched_at,
            captured_at, received_at, area_id, identity_session_id, identity_bypass_reason,
            source, offline, identity_status, face_check_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
                 $15, $16, 'kiosk', false, $17, $18)
         ON CONFLICT (device_id, client_event_id)
           WHERE device_id IS NOT NULL AND client_event_id IS NOT NULL
         DO NOTHING
         RETURNING id, punched_at`,
        [
          organizationId,
          plantId,
          device.id,
          body.client_event_id,
          body.client_installation_id,
          body.client_sequence,
          body.client_clock_skew_seconds,
          body.evidence_status,
          employee.id,
          body.punch_type,
          identity.payableAt,
          capturedAt,
          receivedAt,
          assignment.rows[0]?.area_id ?? null,
          identity.sessionId,
          identity.bypassReason,
          identity.identityStatus,
          identity.identityStatus === 'verified'
            ? 'match'
            : body.evidence_status === 'camera_unavailable'
              ? 'skipped'
              : 'pending',
        ]
      );
      if (!inserted.rows[0]) {
        const duplicate = await client.query<ExistingDevicePunch>(
          `SELECT p.id, e.employee_number, e.full_name AS employee_name,
                  p.punch_type, p.punched_at, r.captured_at, r.client_installation_id,
                  r.client_sequence, r.client_clock_skew_seconds, r.evidence_status,
                  r.submitted_identity_session_id AS identity_session_id,
                  r.submitted_identity_bypass_reason AS identity_bypass_reason,
                  p.identity_status
           FROM device_event_receipts r
           JOIN punches p ON p.id = r.punch_id AND p.device_id = r.device_id
           JOIN employees e ON e.id = r.employee_id
           WHERE r.device_id = $1 AND r.client_event_id = $2`,
          [device.id, body.client_event_id]
        );
        if (!duplicate.rows[0]) throw new Error('idempotent punch disappeared');
        return { punch: duplicate.rows[0], duplicate: true };
      }
      await insertDeviceReceipt(client, {
        organizationId,
        plantId,
        deviceId: device.id,
        punchId: inserted.rows[0].id,
        employeeId: employee.id,
        event: body,
        identity,
        disposition: 'new_punch',
      });
      await recordAudit(
        {
          organizationId,
          actorDeviceId: device.id,
          action: 'punch.kiosk_created',
          entityType: 'punch',
          entityId: inserted.rows[0].id,
          metadata: {
            client_event_id: body.client_event_id,
            client_installation_id: body.client_installation_id,
            client_sequence: body.client_sequence,
            client_clock_skew_seconds: body.client_clock_skew_seconds,
            evidence_status: body.evidence_status,
            offline: false,
          },
        },
        client
      );
      return {
        punch: {
          id: inserted.rows[0].id,
          employee_number: body.employee_number,
          employee_name: employee.full_name,
          punch_type: body.punch_type,
          punched_at: inserted.rows[0].punched_at,
          captured_at: capturedAt,
          client_installation_id: body.client_installation_id,
          client_sequence: body.client_sequence,
          client_clock_skew_seconds: body.client_clock_skew_seconds,
          evidence_status: body.evidence_status,
          identity_session_id: body.identity_session_id ?? null,
          identity_bypass_reason: body.identity_bypass_reason ?? null,
          identity_status: identity.identityStatus,
        },
        duplicate: false,
      };
    });
  } catch (error) {
    const concurrent = await existingDevicePunch(device.id, body.client_event_id);
    if (concurrent) {
      if (!deviceEventMatches(concurrent, body)) {
        throw conflict(
          'El UUID del evento ya existe con datos diferentes',
          'client_event_payload_conflict'
        );
      }
      created = { punch: concurrent, duplicate: true };
    } else if (
      databaseConstraint(error) === 'punches_device_sequence_idx' ||
      databaseConstraint(error) === 'receipts_device_install_sequence_unique'
    ) {
      throw conflict(
        'La secuencia del dispositivo ya fue usada por otro evento',
        'client_sequence_conflict'
      );
    } else {
      throw error;
    }
  }

  if (created.duplicate && !deviceEventMatches(created.punch, body)) {
    throw conflict('El UUID del evento ya existe con datos diferentes', 'client_event_payload_conflict');
  }

  res.status(created.duplicate ? 200 : 201).json({
    punch_id: created.punch.id,
    employee_name: created.punch.employee_name,
    punch_type: created.punch.punch_type,
    punch_type_inferred: created.punch.punch_type,
    punched_at: created.punch.punched_at.toISOString(),
    // El kiosco muestra ESTA hora, formateada por el servidor: nunca la del dispositivo
    punched_at_local: formatLocalTime(created.punch.punched_at, tz),
    timezone: tz,
    evidence_status: created.punch.evidence_status,
    identity_status: created.punch.identity_status,
    duplicate: created.duplicate,
  });
});

/** Device identity and time anchor used at kiosk startup. */
punchesRouter.get('/kiosk/self', requireKiosk, async (req, res) => {
  const device = req.device!;
  const row = await queryOne(
    `SELECT d.id, d.public_id, d.name, d.organization_id, d.plant_id,
            d.enrolled_at, d.last_seen_at, d.last_sync_at, d.last_heartbeat_at,
            d.pending_event_count, d.rejected_event_count, d.app_version, d.camera_status,
            d.storage_status, d.clock_skew_seconds, d.last_error, p.code AS plant_code,
            p.name AS plant_name, o.name AS organization_name, o.timezone
     FROM devices d
     JOIN plants p ON p.id = d.plant_id AND p.organization_id = d.organization_id
     JOIN organizations o ON o.id = d.organization_id
     WHERE d.id = $1`,
    [device.id]
  );
  if (!row) throw unauthorized('Dispositivo no disponible');
  res.json({ ...row, server_time: new Date().toISOString() });
});

const heartbeatSchema = z.object({
  pending_count: z.number().int().min(0).max(1_000_000).nullable().optional(),
  rejected_count: z.number().int().min(0).max(1_000_000).nullable().optional(),
  app_version: z.string().trim().min(1).max(64),
  camera_status: z.enum(['unknown', 'ready', 'degraded', 'unavailable']).optional(),
  storage_status: z.enum(['unknown', 'ready', 'degraded', 'unavailable']).optional(),
  client_time: z.string().datetime({ offset: true }).optional(),
  last_error: z.string().trim().max(500).nullable().optional(),
});

punchesRouter.post('/kiosk/heartbeat', requireKiosk, async (req, res) => {
  const body = heartbeatSchema.parse(req.body);
  const device = req.device!;
  const serverTime = new Date();
  const clockSkewSeconds = body.client_time
    ? Math.round((new Date(body.client_time).getTime() - serverTime.getTime()) / 1000)
    : null;
  await query(
    `UPDATE devices
     SET last_seen_at = now(), last_heartbeat_at = now(),
         pending_event_count = COALESCE($2, pending_event_count),
         rejected_event_count = COALESCE($3, rejected_event_count), app_version = $4,
         camera_status = COALESCE($5, camera_status),
         storage_status = COALESCE($6, storage_status),
         clock_skew_seconds = COALESCE($7, clock_skew_seconds), last_error = $8,
         last_ip = $9::inet
     WHERE id = $1`,
    [
      device.id,
      body.pending_count ?? null,
      body.rejected_count ?? null,
      body.app_version,
      body.camera_status ?? null,
      body.storage_status ?? null,
      clockSkewSeconds,
      body.last_error ?? null,
      req.ip,
    ]
  );
  res.json({ ok: true, server_time: serverTime.toISOString(), clock_skew_seconds: clockSkewSeconds });
});

/**
 * Durable offline queue synchronization. Every syntactically valid event gets
 * its own transaction so a closed week or corrupt event cannot discard the
 * other 99 events. Offline evidence always enters identity review.
 */
punchesRouter.post('/sync', requireKiosk, async (req, res) => {
  const body = syncSchema.parse(req.body);
  const device = req.device!;
  const settings = await getSettings(device.organizationId);
  const invalidResults: Array<Record<string, unknown>> = [];
  const validEvents: DeviceEvent[] = [];

  for (const raw of body.events) {
    const parsed = deviceEventSchema.safeParse(raw);
    if (parsed.success) {
      validEvents.push(parsed.data);
      continue;
    }
    const candidate = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    invalidResults.push({
      client_event_id:
        typeof candidate.client_event_id === 'string' ? candidate.client_event_id : null,
      client_sequence:
        typeof candidate.client_sequence === 'number' ? candidate.client_sequence : null,
      status: 'rejected',
      code: 'invalid_event',
      error: 'Evento inválido',
      details: parsed.error.issues,
    });
  }

  const results: Array<Record<string, unknown>> = [];
  for (const event of sortDeviceEvents(validEvents)) {
    try {
      const existing = await existingDevicePunch(device.id, event.client_event_id);
      if (existing) {
        if (!deviceEventMatches(existing, event)) {
          results.push({
            client_event_id: event.client_event_id,
            client_sequence: event.client_sequence,
            status: 'rejected',
            code: 'client_event_payload_conflict',
            error: 'El UUID del evento ya existe con datos diferentes',
          });
        } else {
          results.push(successfulSyncResult('duplicate', event, existing, settings.timezone));
        }
        continue;
      }

      const rawCapturedAt = new Date(event.captured_at);
      const normalizedCapturedAt = normalizeCapturedAtSnapshot(
        event.captured_at,
        event.client_clock_skew_seconds
      );
      const captured = validateCapturedAt(normalizedCapturedAt.toISOString());
      if (!captured.ok) {
        results.push({
          client_event_id: event.client_event_id,
          client_sequence: event.client_sequence,
          status: 'rejected',
          code: captured.code,
          error: captured.error,
        });
        continue;
      }

      const employee = await queryOne<{ id: string; full_name: string }>(
        `SELECT id, full_name FROM employees
         WHERE organization_id = $1 AND employee_number = $2 AND active`,
        [device.organizationId, event.employee_number]
      );
      if (!employee) {
        results.push({
          client_event_id: event.client_event_id,
          client_sequence: event.client_sequence,
          status: 'rejected',
          code: 'employee_not_found',
          error: 'Empleado activo no encontrado',
        });
        continue;
      }

      const created = await withTransaction(async (client) => {
        const identity = await resolvePunchIdentity(client, {
          device,
          employeeId: employee.id,
          employeeNumber: event.employee_number,
          clientEventId: event.client_event_id,
          clientInstallationId: event.client_installation_id,
          clientSequence: event.client_sequence,
          capturedAt: rawCapturedAt,
          punchType: event.punch_type,
          identitySessionId: event.identity_session_id ?? null,
          bypassReason: event.identity_bypass_reason ?? 'offline',
          offline: true,
          onlineReceivedAt: captured.date,
        });
        const workDate = workDateOf(identity.payableAt, settings.timezone);
        await ensurePeriodOpen(client, device.organizationId, workDate, settings.timezone);
        let semantic = await semanticDuplicatePunch(client, device.id, employee.id, event);
        if (semantic) semantic = await lockOpenSemanticCandidate(client, semantic);
        if (semantic && identity.sessionId && !semantic.identity_session_id) semantic = null;
        if (semantic) {
          const canonicalIdentityStatus = await preserveSemanticIdentityAlias(client, {
            organizationId: device.organizationId,
            plantId: device.plantId,
            deviceId: device.id,
            employeeId: employee.id,
            semantic,
            aliasSessionId: identity.sessionId,
            aliasIdentityStatus: identity.identityStatus,
          });
          await insertDeviceReceipt(client, {
            organizationId: device.organizationId,
            plantId: device.plantId,
            deviceId: device.id,
            punchId: semantic.id,
            employeeId: employee.id,
            event,
            identity: {
              sessionId: semantic.identity_session_id,
              bypassReason: semantic.identity_bypass_reason as PunchIdentityResolution['bypassReason'],
            },
            disposition: 'semantic_duplicate',
          });
          await recordAudit(
            {
              organizationId: device.organizationId,
              actorDeviceId: device.id,
              action: 'punch.kiosk_semantic_duplicate',
              entityType: 'punch',
              entityId: semantic.id,
              metadata: {
                client_event_id: event.client_event_id,
                client_installation_id: event.client_installation_id,
                client_sequence: event.client_sequence,
                client_clock_skew_seconds: event.client_clock_skew_seconds,
                captured_at: event.captured_at,
                offline: true,
              },
            },
            client
          );
          return {
            punch: {
              ...semantic,
              identity_status: canonicalIdentityStatus,
              identity_session_id: event.identity_session_id ?? null,
              identity_bypass_reason: event.identity_bypass_reason ?? null,
            },
            duplicate: true,
          };
        }
        const assignment = await client.query<{ area_id: string }>(
          `SELECT area_id FROM daily_area_assignments
           WHERE employee_id = $1 AND work_date = $2
             AND organization_id = $3 AND plant_id = $4
           ORDER BY id DESC LIMIT 1`,
          [employee.id, workDate, device.organizationId, device.plantId]
        );
        const inserted = await client.query<{ id: string; punched_at: Date }>(
          `INSERT INTO punches
             (organization_id, plant_id, device_id, client_event_id, client_installation_id,
              client_sequence,
              client_clock_skew_seconds, evidence_status, employee_id, punch_type, punched_at,
              captured_at, received_at, area_id, identity_session_id, identity_bypass_reason,
              source, offline, identity_status, face_check_status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now(), $13,
                   $14, $15, 'kiosk', true, $16,
                   CASE WHEN $16 = 'verified' THEN 'match'
                        WHEN $8 = 'camera_unavailable' THEN 'skipped' ELSE 'pending' END)
           ON CONFLICT (device_id, client_event_id)
             WHERE device_id IS NOT NULL AND client_event_id IS NOT NULL
           DO NOTHING
           RETURNING id, punched_at`,
          [
            device.organizationId,
            device.plantId,
            device.id,
            event.client_event_id,
            event.client_installation_id,
            event.client_sequence,
            event.client_clock_skew_seconds,
            event.evidence_status,
            employee.id,
            event.punch_type,
            identity.payableAt,
            rawCapturedAt,
            assignment.rows[0]?.area_id ?? null,
            identity.sessionId,
            identity.bypassReason,
            identity.identityStatus,
          ]
        );
        if (!inserted.rows[0]) return null;
        await insertDeviceReceipt(client, {
          organizationId: device.organizationId,
          plantId: device.plantId,
          deviceId: device.id,
          punchId: inserted.rows[0].id,
          employeeId: employee.id,
          event,
          identity,
          disposition: 'new_punch',
        });
        await recordAudit(
          {
            organizationId: device.organizationId,
            actorDeviceId: device.id,
            action: 'punch.kiosk_created',
            entityType: 'punch',
            entityId: inserted.rows[0].id,
            metadata: {
              client_event_id: event.client_event_id,
              client_installation_id: event.client_installation_id,
              client_sequence: event.client_sequence,
              client_clock_skew_seconds: event.client_clock_skew_seconds,
              evidence_status: event.evidence_status,
              offline: true,
            },
          },
          client
        );
        return {
          punch: {
            id: inserted.rows[0].id,
            employee_number: event.employee_number,
            employee_name: employee.full_name,
            punch_type: event.punch_type,
            punched_at: inserted.rows[0].punched_at,
            captured_at: rawCapturedAt,
            client_installation_id: event.client_installation_id,
            client_sequence: event.client_sequence,
            client_clock_skew_seconds: event.client_clock_skew_seconds,
            evidence_status: event.evidence_status,
            identity_session_id: event.identity_session_id ?? null,
            identity_bypass_reason: event.identity_bypass_reason ?? null,
            identity_status: identity.identityStatus,
          } satisfies ExistingDevicePunch,
          duplicate: false,
        };
      });

      if (!created) {
        const duplicate = await existingDevicePunch(device.id, event.client_event_id);
        if (!duplicate) throw new Error('idempotent punch disappeared');
        if (!deviceEventMatches(duplicate, event)) {
          results.push({
            client_event_id: event.client_event_id,
            client_sequence: event.client_sequence,
            status: 'rejected',
            code: 'client_event_payload_conflict',
            error: 'El UUID del evento ya existe con datos diferentes',
          });
        } else {
          results.push(successfulSyncResult('duplicate', event, duplicate, settings.timezone));
        }
      } else {
        results.push(
          successfulSyncResult(
            created.duplicate ? 'duplicate' : 'accepted',
            event,
            created.punch,
            settings.timezone
          )
        );
      }
    } catch (error) {
      const concurrent = await existingDevicePunch(device.id, event.client_event_id);
      if (concurrent) {
        if (deviceEventMatches(concurrent, event)) {
          results.push(successfulSyncResult('duplicate', event, concurrent, settings.timezone));
        } else {
          results.push({
            client_event_id: event.client_event_id,
            client_sequence: event.client_sequence,
            status: 'rejected',
            code: 'client_event_payload_conflict',
            error: 'El UUID del evento ya existe con datos diferentes',
          });
        }
        continue;
      }
      const sequenceConflict = databaseConstraint(error) === 'punches_device_sequence_idx';
      const receiptSequenceConflict =
        databaseConstraint(error) === 'receipts_device_install_sequence_unique';
      if (!(error instanceof HttpError) && !sequenceConflict && !receiptSequenceConflict) {
        console.error(error);
      }
      results.push({
        client_event_id: event.client_event_id,
        client_sequence: event.client_sequence,
        status: 'rejected',
        code: sequenceConflict || receiptSequenceConflict
          ? 'client_sequence_conflict'
          : error instanceof HttpError
            ? (error.code ?? 'event_rejected')
            : 'internal_error',
        error: sequenceConflict || receiptSequenceConflict
          ? 'La secuencia del dispositivo ya fue usada por otro evento'
          : error instanceof HttpError
            ? error.message
            : 'No se pudo sincronizar la checada',
      });
    }
  }

  const allResults = [...results, ...invalidResults];
  const accepted = allResults.filter((item) => item.status === 'accepted').length;
  const duplicates = allResults.filter((item) => item.status === 'duplicate').length;
  const rejected = allResults.filter((item) => item.status === 'rejected').length;
  if (rejected > 0) {
    const eventById = new Map(validEvents.map((event) => [event.client_event_id, event]));
    await withTransaction(async (client) => {
      for (const result of allResults.filter((item) => item.status === 'rejected')) {
        const event =
          typeof result.client_event_id === 'string'
            ? eventById.get(result.client_event_id)
            : undefined;
        await recordAudit(
          {
            organizationId: device.organizationId,
            actorDeviceId: device.id,
            action: 'device.sync_event_rejected',
            entityType: 'device',
            entityId: device.id,
            metadata: {
              client_event_id: result.client_event_id ?? null,
              client_installation_id: event?.client_installation_id ?? null,
              client_sequence: result.client_sequence ?? null,
              employee_number: event?.employee_number ?? null,
              punch_type: event?.punch_type ?? null,
              captured_at: event?.captured_at ?? null,
              client_clock_skew_seconds: event?.client_clock_skew_seconds ?? null,
              evidence_status: event?.evidence_status ?? null,
              code: result.code,
            },
          },
          client
        );
      }
    });
  }
  const syncedAt = new Date();
  await query(
    `UPDATE devices
     SET last_seen_at = $2, last_sync_at = $2,
         rejected_event_count = GREATEST(rejected_event_count, $3)
     WHERE id = $1`,
    [device.id, syncedAt, rejected]
  );
  res.json({
    results: allResults,
    accepted,
    duplicates,
    rejected,
    synced_at: syncedAt.toISOString(),
  });
});

/**
 * Subida de foto en background (después de confirmar la checada).
 * El kiosco reintenta con cola local si falla; la checada nunca depende de esto.
 */
punchesRouter.post('/:id/photo', requireKiosk, upload.single('photo'), async (req, res) => {
  if (!req.file) throw badRequest('Falta archivo photo');
  const contentType = req.file.mimetype.toLowerCase();
  if (!(FACE_IMAGE_MIME_TYPES as readonly string[]).includes(contentType)) {
    throw badRequest('La foto debe ser JPEG, PNG o WebP');
  }
  if (!supportedFaceImage(req.file.buffer, contentType)) {
    throw badRequest('El contenido no corresponde al tipo de imagen declarado');
  }
  const device = req.device!;
  const organizationId = device.organizationId;
  const requestedEventId = z.string().uuid().nullish().parse(req.body.client_event_id) ?? null;
  const punch = await queryOne<{
    id: string;
    punched_at: Date;
    photo_key: string | null;
    employee_id: string;
    plant_id: string;
    client_event_id: string;
    captured_at: Date;
    event_session_id: string | null;
    provider: 'review_only' | 'fake' | 'aws_rekognition' | null;
  }>(
    `SELECT p.id, p.punched_at, p.photo_key, p.employee_id, p.plant_id,
            r.client_event_id, r.captured_at,
            COALESCE(es.id, r.identity_session_id) AS event_session_id,
            s.provider
     FROM punches p
     JOIN device_event_receipts r
       ON r.punch_id = p.id AND r.device_id = p.device_id AND r.employee_id = p.employee_id
     LEFT JOIN identity_sessions es
       ON es.device_id = r.device_id AND es.client_event_id = r.client_event_id
      AND es.employee_id = r.employee_id AND es.organization_id = r.organization_id
     LEFT JOIN identity_sessions s ON s.id = COALESCE(es.id, r.identity_session_id)
     WHERE p.id = $1 AND p.organization_id = $2 AND p.device_id = $3
       AND (($4::uuid IS NULL AND r.client_event_id = p.client_event_id)
            OR r.client_event_id = $4::uuid)
     LIMIT 1`,
    [req.params.id, organizationId, device.id, requestedEventId]
  );
  if (!punch) throw notFound('Checada/evento no encontrado');
  const workDate = workDateOf(punch.punched_at, (await getSettings(organizationId)).timezone);
  const hash = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
  const extension = contentType === 'image/png' ? 'png' : contentType === 'image/webp' ? 'webp' : 'jpg';
  const photoAttemptId = punchPhotoAttemptId(punch.client_event_id);
  const key = punch.event_session_id
    ? `${organizationId}/identity-attempts/${punch.event_session_id}/${photoAttemptId}-${hash.slice(0, 16)}.${extension}`
    : `${organizationId}/punches/${workDate}/${punch.id}-${hash}.${extension}`;
  if (punch.event_session_id) {
    const existing = await queryOne<{
      evidence_sha256: string;
      evidence_content_type: string;
      evidence_key: string;
    }>(
      `SELECT evidence_sha256, evidence_content_type, evidence_key
       FROM identity_attempts
       WHERE session_id = $1 AND client_attempt_id = $2`,
      [punch.event_session_id, photoAttemptId]
    );
    if (existing) {
      if (existing.evidence_sha256 !== hash || existing.evidence_content_type !== contentType) {
        throw conflict(
          'La foto final del evento ya existe con contenido diferente',
          'punch_photo_payload_conflict'
        );
      }
      res.json({
        ok: true,
        already: true,
        photo_key: existing.evidence_key,
        client_event_id: punch.client_event_id,
      });
      return;
    }
  } else if (punch.photo_key) {
    res.json({ ok: true, already: true, photo_key: punch.photo_key });
    return;
  }
  let objectStored = false;
  try {
    await storage.put(key, req.file.buffer, contentType);
    objectStored = true;
    const saved = await withTransaction(async (client) => {
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtext('identity-review'), hashtext($1))`,
        [punch.id]
      );
      let eventEvidenceCreated = false;
      if (punch.event_session_id && punch.provider) {
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO identity_attempts
             (organization_id, session_id, plant_id, device_id, employee_id,
              client_attempt_id, attempt_number, consumes_attempt, result, provider,
              liveness_status, evidence_key, evidence_sha256, evidence_content_type,
              evidence_byte_size, captured_at, provider_metadata)
           VALUES ($1, $2, $3, $4, $5, $6, NULL, false, 'review_only', $7,
                   'not_performed', $8, $9, $10, $11, $12,
                   jsonb_build_object('kind', 'punch_photo', 'client_event_id', $13::text))
           ON CONFLICT (session_id, client_attempt_id) DO NOTHING
           RETURNING id`,
          [
            organizationId,
            punch.event_session_id,
            punch.plant_id,
            device.id,
            punch.employee_id,
            photoAttemptId,
            punch.provider,
            key,
            hash,
            contentType,
            req.file!.buffer.length,
            punch.captured_at,
            punch.client_event_id,
          ]
        );
        eventEvidenceCreated = Boolean(inserted.rows[0]);
        if (!eventEvidenceCreated) {
          const raced = await client.query<{
            evidence_sha256: string;
            evidence_content_type: string;
            evidence_key: string;
          }>(
            `SELECT evidence_sha256, evidence_content_type, evidence_key
             FROM identity_attempts WHERE session_id = $1 AND client_attempt_id = $2`,
            [punch.event_session_id, photoAttemptId]
          );
          if (
            !raced.rows[0] ||
            raced.rows[0].evidence_sha256 !== hash ||
            raced.rows[0].evidence_content_type !== contentType
          ) {
            throw conflict(
              'La foto final del evento ya existe con contenido diferente',
              'punch_photo_payload_conflict'
            );
          }
        }
      }
      const updated = await client.query<{ photo_key: string }>(
        `UPDATE punches SET photo_key = $1
         WHERE id = $2 AND organization_id = $3 AND device_id = $4 AND photo_key IS NULL
         RETURNING photo_key`,
        [key, punch.id, organizationId, device.id]
      );
      const winner = updated.rows[0] ?? (
        await client.query<{ photo_key: string | null }>(
          `SELECT photo_key FROM punches WHERE id = $1 AND organization_id = $2 AND device_id = $3`,
          [punch.id, organizationId, device.id]
        )
      ).rows[0];
      if (!winner) throw notFound('Checada no encontrada');
      return { eventEvidenceCreated, punchPhotoKey: winner.photo_key };
    });
    if (!punch.event_session_id && saved.punchPhotoKey !== key) {
      // A legacy punch has no append-only attempt row. If two different
      // uploads race, only the key selected by the punch may survive.
      try {
        const reference = await queryOne(
          `SELECT 1 FROM identity_attempts WHERE evidence_key = $1
           UNION ALL
           SELECT 1 FROM punches WHERE photo_key = $1
           LIMIT 1`,
          [key]
        );
        if (!reference) await storage.remove(key);
      } catch (cleanupError) {
        console.error(`photo upload: no se pudo limpiar objeto perdedor ${key}`, cleanupError);
      }
    }
    // If this alias object was not selected as the punch preview it is still
    // retained by its immutable event attempt and must not be deleted.
    res.status(saved.eventEvidenceCreated || saved.punchPhotoKey === key ? 201 : 200).json({
      ok: true,
      already: !saved.eventEvidenceCreated && saved.punchPhotoKey !== key,
      photo_key: key,
      punch_photo_key: saved.punchPhotoKey,
      client_event_id: punch.client_event_id,
    });
  } catch (error) {
    let provenUnreferenced = false;
    if (objectStored) {
      try {
        const reference = await queryOne(
          `SELECT 1 FROM identity_attempts WHERE evidence_key = $1
           UNION ALL
           SELECT 1 FROM punches WHERE photo_key = $1
           LIMIT 1`,
          [key]
        );
        provenUnreferenced = !reference;
      } catch {
        // Ambiguous commit: preserve evidence rather than risk deleting a reference.
      }
    }
    if (provenUnreferenced) await storage.remove(key).catch(() => undefined);
    throw error;
  }
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
