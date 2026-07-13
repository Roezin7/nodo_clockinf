import crypto from 'node:crypto';
import type { Server } from 'node:http';
import bcrypt from 'bcryptjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { pool, query, queryOne } from '../db.js';
import { signAccessToken, type AuthUser } from '../middleware/auth.js';
import {
  cleanupIdentityAttemptEvidence,
  cleanupOrganizationPhotoEvidence,
} from '../jobs/photoRetention.js';
import { storage } from '../storage.js';

const run = process.env.RUN_DB_INTEGRATION === '1';
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01]);
const alternateJpeg = Buffer.from([0xff, 0xd8, 0xff, 0x01, 0x02]);

interface Fixture {
  organizationId: string;
  plantId: string;
  otherPlantId: string;
  employeeId: string;
  employeeNumber: number;
  deviceId: string;
  deviceToken: string;
  adminToken: string;
  accountantToken: string;
  outsideForemanToken: string;
  otherTenantAdminToken: string;
}

let server: Server;
let baseUrl = '';
let fixture: Fixture;
let sequence = 0;

function tokenFor(user: AuthUser): string {
  return signAccessToken(user);
}

async function jsonRequest(
  path: string,
  options: RequestInit & { device?: boolean; bearer?: string } = {}
): Promise<{ response: Response; body: Record<string, any> }> {
  const headers = new Headers(options.headers);
  if (options.device) headers.set('x-device-token', fixture.deviceToken);
  if (options.bearer) headers.set('authorization', `Bearer ${options.bearer}`);
  if (options.body && typeof options.body === 'string') headers.set('content-type', 'application/json');
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  const body = (await response.json().catch(() => ({}))) as Record<string, any>;
  return { response, body };
}

function newEvent(punchType = 'shift_in', capturedOffsetSeconds = 0) {
  sequence += 1;
  const capturedAt = new Date(Date.now() - 120_000 + capturedOffsetSeconds * 1000).toISOString();
  return {
    employee_number: fixture.employeeNumber,
    punch_type: punchType,
    client_event_id: crypto.randomUUID(),
    client_installation_id: '11111111-1111-4111-8111-111111111111',
    client_sequence: sequence,
    captured_at: capturedAt,
    client_clock_skew_seconds: null,
    evidence_status: 'captured' as const,
  };
}

async function startSession(event: ReturnType<typeof newEvent>) {
  return jsonRequest('/api/punches/kiosk/identity/sessions', {
    method: 'POST',
    device: true,
    body: JSON.stringify({
      employee_number: event.employee_number,
      punch_type: event.punch_type,
      client_event_id: event.client_event_id,
      client_installation_id: event.client_installation_id,
      client_sequence: event.client_sequence,
      captured_at: event.captured_at,
    }),
  });
}

async function attempt(
  sessionId: string,
  result: string,
  options: { id?: string; capturedAt?: string; photo?: Buffer } = {}
) {
  const form = new FormData();
  form.set('client_attempt_id', options.id ?? crypto.randomUUID());
  form.set('captured_at', options.capturedAt ?? new Date().toISOString());
  form.set('fake_result', result);
  form.set(
    'photo',
    new Blob([options.photo ?? jpeg], { type: 'image/jpeg' }),
    'face.jpg'
  );
  return jsonRequest(`/api/punches/kiosk/identity/sessions/${sessionId}/attempts`, {
    method: 'POST',
    device: true,
    body: form,
  });
}

async function uploadEnrollment(employeeId: string) {
  const form = new FormData();
  form.set('photo', new Blob([jpeg], { type: 'image/jpeg' }), 'enrollment.jpg');
  return jsonRequest(`/api/employees/${employeeId}/photo`, {
    method: 'POST',
    bearer: fixture.adminToken,
    body: form,
  });
}

