import crypto from 'node:crypto';
import type { PoolClient } from 'pg';
import { config } from '../config.js';
import { queryOne, withTransaction } from '../db.js';
import { conflict, notFound } from '../errors.js';
import { storage } from '../storage.js';
import type { PunchType } from '../types.js';
import type { AuthDevice } from '../middleware/auth.js';
import {
  getFaceProvider,
  type FaceAttemptResult,
  type LivenessStatus,
} from './faceProvider.js';
import { MAX_BIOMETRIC_ATTEMPTS, transitionIdentity } from './identityPolicy.js';

export const FACE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const FACE_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

export interface StartIdentityInput {
  employee_number: number;
  punch_type: PunchType;
  client_event_id: string;
  client_installation_id: string;
  client_sequence: number;
  captured_at: string;
}

interface IdentitySessionRow {
  id: string;
  organization_id: string;
  plant_id: string;
  device_id: string;
  employee_id: string;
  employee_name: string;
  enrollment_id: string | null;
  enrollment_photo_key: string | null;
  client_event_id: string;
  client_installation_id: string;
  client_sequence: string | number;
  punch_type: PunchType;
  captured_at: Date;
  payload_hash: string;
  mode: 'review_only' | 'managed' | 'offline_fallback';
  provider: 'review_only' | 'fake' | 'aws_rekognition';
  provider_liveness_capable: boolean;
  liveness_status: LivenessStatus;
  status: 'pending' | 'verified' | 'review_required';
  review_reason: string | null;
  similarity: string | number | null;
  server_started_at: Date;
  resolved_at: Date | null;
  consumed_attempts: string | number;
}

interface IdentityAttemptRow {
  id: string;
  client_attempt_id: string;
  attempt_number: number | null;
  consumes_attempt: boolean;
  result: FaceAttemptResult;
  provider: string;
  liveness_status: LivenessStatus;
  similarity: string | number | null;
  evidence_sha256: string;
  evidence_content_type: string;
  captured_at: Date;
}

function stablePayloadHash(input: StartIdentityInput): string {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify([
        input.employee_number,
        input.punch_type,
        input.client_event_id,
        input.client_installation_id,
        input.client_sequence,
        new Date(input.captured_at).toISOString(),
      ])
    )
    .digest('hex');
}

