import {
  acknowledgeEvent,
  deleteQueuedEvent,
  listQueuedEvents,
  markPending,
  markEvidenceError,
  markRejected,
  photoForEvent,
  queueStats,
  setClockSkewSeconds,
  type QueueStats,
  type QueuedEvent,
} from './db';
import type { DeviceComponentStatus } from '@clockai/shared';
import { kioskFetch, KIOSK_TIMEOUT_MS } from './fetch';

export interface SyncResult {
  client_event_id: string;
  status: 'accepted' | 'duplicate' | 'rejected';
  punch_id?: string;
  employee_name?: string;
  punched_at_local?: string;
  timezone?: string;
  error?: string;
  reason?: string;
  code?: string;
}

export interface FlushResult {
  stats: QueueStats;
  serverReachable: boolean;
  lastError: string | null;
}

let activeFlush: Promise<FlushResult> | null = null;

class EvidenceDecryptError extends Error {}

async function uploadEvidence(token: string, event: QueuedEvent): Promise<boolean> {
  const punchId = event.payload.punchId;
  if (!punchId) return false;
  let photo: Blob | null;
  try {
    photo = await photoForEvent(token, event.id);
  } catch {
    throw new EvidenceDecryptError('La fotografía cifrada no se pudo leer');
  }
  if (!photo) return false;
  const form = new FormData();
  form.append('photo', photo, `${event.id}.jpg`);
  const response = await kioskFetch(`/api/punches/${encodeURIComponent(punchId)}/photo`, {
    method: 'POST',
    headers: { 'x-device-token': token },
    body: form,
  }, KIOSK_TIMEOUT_MS.photo);
  return response.ok;
}

function resultArray(body: unknown): SyncResult[] {
  if (Array.isArray(body)) return body as SyncResult[];
  if (body && typeof body === 'object' && Array.isArray((body as { results?: unknown }).results)) {
    return (body as { results: SyncResult[] }).results;
  }
  return [];
}

async function doFlush(token: string): Promise<FlushResult> {
  let serverReachable = navigator.onLine;
  let lastError: string | null = null;
  try {
    const queued = await listQueuedEvents(token);
    const pending = queued.filter((event) => event.state === 'pending').slice(0, 100);

    if (pending.length) {
      let response: Response;
      try {
        response = await kioskFetch('/api/punches/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-device-token': token },
          body: JSON.stringify({
            events: pending.map((event) => ({
              employee_number: event.payload.employeeNumber,
              punch_type: event.payload.punchType,
              client_event_id: event.id,
              captured_at: event.payload.capturedAt,
              client_sequence: event.payload.clientSequence,
              evidence_status: event.payload.evidenceStatus,
              client_installation_id: event.payload.clientInstallationId,
              client_clock_skew_seconds: event.payload.clientClockSkewSeconds,
            })),
          }),
        }, KIOSK_TIMEOUT_MS.sync);
        serverReachable = true;
      } catch {
        serverReachable = false;
        lastError = 'Servidor no disponible';
        return { stats: await queueStats(), serverReachable, lastError };
      }

      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        lastError = body.error ?? `Error de sincronización ${response.status}`;
        for (const event of pending) await markPending(event.id, lastError);
        return { stats: await queueStats(), serverReachable, lastError };
      }

      const results = resultArray(await response.json().catch(() => []));
      const byId = new Map(results.map((result) => [result.client_event_id, result]));
      for (const event of pending) {
        const result = byId.get(event.id);
        if (!result) {
          await markPending(event.id, 'El servidor no devolvió resultado para este evento');
        } else if ((result.status === 'accepted' || result.status === 'duplicate') && result.punch_id) {
          await acknowledgeEvent(token, event.id, {
            punchId: result.punch_id,
            employeeName: result.employee_name,
            punchedAtLocal: result.punched_at_local,
            timezone: result.timezone,
          });
        } else if (result.status === 'rejected') {
          const reason = result.error ?? result.reason ?? 'Evento rechazado por el servidor';
          await markRejected(event.id, result.code ? `[${result.code}] ${reason}` : reason);
        } else {
          await markPending(event.id, 'Respuesta incompleta del servidor');
        }
      }
    }

    // Releer: incluye aceptaciones de esta corrida y checadas online cuya foto falló.
    const acknowledged = (await listQueuedEvents(token)).filter((event) => event.state === 'event_accepted');
    for (const event of acknowledged) {
      try {
        if (await uploadEvidence(token, event)) await deleteQueuedEvent(event.id);
        else await markEvidenceError(event.id, 'No se pudo confirmar la fotografía');
      } catch (error) {
        if (error instanceof EvidenceDecryptError) {
          await markRejected(event.id, '[evidence_decrypt_error] Fotografía local ilegible; requiere revisión');
          lastError = error.message;
          continue;
        }
        serverReachable = false;
        lastError = 'Fotografía pendiente de sincronizar';
        break;
      }
    }
  } catch (error) {
    lastError = error instanceof Error ? error.message : 'Error de almacenamiento local';
  }
  return { stats: await queueStats(), serverReachable, lastError };
}

export function flushKioskQueue(token: string): Promise<FlushResult> {
  activeFlush ??= doFlush(token).finally(() => {
    activeFlush = null;
  });
  return activeFlush;
}

export async function sendHeartbeat(
  token: string,
  stats: QueueStats | null,
  lastError?: string | null,
  health?: { cameraStatus?: DeviceComponentStatus; storageStatus?: DeviceComponentStatus }
): Promise<boolean> {
  try {
    const response = await kioskFetch('/api/punches/kiosk/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-device-token': token },
      body: JSON.stringify({
        ...(stats ? { pending_count: stats.pending, rejected_count: stats.rejected } : {}),
        app_version: '0.1.0',
        client_time: new Date().toISOString(),
        camera_status: health?.cameraStatus ?? 'unknown',
        storage_status: health?.storageStatus ?? 'unknown',
        ...(lastError ? { last_error: lastError.slice(0, 300) } : {}),
      }),
    }, KIOSK_TIMEOUT_MS.heartbeat);
    if (!response.ok) return false;
    const body = (await response.json().catch(() => ({}))) as { clock_skew_seconds?: unknown };
    const clockSkewSeconds = Number.isInteger(body.clock_skew_seconds)
      ? (body.clock_skew_seconds as number)
      : null;
    await setClockSkewSeconds(clockSkewSeconds);
    return true;
  } catch {
    return false;
  }
}