async function uploadPunchPhoto(
  punchId: string,
  clientEventId: string,
  photo: Buffer = jpeg
) {
  const form = new FormData();
  form.set('client_event_id', clientEventId);
  form.set('photo', new Blob([photo], { type: 'image/jpeg' }), 'punch.jpg');
  return jsonRequest(`/api/punches/${punchId}/photo`, {
    method: 'POST',
    device: true,
    body: form,
  });
}

describe.skipIf(!run)('Phase 5 identity API + PostgreSQL integration', () => {
  beforeAll(async () => {
    const organization = await queryOne<{ id: string }>(
      `SELECT id FROM organizations WHERE slug = 'modesto-packing'`
    );
    const plants = await query<{ id: string }>(
      `SELECT id FROM plants WHERE organization_id = $1 ORDER BY code`,
      [organization!.id]
    );
    const employee = await queryOne<{ id: string; employee_number: number }>(
      `INSERT INTO employees (organization_id, full_name, pin_hash)
       VALUES ($1, 'Integration Worker', $2)
       RETURNING id, employee_number`,
      [organization!.id, await bcrypt.hash('1234', 4)]
    );
    const deviceToken = 'integration-device-token-with-more-than-twenty-characters';
    const device = await queryOne<{ id: string }>(
      `INSERT INTO devices
         (organization_id, plant_id, name, token_hash, enrolled_at, active,
          camera_status, storage_status)
       VALUES ($1, $2, 'F5 Integration Kiosk', $3, now(), true, 'ready', 'ready')
       RETURNING id`,
      [
        organization!.id,
        plants[0]!.id,
        crypto.createHash('sha256').update(deviceToken).digest('hex'),
      ]
    );
    const users: Record<string, AuthUser> = {};
    for (const [role, email] of [
      ['admin', 'f5-admin@test.invalid'],
      ['accountant', 'f5-accountant@test.invalid'],
      ['foreman', 'f5-foreman@test.invalid'],
    ] as const) {
      const row = await queryOne<{ id: string; name: string }>(
        `INSERT INTO users (email, password_hash, role, name, organization_id)
         VALUES ($1, 'unused', $2, $3, $4) RETURNING id, name`,
        [email, role, `F5 ${role}`, organization!.id]
      );
      users[role] = {
        id: row!.id,
        role,
        name: row!.name,
        email,
        organizationId: organization!.id,
      };
    }
    // This foreman intentionally has only Plant 2, while the kiosk is Plant 1.
    await query(
      `INSERT INTO user_plant_access (organization_id, user_id, plant_id)
       VALUES ($1, $2, $3)`,
      [organization!.id, users.foreman!.id, plants[1]!.id]
    );

    const otherOrg = await queryOne<{ id: string }>(
      `INSERT INTO organizations (name, slug, timezone)
       VALUES ('Other Tenant', 'other-f5-tenant', 'America/Los_Angeles') RETURNING id`
    );
    const otherAdmin = await queryOne<{ id: string; name: string }>(
      `INSERT INTO users (email, password_hash, role, name, organization_id)
       VALUES ('other-admin@test.invalid', 'unused', 'admin', 'Other Admin', $1)
       RETURNING id, name`,
      [otherOrg!.id]
    );

    fixture = {
      organizationId: organization!.id,
      plantId: plants[0]!.id,
      otherPlantId: plants[1]!.id,
      employeeId: employee!.id,
      employeeNumber: employee!.employee_number,
      deviceId: device!.id,
      deviceToken,
      adminToken: tokenFor(users.admin!),
      accountantToken: tokenFor(users.accountant!),
      outsideForemanToken: tokenFor(users.foreman!),
      otherTenantAdminToken: tokenFor({
        id: otherAdmin!.id,
        role: 'admin',
        name: otherAdmin!.name,
        email: 'other-admin@test.invalid',
        organizationId: otherOrg!.id,
      }),
    };

    await new Promise<void>((resolve) => {
      server = createApp().listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('No test port');
        baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
    const enrollment = await uploadEnrollment(fixture.employeeId);
    expect(enrollment.response.status).toBe(201);
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (fixture?.employeeId) {
      const objects = await query<{ photo_key: string }>(
        `SELECT photo_key FROM biometric_enrollments WHERE employee_id = $1`,
        [fixture.employeeId]
      );
      for (const object of objects) await storage.remove(object.photo_key).catch(() => undefined);
    }
    await pool.end();
  });

  it('versions enrollment objects without overwriting the previous key', async () => {
    const second = await uploadEnrollment(fixture.employeeId);
    expect(second.response.status).toBe(201);
    const rows = await query<{ version: number; photo_key: string }>(
      `SELECT version, photo_key FROM biometric_enrollments
       WHERE employee_id = $1 ORDER BY version`,
      [fixture.employeeId]
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]!.photo_key).not.toBe(rows[1]!.photo_key);
    expect(rows[1]!.photo_key).toContain('/v2-');
  });

  it('is idempotent on session payload and detects a conflicting UUID', async () => {
    const event = newEvent('shift_in', 10);
    const first = await startSession(event);
    expect(first.response.status).toBe(201);
    const retry = await startSession(event);
    expect(retry.response.status).toBe(200);
    expect(retry.body.session_id).toBe(first.body.session_id);
    const conflicting = await startSession({ ...event, punch_type: 'shift_out' });
    expect(conflicting.response.status).toBe(409);
    expect(conflicting.body.code).toBe('identity_session_payload_conflict');

    const reusedSequence = {
      ...newEvent('shift_in', 11),
      client_installation_id: event.client_installation_id,
      client_sequence: event.client_sequence,
    };
    const sequenceConflict = await startSession(reusedSequence);
    expect(sequenceConflict.response.status).toBe(409);
    expect(sequenceConflict.body.code).toBe('client_sequence_conflict');
  });

  it('counts exactly three employee failures and makes attempt retries immutable', async () => {
    const event = newEvent('meal_out', 30);
    const started = await startSession(event);
    const attemptId = crypto.randomUUID();
    const capturedAt = new Date().toISOString();
    const first = await attempt(started.body.session_id, 'no_match', {
      id: attemptId,
      capturedAt,
    });
    expect(first.body).toMatchObject({ status: 'pending', consuming_attempts: 1 });
    const replay = await attempt(started.body.session_id, 'no_match', {
      id: attemptId,
      capturedAt,
    });
    expect(replay.response.status).toBe(200);
    expect(replay.body.duplicate).toBe(true);
    const payloadConflict = await attempt(started.body.session_id, 'no_match', {
      id: attemptId,
      capturedAt: new Date(Date.now() + 1000).toISOString(),
    });
    expect(payloadConflict.response.status).toBe(409);
    const second = await attempt(started.body.session_id, 'no_face');
    const third = await attempt(started.body.session_id, 'quality_failed');
    expect(second.body).toMatchObject({ status: 'pending', consuming_attempts: 2 });
    expect(third.body).toMatchObject({
      status: 'review_required',
      consuming_attempts: 3,
      attempts_remaining: 0,
      review_reason: 'attempts_exhausted',
    });
  });

  it('serializes concurrent distinct attempts and technical failures do not consume', async () => {
    const event = newEvent('meal_in', 50);
    const started = await startSession(event);
    const [left, right] = await Promise.all([
      attempt(started.body.session_id, 'no_match'),
      attempt(started.body.session_id, 'no_face'),
    ]);
    expect([left.response.status, right.response.status].sort()).toEqual([201, 201]);
    const numbers = await query<{ attempt_number: number }>(
      `SELECT attempt_number FROM identity_attempts
       WHERE session_id = $1 ORDER BY attempt_number`,
      [started.body.session_id]
    );
    expect(numbers.map((row) => row.attempt_number)).toEqual([1, 2]);

    const technicalEvent = newEvent('shift_out', 70);
    const technicalSession = await startSession(technicalEvent);
    const technical = await attempt(technicalSession.body.session_id, 'provider_unavailable');
    expect(technical.body).toMatchObject({
      status: 'review_required',
      consuming_attempts: 0,
      review_reason: 'provider_unavailable',
    });
  });

  it('recovers a verified session after response loss and keeps start time authoritative', async () => {
    const event = newEvent('shift_in', 90);
    const started = await startSession(event);
    const matched = await attempt(started.body.session_id, 'match');
    expect(matched.body.status).toBe('verified');
    const ingested = await jsonRequest('/api/punches/ingest', {
      method: 'POST',
      device: true,
      body: JSON.stringify({ ...event, source: 'kiosk' }),
    });
    expect(ingested.response.status).toBe(201);
    expect(ingested.body.identity_status).toBe('verified');
    expect(new Date(ingested.body.punched_at).toISOString()).toBe(started.body.server_started_at);
    const replay = await jsonRequest('/api/punches/ingest', {
      method: 'POST',
      device: true,
      body: JSON.stringify({ ...event, source: 'kiosk' }),
    });
    expect(replay.response.status).toBe(200);
    expect(replay.body).toMatchObject({ duplicate: true, identity_status: 'verified' });
  });

  it('creates a deterministic offline fallback linked to a visible review', async () => {
    const event = newEvent('shift_out', 110);
    const synced = await jsonRequest('/api/punches/sync', {
      method: 'POST',
      device: true,
      body: JSON.stringify({
        events: [{ ...event, identity_session_id: null, identity_bypass_reason: 'offline' }],
      }),
    });
    expect(synced.response.status).toBe(200);
    expect(synced.body.results[0]).toMatchObject({
      status: 'accepted',
      identity_status: 'identity_review',
    });
    const punch = await queryOne<{ identity_session_id: string; identity_bypass_reason: string }>(
      `SELECT identity_session_id, identity_bypass_reason FROM punches
       WHERE id = $1`,
      [synced.body.results[0].punch_id]
    );
    expect(punch).toMatchObject({ identity_bypass_reason: 'offline' });
    expect(punch!.identity_session_id).toBeTruthy();

    const prematureDecision = await jsonRequest(
      `/api/identity-reviews/${punch!.identity_session_id}/decisions`,
      {
        method: 'POST',
        bearer: fixture.adminToken,
        body: JSON.stringify({ decision: 'approve', reason: 'Evidence reviewed' }),
      }
    );
    expect(prematureDecision.response.status).toBe(409);
    expect(prematureDecision.body.code).toBe('identity_evidence_pending');

    const photo = await uploadPunchPhoto(synced.body.results[0].punch_id, event.client_event_id);
    expect(photo.response.status).toBe(201);
    expect(photo.body.client_event_id).toBe(event.client_event_id);
    const evidence = await queryOne<{ event_id: string; session_id: string }>(
      `SELECT a.provider_metadata->>'client_event_id' AS event_id, a.session_id
       FROM identity_attempts a
       WHERE a.session_id = $1 AND a.provider_metadata->>'kind' = 'punch_photo'`,
      [punch!.identity_session_id]
    );
    expect(evidence).toEqual({ event_id: event.client_event_id, session_id: punch!.identity_session_id });
  });

  it('preserves both offline photos, blocks an early decision, and never aliases after finality', async () => {
    const baseCapturedAt = new Date(Date.now() - 30_000);
    const firstEvent = {
      ...newEvent('meal_out'),
      captured_at: baseCapturedAt.toISOString(),
    };
    const secondEvent = {
      ...newEvent('meal_out'),
      client_installation_id: firstEvent.client_installation_id,
      captured_at: new Date(baseCapturedAt.getTime() + 1_000).toISOString(),
    };
    const synced = await jsonRequest('/api/punches/sync', {
      method: 'POST',
      device: true,
      body: JSON.stringify({
        events: [firstEvent, secondEvent].map((event) => ({
          ...event,
          identity_session_id: null,
          identity_bypass_reason: 'offline',
        })),
      }),
    });
    expect(synced.response.status).toBe(200);
    expect(synced.body.results.map((result: Record<string, any>) => result.status)).toEqual([
      'accepted',
      'duplicate',
    ]);
    const canonicalPunchId = synced.body.results[0].punch_id;
    expect(synced.body.results[1].punch_id).toBe(canonicalPunchId);

    const sessions = await query<{ id: string; client_event_id: string }>(
      `SELECT id, client_event_id FROM identity_sessions
       WHERE device_id = $1 AND client_event_id = ANY($2::uuid[])`,
      [fixture.deviceId, [firstEvent.client_event_id, secondEvent.client_event_id]]
    );
    const sessionByEvent = new Map(sessions.map((session) => [session.client_event_id, session.id]));
    const firstSessionId = sessionByEvent.get(firstEvent.client_event_id)!;
    const secondSessionId = sessionByEvent.get(secondEvent.client_event_id)!;
    const receipts = await queryOne<{ count: number }>(
      `SELECT count(*)::integer AS count FROM device_event_receipts
       WHERE punch_id = $1`,
      [canonicalPunchId]
    );
    const alias = await queryOne<{ alias_session_id: string; canonical_punch_id: string }>(
      `SELECT alias_session_id, canonical_punch_id FROM identity_session_punch_aliases
       WHERE alias_session_id = $1`,
      [secondSessionId]
    );
    expect(receipts!.count).toBe(2);
    expect(alias).toEqual({
      alias_session_id: secondSessionId,
      canonical_punch_id: canonicalPunchId,
    });

    const firstPhoto = await uploadPunchPhoto(
      canonicalPunchId,
      firstEvent.client_event_id,
      jpeg
    );
    expect(firstPhoto.response.status).toBe(201);
    const decisionWhileAliasPhotoPending = await jsonRequest(
      `/api/identity-reviews/${firstSessionId}/decisions`,
      {
        method: 'POST',
        bearer: fixture.adminToken,
        body: JSON.stringify({ decision: 'approve', reason: 'Both event photos reviewed' }),
      }
    );
    expect(decisionWhileAliasPhotoPending.response.status).toBe(409);
    expect(decisionWhileAliasPhotoPending.body).toMatchObject({
      code: 'identity_evidence_pending',
      details: { client_event_ids: [secondEvent.client_event_id] },
    });

    const secondPhoto = await uploadPunchPhoto(
      canonicalPunchId,
      secondEvent.client_event_id,
      alternateJpeg
    );
    expect(secondPhoto.response.status).toBe(201);
    expect(secondPhoto.body.punch_photo_key).toBe(firstPhoto.body.photo_key);
    await expect(storage.get(firstPhoto.body.photo_key)).resolves.toEqual(jpeg);
    await expect(storage.get(secondPhoto.body.photo_key)).resolves.toEqual(alternateJpeg);
    const eventEvidence = await query<{
      session_id: string;
      event_id: string;
      evidence_sha256: string;
    }>(
      `SELECT session_id, provider_metadata->>'client_event_id' AS event_id, evidence_sha256
       FROM identity_attempts
       WHERE session_id = ANY($1::uuid[]) AND provider_metadata->>'kind' = 'punch_photo'
       ORDER BY event_id`,
      [[firstSessionId, secondSessionId]]
    );
    expect(eventEvidence).toHaveLength(2);
    expect(new Set(eventEvidence.map((item) => item.session_id))).toEqual(
      new Set([firstSessionId, secondSessionId])
    );
    expect(new Set(eventEvidence.map((item) => item.evidence_sha256)).size).toBe(2);

    const finalDecision = await jsonRequest(
      `/api/identity-reviews/${firstSessionId}/decisions`,
      {
        method: 'POST',
        bearer: fixture.adminToken,
        body: JSON.stringify({ decision: 'approve', reason: 'Both event photos reviewed' }),
      }
    );
    expect(finalDecision.response.status).toBe(201);

    const lateEvent = {
      ...newEvent('meal_out'),
      client_installation_id: firstEvent.client_installation_id,
      captured_at: new Date(baseCapturedAt.getTime() + 2_000).toISOString(),
    };
    const late = await jsonRequest('/api/punches/sync', {
      method: 'POST',
      device: true,
      body: JSON.stringify({
        events: [{ ...lateEvent, identity_session_id: null, identity_bypass_reason: 'offline' }],
      }),
    });
    expect(late.body.results[0].status).toBe('accepted');
    expect(late.body.results[0].punch_id).not.toBe(canonicalPunchId);
    const lateSession = await queryOne<{ id: string }>(
      `SELECT id FROM identity_sessions WHERE device_id = $1 AND client_event_id = $2`,
      [fixture.deviceId, lateEvent.client_event_id]
    );
    const lateAlias = await queryOne(
      `SELECT 1 FROM identity_session_punch_aliases WHERE alias_session_id = $1`,
      [lateSession!.id]
    );
    expect(lateAlias).toBeNull();
    const latePhoto = await uploadPunchPhoto(
      late.body.results[0].punch_id,
      lateEvent.client_event_id,
      alternateJpeg
    );
    expect(latePhoto.response.status).toBe(201);
  });

  it('serializes a real alias-versus-decision race without attaching evidence after finality', async () => {
    const baseCapturedAt = new Date(Date.now() - 60_000);
    const canonicalEvent = {
      ...newEvent('meal_in'),
      captured_at: baseCapturedAt.toISOString(),
    };
    const canonical = await jsonRequest('/api/punches/sync', {
      method: 'POST',
      device: true,
      body: JSON.stringify({
        events: [
          { ...canonicalEvent, identity_session_id: null, identity_bypass_reason: 'offline' },
        ],
      }),
    });
    const canonicalPunchId = canonical.body.results[0].punch_id;
    expect(canonical.body.results[0].status).toBe('accepted');
    const canonicalSession = await queryOne<{ id: string }>(
      `SELECT id FROM identity_sessions WHERE device_id = $1 AND client_event_id = $2`,
      [fixture.deviceId, canonicalEvent.client_event_id]
    );
    expect(
      (await uploadPunchPhoto(canonicalPunchId, canonicalEvent.client_event_id, jpeg)).response.status
    ).toBe(201);

    const aliasEvent = {
      ...newEvent('meal_in'),
      client_installation_id: canonicalEvent.client_installation_id,
      captured_at: new Date(baseCapturedAt.getTime() + 1_000).toISOString(),
    };
    const decisionPayload = { decision: 'approve', reason: 'Concurrent evidence review' };
    const [decision, aliasSync] = await Promise.all([
      jsonRequest(`/api/identity-reviews/${canonicalSession!.id}/decisions`, {
        method: 'POST',
        bearer: fixture.adminToken,
        body: JSON.stringify(decisionPayload),
      }),
      jsonRequest('/api/punches/sync', {
        method: 'POST',
        device: true,
        body: JSON.stringify({
          events: [{ ...aliasEvent, identity_session_id: null, identity_bypass_reason: 'offline' }],
        }),
      }),
    ]);
    const aliasResult = aliasSync.body.results[0];
    const aliasSession = await queryOne<{ id: string }>(
      `SELECT id FROM identity_sessions WHERE device_id = $1 AND client_event_id = $2`,
      [fixture.deviceId, aliasEvent.client_event_id]
    );
    const alias = await queryOne<{ canonical_punch_id: string }>(
      `SELECT canonical_punch_id FROM identity_session_punch_aliases WHERE alias_session_id = $1`,
      [aliasSession!.id]
    );

    if (decision.response.status === 201) {
      expect(aliasResult.status).toBe('accepted');
      expect(aliasResult.punch_id).not.toBe(canonicalPunchId);
      expect(alias).toBeNull();
    } else {
      expect(decision.response.status).toBe(409);
      expect(decision.body.code).toBe('identity_evidence_pending');
      expect(aliasResult.status).toBe('duplicate');
      expect(aliasResult.punch_id).toBe(canonicalPunchId);
      expect(alias?.canonical_punch_id).toBe(canonicalPunchId);
    }

    expect(
      (await uploadPunchPhoto(aliasResult.punch_id, aliasEvent.client_event_id, alternateJpeg))
        .response.status
    ).toBe(201);
    if (decision.response.status === 409) {
      const retry = await jsonRequest(`/api/identity-reviews/${canonicalSession!.id}/decisions`, {
        method: 'POST',
        bearer: fixture.adminToken,
        body: JSON.stringify(decisionPayload),
      });
      expect(retry.response.status).toBe(201);
    }
    const canonicalStatus = await queryOne<{ identity_status: string }>(
      `SELECT identity_status FROM punches WHERE id = $1`,
      [canonicalPunchId]
    );
    expect(canonicalStatus!.identity_status).toBe('review_approved');
  });

  it('enforces review scope and a final idempotent decision without changing time', async () => {
    const pending = await jsonRequest('/api/identity-reviews?status=pending&limit=200', {
      bearer: fixture.adminToken,
    });
    expect(pending.response.status).toBe(200);
    expect(pending.body.total).toBeGreaterThan(0);
    const item = pending.body.items[0];
    const before = await queryOne<{
      punched_at: Date;
      captured_at: Date;
      punch_type: string;
      voided: boolean;
    }>(`SELECT punched_at, captured_at, punch_type, voided FROM punches WHERE id = $1`, [item.punch_id]);

    const accountant = await jsonRequest('/api/identity-reviews', {
      bearer: fixture.accountantToken,
    });
    const accountantEmployees = await jsonRequest('/api/employees', {
      bearer: fixture.accountantToken,
    });
    const accountantAttendance = await jsonRequest('/api/attendance/today', {
      bearer: fixture.accountantToken,
    });
    expect([accountant.response.status, accountantEmployees.response.status, accountantAttendance.response.status])
      .toEqual([403, 403, 403]);
    const outside = await jsonRequest(`/api/identity-reviews/${item.session_id}`, {
      bearer: fixture.outsideForemanToken,
    });
    expect(outside.response.status).toBe(403);
    const otherTenant = await jsonRequest('/api/identity-reviews?status=all', {
      bearer: fixture.otherTenantAdminToken,
    });
    expect(otherTenant.body.total).toBe(0);

    const decisionBody = { decision: 'reject', reason: 'Photo does not match employee' };
    const decided = await jsonRequest(`/api/identity-reviews/${item.session_id}/decisions`, {
      method: 'POST',
      bearer: fixture.adminToken,
      body: JSON.stringify(decisionBody),
    });
    expect(decided.response.status).toBe(201);
    const retry = await jsonRequest(`/api/identity-reviews/${item.session_id}/decisions`, {
      method: 'POST',
      bearer: fixture.adminToken,
      body: JSON.stringify(decisionBody),
    });
    expect(retry.response.status).toBe(200);
    expect(retry.body.duplicate).toBe(true);
    const changed = await jsonRequest(`/api/identity-reviews/${item.session_id}/decisions`, {
      method: 'POST',
      bearer: fixture.adminToken,
      body: JSON.stringify({ decision: 'approve', reason: 'Different final decision' }),
    });
    expect(changed.response.status).toBe(409);
    const after = await queryOne<{
      punched_at: Date;
      captured_at: Date;
      punch_type: string;
      voided: boolean;
      identity_status: string;
    }>(
      `SELECT punched_at, captured_at, punch_type, voided, identity_status
       FROM punches WHERE id = $1`,
      [item.punch_id]
    );
    expect({
      punched_at: after!.punched_at,
      captured_at: after!.captured_at,
      punch_type: after!.punch_type,
      voided: after!.voided,
    }).toEqual(before);
    expect(after!.identity_status).toBe('review_rejected');
  });

  it('purges late-uploaded offline evidence by capture time without leaving an unmarked broken URL', async () => {
    const capturedAt = new Date(Date.now() - 30_000);
    const cutoff = new Date(Date.now() - 10_000);
    const event = {
      ...newEvent('shift_out'),
      captured_at: capturedAt.toISOString(),
    };
    const synced = await jsonRequest('/api/punches/sync', {
      method: 'POST',
      device: true,
      body: JSON.stringify({
        events: [{ ...event, identity_session_id: null, identity_bypass_reason: 'offline' }],
      }),
    });
    expect(synced.body.results[0].status).toBe('accepted');
    const punchId = synced.body.results[0].punch_id;
    const uploaded = await uploadPunchPhoto(punchId, event.client_event_id, alternateJpeg);
    expect(uploaded.response.status).toBe(201);
    await expect(storage.get(uploaded.body.photo_key)).resolves.toEqual(alternateJpeg);

    const attemptRow = await queryOne<{
      id: string;
      captured_at: Date;
      created_at: Date;
      evidence_key: string;
    }>(
      `SELECT id, captured_at, created_at, evidence_key
       FROM identity_attempts
       WHERE provider_metadata->>'client_event_id' = $1`,
      [event.client_event_id]
    );
    expect(attemptRow!.captured_at.getTime()).toBeLessThan(cutoff.getTime());
    expect(attemptRow!.created_at.getTime()).toBeGreaterThan(cutoff.getTime());

    const removed = await cleanupOrganizationPhotoEvidence(fixture.organizationId, cutoff);
    expect(removed).toBeGreaterThanOrEqual(2);
    const purge = await queryOne<{ evidence_key: string }>(
      `SELECT evidence_key FROM identity_evidence_purges WHERE attempt_id = $1`,
      [attemptRow!.id]
    );
    expect(purge?.evidence_key).toBe(attemptRow!.evidence_key);
    const punch = await queryOne<{ photo_key: string | null }>(
      `SELECT photo_key FROM punches WHERE id = $1`,
      [punchId]
    );
    expect(punch!.photo_key).toBeNull();
    await expect(storage.get(attemptRow!.evidence_key)).rejects.toThrow();
  });

  it('enforces append-only constraints and records retention purges', async () => {
    await expect(
      pool.query(
        `INSERT INTO identity_sessions
           (organization_id, plant_id, device_id, employee_id, client_event_id,
            client_installation_id, client_sequence, punch_type, captured_at,
            payload_hash, mode, provider, provider_liveness_capable,
            liveness_status, status, resolved_at)
         VALUES ($1, $2, $3, $4, gen_random_uuid(), gen_random_uuid(), 999999,
                 'shift_in', now(), repeat('a', 64), 'review_only', 'review_only',
                 false, 'not_performed', 'verified', now())`,
        [fixture.organizationId, fixture.plantId, fixture.deviceId, fixture.employeeId]
      )
    ).rejects.toMatchObject({ code: '23514' });
    const attemptRow = await queryOne<{ id: string }>(`SELECT id FROM identity_attempts LIMIT 1`);
    await expect(
      pool.query(`UPDATE identity_attempts SET result = 'match' WHERE id = $1`, [attemptRow!.id])
    ).rejects.toThrow(/append-only/i);
    const before = await queryOne<{ count: number }>(
      `SELECT count(*)::integer AS count FROM identity_evidence_purges
       WHERE organization_id = $1`,
      [fixture.organizationId]
    );
    const purged = await cleanupIdentityAttemptEvidence(
      fixture.organizationId,
      new Date(Date.now() + 60_000)
    );
    expect(purged).toBeGreaterThan(0);
    const purgeRows = await queryOne<{ count: number }>(
      `SELECT count(*)::integer AS count FROM identity_evidence_purges
       WHERE organization_id = $1`,
      [fixture.organizationId]
    );
    expect(purgeRows!.count - before!.count).toBe(purged);
  });
});
