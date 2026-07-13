import 'fake-indexeddb/auto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  acknowledgeEvent,
  __resetKioskDatabaseForTests,
  deleteQueuedEvent,
  enqueuePunch,
  listQueuedEvents,
  photoForEvent,
  queueStats,
  recoverProvisionalEvents,
  getClientInstallationId,
  prepareIdentityAttempt,
  setIdentityOutcome,
  setIdentitySession,
} from './db';
import { flushKioskQueue, sendHeartbeat } from './sync';
import { KIOSK_TIMEOUT_MS } from './fetch';

Object.defineProperty(globalThis, 'window', { value: globalThis, configurable: true });
Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });

const token = 'device-secret-with-enough-entropy-for-test';
const photoBytes = new Uint8Array([255, 216, 255, 224, 1, 2, 3, 4, 255, 217]);

function openRawDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('clockai-kiosk-v1', 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function corruptPayload(id: string): Promise<void> {
  const db = await openRawDatabase();
  const transaction = db.transaction('events', 'readwrite');
  const store = transaction.objectStore('events');
  const record = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const request = store.get(id);
    request.onsuccess = () => resolve(request.result as Record<string, unknown>);
    request.onerror = () => reject(request.error);
  });
  const ciphertext = new Uint8Array(record.payloadCiphertext as ArrayBuffer);
  ciphertext[0] = (ciphertext[0] ?? 0) ^ 0xff;
  record.payloadCiphertext = ciphertext.buffer;
  store.put(record);
  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}

