import { kioskFetch, KIOSK_TIMEOUT_MS } from './fetch';

const DEVICE_TOKEN_KEY = 'clockai.kiosk.token';
const PENDING_KEY = 'clockai.kiosk.pendingEnrollment';

export interface EnrollmentAttempt {
  enrollmentToken: string;
  proposedDeviceToken: string;
}

export interface EnrolledDevice {
  id: string;
  name: string;
  plant_name?: string;
  public_id?: string;
  timezone?: string;
}

export interface EnrollmentResult {
  deviceToken: string;
  device: EnrolledDevice | null;
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function readPending(): EnrollmentAttempt | null {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<EnrollmentAttempt>;
    return parsed.enrollmentToken && parsed.proposedDeviceToken
      ? { enrollmentToken: parsed.enrollmentToken, proposedDeviceToken: parsed.proposedDeviceToken }
      : null;
  } catch {
    return null;
  }
}

/**
 * Copia el código del fragmento a almacenamiento durable antes de limpiarlo.
 * El fragmento nunca se envía en HTTP; el intento sobrevive reinicios/offline.
 */
export function prepareEnrollmentAttempt(): EnrollmentAttempt | null {
  const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const fromFragment = fragment.get('enroll');
  const pending = readPending();
  if (!fromFragment) return pending;
  const attempt =
    pending?.enrollmentToken === fromFragment
      ? pending
      : { enrollmentToken: fromFragment, proposedDeviceToken: randomToken() };
  localStorage.setItem(PENDING_KEY, JSON.stringify(attempt));
  window.history.replaceState(null, '', '/kiosk');
  return attempt;
}

async function verifyProposedToken(attempt: EnrollmentAttempt): Promise<EnrollmentResult | null> {
  try {
    const response = await kioskFetch('/api/punches/kiosk/self', {
      headers: { 'x-device-token': attempt.proposedDeviceToken },
    }, KIOSK_TIMEOUT_MS.self);
    if (!response.ok) return null;
    const device = (await response.json()) as EnrolledDevice;
    return { deviceToken: attempt.proposedDeviceToken, device };
  } catch {
    return null;
  }
}

async function executeEnrollment(attempt: EnrollmentAttempt): Promise<EnrollmentResult> {
  let result: EnrollmentResult | null = null;
  try {
    const response = await kioskFetch('/api/punches/kiosk/enroll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enrollment_token: attempt.enrollmentToken,
        proposed_device_token: attempt.proposedDeviceToken,
      }),
    }, KIOSK_TIMEOUT_MS.enrollment);
    const body = (await response.json().catch(() => ({}))) as {
      device_token?: string;
      device?: EnrolledDevice;
      error?: string;
    };
    if (response.ok) {
      result = {
        deviceToken: body.device_token ?? attempt.proposedDeviceToken,
        device: body.device ?? null,
      };
    } else {
      result = await verifyProposedToken(attempt);
      if (!result) throw new Error(body.error ?? 'El enlace ya fue usado o expiró.');
    }
  } catch (error) {
    result = await verifyProposedToken(attempt);
    if (!result) throw error;
  }

  return result;
}

let enrollmentFlight: Promise<EnrollmentResult> | null = null;

/** Single-flight evita consumir dos veces el código bajo React.StrictMode. */
export function enrollDevice(attempt: EnrollmentAttempt): Promise<EnrollmentResult> {
  enrollmentFlight ??= executeEnrollment(attempt).finally(() => {
    enrollmentFlight = null;
  });
  return enrollmentFlight;
}

/** Promoción durable separada para que el kiosco revalide que su cola sigue vacía. */
export function completeEnrollment(result: EnrollmentResult): void {
  localStorage.setItem(DEVICE_TOKEN_KEY, result.deviceToken);
  localStorage.removeItem(PENDING_KEY);
}

export function cancelEnrollmentAttempt(): void {
  localStorage.removeItem(PENDING_KEY);
}
