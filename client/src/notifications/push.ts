import { ApiError, api } from '../api';

export interface PushAvailability {
  enabled: boolean;
  public_key: string | null;
}

export interface SavedPushSubscription {
  id: string;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export function urlBase64ToArrayBuffer(value: string): ArrayBuffer {
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
  const decoded = atob(base64);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }
  return bytes.buffer as ArrayBuffer;
}

export function browserSupportsPush(): boolean {
  return (
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

export async function getPushAvailability(): Promise<PushAvailability> {
  return api<PushAvailability>('/api/notifications/push-config');
}

/**
 * Call only from an explicit user gesture (for example, an “Activar alertas”
 * button). This helper intentionally never requests permission on page load.
 */
export async function enableOperationalPush(): Promise<SavedPushSubscription> {
  if (!browserSupportsPush()) throw new Error('Este navegador no admite notificaciones push');
  const availability = await getPushAvailability();
  if (!availability.enabled || !availability.public_key) {
    throw new Error('Las notificaciones push no están configuradas');
  }
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Permiso de notificaciones no concedido');

  // Production registers at application startup. Register here as a safe
  // fallback so an explicit user gesture cannot hang forever after a failed
  // first-load registration (or while testing the production build).
  const registration =
    (await navigator.serviceWorker.getRegistration('/')) ??
    (await navigator.serviceWorker.register('/sw.js', { scope: '/' }));
  const existing = await registration.pushManager.getSubscription();
  const subscription =
    existing ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToArrayBuffer(availability.public_key),
    }));
  return api<SavedPushSubscription>('/api/notifications/push-subscriptions', {
    method: 'POST',
    body: JSON.stringify(subscription.toJSON()),
  });
}

export async function disableOperationalPush(): Promise<void> {
  if (!browserSupportsPush()) return;
  const registration = await navigator.serviceWorker.getRegistration('/');
  if (!registration) return;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return;
  try {
    await api<void>('/api/notifications/push-subscriptions/current', {
      method: 'DELETE',
      body: JSON.stringify({ endpoint: subscription.endpoint }),
    });
  } catch (error) {
    // A missing server row is already the desired state. Authentication or
    // connectivity failures remain visible so a server capability is not left
    // active while the browser silently discards its local endpoint.
    if (!(error instanceof ApiError) || error.status !== 404) throw error;
  }
  await subscription.unsubscribe();
}