describe('cola cifrada del kiosco', () => {
  afterAll(() => vi.restoreAllMocks());

  it('conserva evento+foto hasta ambos ACK, recupera reload y aísla corrupción', async () => {
    const first = await enqueuePunch(token, {
      employeeNumber: 42,
      punchType: 'shift_in',
      capturedAt: '2026-07-14T12:00:00.000Z',
      photo: new Blob([photoBytes], { type: 'image/jpeg' }),
    });
    expect((await queueStats()).pending).toBe(1);
    await recoverProvisionalEvents();
    const firstReloaded = (await listQueuedEvents(token))[0];
    expect(firstReloaded?.state).toBe('pending');
    expect(firstReloaded?.payload.clientInstallationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(firstReloaded?.payload.clientClockSkewSeconds).toBeNull();

    await acknowledgeEvent(token, first.id, { punchId: '11111111-1111-4111-8111-111111111111' });
    expect((await listQueuedEvents(token))[0]?.state).toBe('event_accepted');
    expect(new Uint8Array(await (await photoForEvent(token, first.id))!.arrayBuffer())).toEqual(photoBytes);
    expect((await queueStats()).pending).toBe(1); // evento ACK, foto todavía no
    await deleteQueuedEvent(first.id);

    const corrupt = await enqueuePunch(token, {
      employeeNumber: 7,
      punchType: 'meal_out',
      capturedAt: '2026-07-14T16:00:00.000Z',
      photo: new Blob([photoBytes], { type: 'image/jpeg' }),
    });
    const healthy = await enqueuePunch(token, {
      employeeNumber: 8,
      punchType: 'meal_in',
      capturedAt: '2026-07-14T16:30:00.000Z',
      photo: new Blob([photoBytes], { type: 'image/jpeg' }),
    });
    expect(healthy.payload.clientInstallationId).toBe(corrupt.payload.clientInstallationId);
    await recoverProvisionalEvents();
    await corruptPayload(corrupt.id);
    const readable = await listQueuedEvents(token);
    expect(readable.map((event) => event.id)).toEqual([healthy.id]);
    expect(await queueStats()).toEqual({ pending: 1, rejected: 1 });
    await deleteQueuedEvent(corrupt.id);
    await deleteQueuedEvent(healthy.id);

    let heartbeatPayload: Record<string, unknown> | null = null;
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      heartbeatPayload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ clock_skew_seconds: 37 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }));
    expect(
      await sendHeartbeat(token, null, 'storage unavailable', {
        cameraStatus: 'ready',
        storageStatus: 'unavailable',
      })
    ).toBe(true);
    expect(heartbeatPayload).not.toHaveProperty('pending_count');
    expect(heartbeatPayload).not.toHaveProperty('rejected_count');
    expect(heartbeatPayload).toMatchObject({ storage_status: 'unavailable' });

    const retry = await enqueuePunch(token, {
      employeeNumber: 99,
      punchType: 'shift_out',
      capturedAt: '2026-07-14T22:00:00.000Z',
      photo: new Blob([photoBytes], { type: 'image/jpeg' }),
    });
    expect(retry.payload.clientClockSkewSeconds).toBe(37);
    const identitySessionId = '33333333-3333-4333-8333-333333333333';
    const identityAttemptId = '44444444-4444-4444-8444-444444444444';
    await setIdentitySession(token, retry.id, identitySessionId);
    await prepareIdentityAttempt(token, retry.id, {
      attemptId: identityAttemptId,
      capturedAt: '2026-07-14T22:00:01.000Z',
      photo: new Blob([new Uint8Array([9, 8, 7])], { type: 'image/jpeg' }),
      evidenceStatus: 'captured',
    });
    await setIdentityOutcome(token, retry.id, 'identity_review', 'provider_unavailable');
    const identityPersisted = (await listQueuedEvents(token))[0]!;
    expect(identityPersisted.payload).toMatchObject({
      identitySessionId,
      identityAttemptId,
      identityAttemptCapturedAt: '2026-07-14T22:00:01.000Z',
      identityOutcome: 'identity_review',
      identityBypassReason: 'provider_unavailable',
    });
    expect(new Uint8Array(await (await photoForEvent(token, retry.id))!.arrayBuffer())).toEqual(
      new Uint8Array([9, 8, 7])
    );

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ clock_skew_seconds: -12 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })));
    expect(await sendHeartbeat(token, { pending: 1, rejected: 0 })).toBe(true);
    expect(retry.payload.clientClockSkewSeconds).toBe(37); // snapshot histórico, no se reescribe

    await recoverProvisionalEvents();
    let syncCalls = 0;
    let photoCalls = 0;
    let syncedInstallationId: string | null = null;
    let syncedClockSkew: number | null = null;
    let syncedIdentitySessionId: string | null = null;
    let syncedIdentityBypassReason: string | null = null;
    const uploadedEventIds: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/punches/sync') {
        syncCalls += 1;
        const request = JSON.parse(String(init?.body)) as {
          events: {
            client_installation_id: string;
            client_clock_skew_seconds: number | null;
            identity_session_id: string | null;
            identity_bypass_reason: string | null;
          }[];
        };
        syncedInstallationId = request.events[0]?.client_installation_id ?? null;
        syncedClockSkew = request.events[0]?.client_clock_skew_seconds ?? null;
        syncedIdentitySessionId = request.events[0]?.identity_session_id ?? null;
        syncedIdentityBypassReason = request.events[0]?.identity_bypass_reason ?? null;
        return new Response(JSON.stringify({
          results: [{
            client_event_id: retry.id,
            status: 'accepted',
            punch_id: '22222222-2222-4222-8222-222222222222',
          }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      photoCalls += 1;
      expect(init?.body).toBeInstanceOf(FormData);
      uploadedEventIds.push(String((init?.body as FormData).get('client_event_id')));
      return new Response(null, { status: photoCalls === 1 ? 503 : 204 });
    }));

    expect((await flushKioskQueue(token)).stats.pending).toBe(1);
    expect((await listQueuedEvents(token))[0]?.state).toBe('event_accepted');
    expect((await flushKioskQueue(token)).stats.pending).toBe(0);
    expect(syncCalls).toBe(1); // no recrea la checada al reintentar sólo la foto
    expect(photoCalls).toBe(2);
    expect(uploadedEventIds).toEqual([retry.id, retry.id]);
    expect(syncedInstallationId).toBe(retry.payload.clientInstallationId);
    expect(syncedClockSkew).toBe(37);
    expect(syncedIdentitySessionId).toBe(identitySessionId);
    expect(syncedIdentityBypassReason).toBe('provider_unavailable');

    const installationBeforeDelete = await getClientInstallationId();
    expect(installationBeforeDelete).toBe(retry.payload.clientInstallationId);
    await __resetKioskDatabaseForTests();
    const installationAfterDelete = await getClientInstallationId();
    expect(installationAfterDelete).not.toBe(installationBeforeDelete);

    const hanging = await enqueuePunch(token, {
      employeeNumber: 100,
      punchType: 'shift_in',
      capturedAt: '2026-07-15T12:00:00.000Z',
      photo: new Blob([photoBytes], { type: 'image/jpeg' }),
    });
    expect(hanging.payload.clientClockSkewSeconds).toBeNull();
    await recoverProvisionalEvents();

    const mutableTimeouts = KIOSK_TIMEOUT_MS as { sync: number };
    const originalSyncTimeout = mutableTimeouts.sync;
    mutableTimeouts.sync = 10;
    let requestStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      requestStarted = resolve;
    });
    vi.stubGlobal('fetch', vi.fn(async () => {
      requestStarted();
      // Headers arrive with 200, but this independent body never closes and
      // deliberately ignores AbortSignal to exercise the explicit deadline.
      const stalledBody = new ReadableStream<Uint8Array>({ start() {} });
      return new Response(stalledBody, { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const hangingFlush = flushKioskQueue(token);
    await started;
    expect((await hangingFlush).stats.pending).toBe(1);
    expect((await listQueuedEvents(token))[0]?.id).toBe(hanging.id);
    mutableTimeouts.sync = originalSyncTimeout;
  });
});