function sha256(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/** Stable UUID namespace for the background punch-photo evidence of an event. */
export function punchPhotoAttemptId(clientEventId: string): string {
  const bytes = crypto
    .createHash('sha256')
    .update(`clockai:punch-photo:${clientEventId}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function supportedFaceImage(bytes: Buffer, contentType: string): boolean {
  if (!(FACE_IMAGE_MIME_TYPES as readonly string[]).includes(contentType)) return false;
  if (contentType === 'image/jpeg') {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (contentType === 'image/png') {
    return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  }
  return (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  );
}

async function findSession(
  executor: Pick<PoolClient, 'query'> | null,
  deviceId: string,
  sessionId: string
): Promise<IdentitySessionRow | null> {
  const sql = `SELECT s.*, e.full_name AS employee_name, b.photo_key AS enrollment_photo_key,
                      (SELECT count(*) FROM identity_attempts a
                       WHERE a.session_id = s.id AND a.consumes_attempt)::integer AS consumed_attempts
               FROM identity_sessions s
               JOIN employees e ON e.id = s.employee_id AND e.organization_id = s.organization_id
               LEFT JOIN biometric_enrollments b ON b.id = s.enrollment_id
               WHERE s.id = $1 AND s.device_id = $2`;
  if (executor) {
    const result = await executor.query<IdentitySessionRow>(sql, [sessionId, deviceId]);
    return result.rows[0] ?? null;
  }
  return queryOne<IdentitySessionRow>(sql, [sessionId, deviceId]);
}

function sessionResponse(session: IdentitySessionRow, duplicate: boolean) {
  const consumed = Number(session.consumed_attempts);
  return {
    session_id: session.id,
    employee_name: session.employee_name,
    status: session.status,
    next_action: session.status === 'pending' ? ('capture' as const) : ('punch' as const),
    consuming_attempts: consumed,
    attempts_remaining: Math.max(0, MAX_BIOMETRIC_ATTEMPTS - consumed),
    max_attempts: MAX_BIOMETRIC_ATTEMPTS,
    provider: session.provider,
    provider_liveness_capable: session.provider_liveness_capable,
    liveness_status: session.liveness_status,
    enrollment_status: session.enrollment_id ? ('ready' as const) : ('missing' as const),
    review_reason: session.review_reason,
    server_started_at: session.server_started_at.toISOString(),
    duplicate,
  };
}

function constraintName(error: unknown): string | undefined {
  return error && typeof error === 'object'
    ? (error as { constraint?: string }).constraint
    : undefined;
}

async function sequenceOwner(
  deviceId: string,
  clientInstallationId: string,
  clientSequence: number
): Promise<{ client_event_id: string } | null> {
  return queryOne<{ client_event_id: string }>(
    `SELECT client_event_id
     FROM identity_sessions
     WHERE device_id = $1 AND client_installation_id = $2 AND client_sequence = $3`,
    [deviceId, clientInstallationId, clientSequence]
  );
}

export async function startIdentitySession(device: AuthDevice, input: StartIdentityInput) {
  const payloadHash = stablePayloadHash(input);
  const existing = await queryOne<IdentitySessionRow>(
    `SELECT s.*, e.full_name AS employee_name, b.photo_key AS enrollment_photo_key,
            (SELECT count(*) FROM identity_attempts a
             WHERE a.session_id = s.id AND a.consumes_attempt)::integer AS consumed_attempts
     FROM identity_sessions s
     JOIN employees e ON e.id = s.employee_id AND e.organization_id = s.organization_id
     LEFT JOIN biometric_enrollments b ON b.id = s.enrollment_id
     WHERE s.device_id = $1 AND s.client_event_id = $2`,
    [device.id, input.client_event_id]
  );
  if (existing) {
    if (existing.payload_hash !== payloadHash) {
      throw conflict(
        'El UUID de la sesión ya existe con datos diferentes',
        'identity_session_payload_conflict'
      );
    }
    return sessionResponse(existing, true);
  }

  const employee = await queryOne<{
    id: string;
    full_name: string;
    current_biometric_enrollment_id: string | null;
  }>(
    `SELECT id, full_name, current_biometric_enrollment_id
     FROM employees
     WHERE organization_id = $1 AND employee_number = $2 AND active`,
    [device.organizationId, input.employee_number]
  );
  if (!employee) throw notFound('Empleado activo no encontrado');

  const provider = getFaceProvider();
  try {
    const inserted = await queryOne<IdentitySessionRow>(
      `WITH created AS (
         INSERT INTO identity_sessions
           (organization_id, plant_id, device_id, employee_id, enrollment_id,
            client_event_id, client_installation_id, client_sequence, punch_type,
            captured_at, payload_hash, mode, provider, provider_liveness_capable)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
                 $12, $13, $14)
         ON CONFLICT (device_id, client_event_id) DO NOTHING
         RETURNING *
       )
       SELECT c.*, $15::text AS employee_name, b.photo_key AS enrollment_photo_key,
              0::integer AS consumed_attempts
       FROM created c
       LEFT JOIN biometric_enrollments b ON b.id = c.enrollment_id`,
      [
        device.organizationId,
        device.plantId,
        device.id,
        employee.id,
        employee.current_biometric_enrollment_id,
        input.client_event_id,
        input.client_installation_id,
        input.client_sequence,
        input.punch_type,
        new Date(input.captured_at),
        payloadHash,
        provider.name === 'review_only' ? 'review_only' : 'managed',
        provider.name,
        provider.livenessCapable,
        employee.full_name,
      ]
    );
    if (inserted) return sessionResponse(inserted, false);
  } catch (error) {
    const code = error && typeof error === 'object' ? (error as { code?: string }).code : undefined;
    const owner =
      code === '23505'
        ? await sequenceOwner(device.id, input.client_installation_id, input.client_sequence)
        : null;
    if (
      owner?.client_event_id !== undefined &&
      owner.client_event_id !== input.client_event_id
    ) {
      throw conflict(
        'La secuencia del dispositivo ya pertenece a otro evento',
        'client_sequence_conflict'
      );
    }
    if (constraintName(error)?.includes('client_installation_id')) {
      throw conflict(
        'La secuencia del dispositivo ya pertenece a otro evento',
        'client_sequence_conflict'
      );
    }
    throw error;
  }

  // Concurrent same-UUID creation: deterministically re-read and compare.
  const concurrent = await queryOne<IdentitySessionRow>(
    `SELECT s.*, e.full_name AS employee_name, b.photo_key AS enrollment_photo_key,
            (SELECT count(*) FROM identity_attempts a
             WHERE a.session_id = s.id AND a.consumes_attempt)::integer AS consumed_attempts
     FROM identity_sessions s
     JOIN employees e ON e.id = s.employee_id
     LEFT JOIN biometric_enrollments b ON b.id = s.enrollment_id
     WHERE s.device_id = $1 AND s.client_event_id = $2`,
    [device.id, input.client_event_id]
  );
  if (!concurrent) {
    const owner = await sequenceOwner(
      device.id,
      input.client_installation_id,
      input.client_sequence
    );
    if (owner && owner.client_event_id !== input.client_event_id) {
      throw conflict(
        'La secuencia del dispositivo ya pertenece a otro evento',
        'client_sequence_conflict'
      );
    }
    throw new Error('identity session disappeared after conflict');
  }
  if (concurrent.payload_hash !== payloadHash) {
    throw conflict(
      'El UUID de la sesión ya existe con datos diferentes',
      'identity_session_payload_conflict'
    );
  }
  return sessionResponse(concurrent, true);
}

export interface SubmitIdentityAttemptInput {
  sessionId: string;
  clientAttemptId: string;
  capturedAt: string;
  photo: Buffer;
  contentType: string;
  debugOutcome?: FaceAttemptResult;
}

function attemptResponse(attempt: IdentityAttemptRow) {
  return {
    id: attempt.id,
    client_attempt_id: attempt.client_attempt_id,
    result: attempt.result,
    consumed: attempt.consumes_attempt,
    attempt_number: attempt.attempt_number,
    similarity: attempt.similarity === null ? null : Number(attempt.similarity),
    liveness_status: attempt.liveness_status,
    captured_at: attempt.captured_at.toISOString(),
  };
}

function attemptPayloadMatches(
  attempt: IdentityAttemptRow,
  evidenceHash: string,
  contentType: string,
  capturedAt: string
): boolean {
  return (
    attempt.evidence_sha256 === evidenceHash &&
    attempt.evidence_content_type === contentType &&
    attempt.captured_at.toISOString() === new Date(capturedAt).toISOString()
  );
}

export async function submitIdentityAttempt(device: AuthDevice, input: SubmitIdentityAttemptInput) {
  const evidenceHash = sha256(input.photo);
  const existing = await queryOne<IdentityAttemptRow>(
    `SELECT a.* FROM identity_attempts a
     JOIN identity_sessions s ON s.id = a.session_id
     WHERE a.session_id = $1 AND a.client_attempt_id = $2 AND s.device_id = $3`,
    [input.sessionId, input.clientAttemptId, device.id]
  );
  if (existing) {
    if (!attemptPayloadMatches(existing, evidenceHash, input.contentType, input.capturedAt)) {
      throw conflict(
        'El UUID del intento ya existe con datos diferentes',
        'identity_attempt_payload_conflict'
      );
    }
    const session = await findSession(null, device.id, input.sessionId);
    if (!session) throw notFound('Sesión de identidad no encontrada');
    return { ...sessionResponse(session, true), attempt: attemptResponse(existing) };
  }

  const sessionBefore = await findSession(null, device.id, input.sessionId);
  if (!sessionBefore) throw notFound('Sesión de identidad no encontrada');
  if (sessionBefore.status !== 'pending') {
    throw conflict('La sesión de identidad ya está resuelta', 'identity_session_resolved');
  }
  const extension =
    input.contentType === 'image/png' ? 'png' : input.contentType === 'image/webp' ? 'webp' : 'jpg';
  const evidenceKey = `${device.organizationId}/identity-attempts/${sessionBefore.id}/${input.clientAttemptId}-${evidenceHash.slice(0, 16)}.${extension}`;
  let objectStored = false;
  let saved:
    | { session: IdentitySessionRow; attempt: IdentityAttemptRow; duplicate: boolean }
    | undefined;
  try {
    await storage.put(evidenceKey, input.photo, input.contentType);
    objectStored = true;

    let providerResult: {
      result: FaceAttemptResult;
      similarity: number | null;
      livenessStatus: LivenessStatus;
      metadata: Record<string, unknown>;
    };
  if (
    Date.now() - sessionBefore.server_started_at.getTime() >
    config.face.sessionTtlSeconds * 1000
  ) {
    providerResult = {
      result: 'provider_unavailable',
      similarity: null,
      livenessStatus: 'not_performed',
      metadata: { reason: 'session_expired', ttl_seconds: config.face.sessionTtlSeconds },
    };
  } else if (!sessionBefore.enrollment_photo_key) {
    providerResult = {
      result: 'no_enrollment',
      similarity: null,
      livenessStatus: 'not_performed',
      metadata: { reason: 'missing_enrollment' },
    };
  } else {
    let enrollmentPhoto: Buffer | null = null;
    try {
      enrollmentPhoto = await storage.get(sessionBefore.enrollment_photo_key);
    } catch (error) {
      providerResult = {
        result: 'provider_unavailable',
        similarity: null,
        livenessStatus: 'not_performed',
        metadata: { reason: 'enrollment_storage_unavailable' },
      };
    }
    if (enrollmentPhoto) {
      providerResult = await getFaceProvider().verify({
        attemptPhoto: input.photo,
        enrollmentPhoto,
        debugOutcome: input.debugOutcome,
      });
    }
  }

    saved = await withTransaction(async (client) => {
    const locked = await client.query<IdentitySessionRow>(
      `SELECT s.*, e.full_name AS employee_name, b.photo_key AS enrollment_photo_key,
              0::integer AS consumed_attempts
       FROM identity_sessions s
       JOIN employees e ON e.id = s.employee_id AND e.organization_id = s.organization_id
       LEFT JOIN biometric_enrollments b ON b.id = s.enrollment_id
       WHERE s.id = $1 AND s.device_id = $2
       FOR UPDATE OF s`,
      [input.sessionId, device.id]
    );
    const session = locked.rows[0];
    if (!session) throw notFound('Sesión de identidad no encontrada');
    const freshCount = await client.query<{ count: number }>(
      `SELECT count(*)::integer AS count FROM identity_attempts
       WHERE session_id = $1 AND consumes_attempt`,
      [session.id]
    );
    session.consumed_attempts = freshCount.rows[0]?.count ?? 0;
    const raced = await client.query<IdentityAttemptRow>(
      `SELECT * FROM identity_attempts
       WHERE session_id = $1 AND client_attempt_id = $2`,
      [input.sessionId, input.clientAttemptId]
    );
    if (raced.rows[0]) {
      if (!attemptPayloadMatches(raced.rows[0], evidenceHash, input.contentType, input.capturedAt)) {
        throw conflict(
          'El UUID del intento ya existe con datos diferentes',
          'identity_attempt_payload_conflict'
        );
      }
      return { session, attempt: raced.rows[0], duplicate: true };
    }
    if (session.status !== 'pending') {
      throw conflict('La sesión de identidad ya está resuelta', 'identity_session_resolved');
    }
    const transition = transitionIdentity(Number(session.consumed_attempts), providerResult.result, {
      capable: session.provider_liveness_capable,
      status: providerResult.livenessStatus,
    });
    const inserted = await client.query<IdentityAttemptRow>(
      `INSERT INTO identity_attempts
         (organization_id, session_id, plant_id, device_id, employee_id, client_attempt_id,
          attempt_number, consumes_attempt, result, provider, liveness_status,
          similarity, evidence_key, evidence_sha256, evidence_content_type,
          evidence_byte_size, captured_at, provider_metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
               $13, $14, $15, $16, $17, $18)
       RETURNING *`,
      [
        device.organizationId,
        session.id,
        device.plantId,
        device.id,
        session.employee_id,
        input.clientAttemptId,
        transition.attemptNumber,
        transition.consumes,
        providerResult.result,
        session.provider,
        providerResult.livenessStatus,
        providerResult.similarity,
        evidenceKey,
        evidenceHash,
        input.contentType,
        input.photo.length,
        new Date(input.capturedAt),
        providerResult.metadata,
      ]
    );
    await client.query(
      `UPDATE identity_sessions
       SET status = $2, review_reason = $3, liveness_status = $4, similarity = $5,
           resolved_at = CASE WHEN $2 = 'pending' THEN NULL ELSE now() END,
           updated_at = now()
       WHERE id = $1`,
      [
        session.id,
        transition.status,
        transition.reviewReason,
        providerResult.livenessStatus,
        providerResult.similarity,
      ]
    );
    const refreshed = await findSession(client, device.id, session.id);
    if (!refreshed) throw new Error('identity session disappeared after attempt');
    return { session: refreshed, attempt: inserted.rows[0]!, duplicate: false };
    });
  } catch (error) {
    // The key is unique to this attempt and hash. Never remove a concurrent
    // writer's referenced object; compensate only when no immutable row exists.
    let provenUnreferenced = false;
    if (objectStored) {
      try {
        provenUnreferenced = !(await queryOne<{ id: string }>(
          `SELECT id FROM identity_attempts WHERE evidence_key = $1 LIMIT 1`,
          [evidenceKey]
        ));
      } catch {
        // If DB state is unknown, preserve the object; never delete evidence
        // that a concurrent committed attempt may reference.
      }
    }
    if (provenUnreferenced) {
      try {
        await storage.remove(evidenceKey);
      } catch {
        // Retention/operations can safely remove this content-addressed orphan.
      }
    }
    throw error;
  }

  if (!saved) throw new Error('identity attempt was not saved');
  return {
    ...sessionResponse(saved.session, saved.duplicate),
    attempt: attemptResponse(saved.attempt),
  };
}

export interface PunchIdentityResolution {
  sessionId: string | null;
  identityStatus: 'verified' | 'identity_review';
  bypassReason:
    | 'camera_unavailable'
    | 'provider_unavailable'
    | 'offline'
    | 'incomplete_session'
    | 'legacy_pin'
    | null;
  payableAt: Date;
}

/**
 * Validates a device event's optional identity binding.  It deliberately never
 * rejects time because identity is incomplete; unresolved paths become review.
 */
export async function resolvePunchIdentity(
  client: PoolClient,
  input: {
    device: AuthDevice;
    employeeId: string;
    employeeNumber: number;
    clientEventId: string;
    clientInstallationId: string;
    clientSequence: number;
    capturedAt: Date;
    punchType: PunchType;
    identitySessionId: string | null;
    bypassReason: PunchIdentityResolution['bypassReason'];
    offline: boolean;
    onlineReceivedAt: Date;
  }
): Promise<PunchIdentityResolution> {
  type BoundSession = {
    id: string;
    status: 'pending' | 'verified' | 'review_required';
    server_started_at: Date;
  };
  // Lookup is by the complete immutable event binding. This also recovers a
  // session when the start response was lost and the client has no session id.
  const recovered = await client.query<BoundSession>(
    `SELECT id, status, server_started_at FROM identity_sessions
     WHERE organization_id = $1 AND plant_id = $2 AND device_id = $3
       AND employee_id = $4 AND client_event_id = $5 AND punch_type = $6
       AND client_installation_id = $7 AND client_sequence = $8
       AND captured_at = $9
     FOR UPDATE`,
    [
      input.device.organizationId,
      input.device.plantId,
      input.device.id,
      input.employeeId,
      input.clientEventId,
      input.punchType,
      input.clientInstallationId,
      input.clientSequence,
      input.capturedAt,
    ]
  );
  const session = recovered.rows[0];
  if (session) {
    const suppliedIdMatches =
      input.identitySessionId === null || input.identitySessionId === session.id;
    if (session.status === 'pending') {
      await client.query(
        `UPDATE identity_sessions
         SET status = 'review_required', review_reason = 'incomplete_session',
             resolved_at = now(), updated_at = now()
         WHERE id = $1`,
        [session.id]
      );
    }
    return {
      sessionId: session.id,
      identityStatus:
        suppliedIdMatches && session.status === 'verified' ? 'verified' : 'identity_review',
      bypassReason:
        !suppliedIdMatches || session.status === 'pending' ? 'incomplete_session' : null,
      payableAt: session.server_started_at,
    };
  }

  const reason = input.bypassReason ?? (input.offline ? 'offline' : 'legacy_pin');
  const employee = await client.query<{ current_biometric_enrollment_id: string | null }>(
    `SELECT current_biometric_enrollment_id FROM employees
     WHERE id = $1 AND organization_id = $2`,
    [input.employeeId, input.device.organizationId]
  );
  const payloadHash = stablePayloadHash({
    employee_number: input.employeeNumber,
    punch_type: input.punchType,
    client_event_id: input.clientEventId,
    client_installation_id: input.clientInstallationId,
    client_sequence: input.clientSequence,
    captured_at: input.capturedAt.toISOString(),
  });
  const fallback = await client.query<BoundSession>(
    `INSERT INTO identity_sessions
       (organization_id, plant_id, device_id, employee_id, enrollment_id,
        client_event_id, client_installation_id, client_sequence, punch_type,
        captured_at, payload_hash, mode, provider, provider_liveness_capable,
        liveness_status, status, review_reason, server_started_at, resolved_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
             'offline_fallback', 'review_only', false, 'not_performed',
             'review_required', $12, $13, now())
     ON CONFLICT DO NOTHING
     RETURNING id, status, server_started_at`,
    [
      input.device.organizationId,
      input.device.plantId,
      input.device.id,
      input.employeeId,
      employee.rows[0]?.current_biometric_enrollment_id ?? null,
      input.clientEventId,
      input.clientInstallationId,
      input.clientSequence,
      input.punchType,
      input.capturedAt,
      payloadHash,
      reason,
      input.onlineReceivedAt,
    ]
  );
  const createdFallback = fallback.rows[0];
  if (createdFallback) {
    return {
      sessionId: createdFallback.id,
      identityStatus: 'identity_review',
      bypassReason: reason,
      payableAt: createdFallback.server_started_at,
    };
  }
  // A concurrent fallback/start may have won. Re-read the exact binding.
  const raced = await client.query<BoundSession>(
    `SELECT id, status, server_started_at FROM identity_sessions
     WHERE organization_id = $1 AND plant_id = $2 AND device_id = $3
       AND employee_id = $4 AND client_event_id = $5 AND punch_type = $6
       AND client_installation_id = $7 AND client_sequence = $8 AND captured_at = $9`,
    [
      input.device.organizationId,
      input.device.plantId,
      input.device.id,
      input.employeeId,
      input.clientEventId,
      input.punchType,
      input.clientInstallationId,
      input.clientSequence,
      input.capturedAt,
    ]
  );
  if (raced.rows[0]) {
    return {
      sessionId: raced.rows[0].id,
      identityStatus: 'identity_review',
      bypassReason: reason,
      payableAt: raced.rows[0].server_started_at,
    };
  }
  return {
    sessionId: null,
    identityStatus: 'identity_review',
    bypassReason: reason,
    payableAt: input.onlineReceivedAt,
  };
}
