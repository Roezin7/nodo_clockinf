export const OFFLINE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
export const CAPTURE_MAX_FUTURE_MS = 5 * 60 * 1000;

export interface SequencedDeviceEvent {
  client_event_id: string;
  client_installation_id: string;
  client_sequence: number;
  captured_at: string;
}

export interface ComparableClientEvent extends SequencedDeviceEvent {
  employee_number: number;
  punch_type: string;
  evidence_status: string;
  client_clock_skew_seconds: number | null;
}

export interface ComparablePersistedEvent {
  employee_number: number;
  punch_type: string;
  captured_at: Date;
  client_sequence: string | number;
  client_installation_id: string;
  evidence_status: string;
  client_clock_skew_seconds: number | null;
}

export type CapturedAtValidation =
  | { ok: true; date: Date }
  | { ok: false; code: 'captured_in_future' | 'captured_too_old'; error: string };

/** Applies the server trust window to a syntactically-valid captured_at. */
export function validateCapturedAt(
  capturedAt: string,
  now = new Date()
): CapturedAtValidation {
  const date = new Date(capturedAt);
  if (date.getTime() - now.getTime() > CAPTURE_MAX_FUTURE_MS) {
    return {
      ok: false,
      code: 'captured_in_future',
      error: 'La hora capturada está más de 5 minutos en el futuro',
    };
  }
  if (now.getTime() - date.getTime() > OFFLINE_MAX_AGE_MS) {
    return {
      ok: false,
      code: 'captured_too_old',
      error: 'La checada tiene más de 14 días y requiere corrección manual',
    };
  }
  return { ok: true, date };
}

/** Converts a raw tablet timestamp into server-aligned time using client-server skew. */
export function normalizeCapturedAt(capturedAt: string, clientClockSkewSeconds: number): Date {
  return new Date(new Date(capturedAt).getTime() - clientClockSkewSeconds * 1000);
}

/** Null means no trusted snapshot existed: preserve the raw capture exactly. */
export function normalizeCapturedAtSnapshot(
  capturedAt: string,
  clientClockSkewSeconds: number | null
): Date {
  return clientClockSkewSeconds === null
    ? new Date(capturedAt)
    : normalizeCapturedAt(capturedAt, clientClockSkewSeconds);
}

/** Stable ordering preserves input order when two malformed clients reuse a sequence. */
export function sortDeviceEvents<T extends SequencedDeviceEvent>(events: T[]): T[] {
  return events
    .map((event, inputOrder) => ({ event, inputOrder }))
    .sort(
      (left, right) =>
        left.event.client_sequence - right.event.client_sequence || left.inputOrder - right.inputOrder
    )
    .map(({ event }) => event);
}

/** A retry UUID may only replay the exact immutable event payload. */
export function deviceEventMatches(
  persisted: ComparablePersistedEvent,
  client: ComparableClientEvent
): boolean {
  return (
    persisted.employee_number === client.employee_number &&
    persisted.punch_type === client.punch_type &&
    persisted.evidence_status === client.evidence_status &&
    persisted.client_installation_id === client.client_installation_id &&
    persisted.client_clock_skew_seconds === client.client_clock_skew_seconds &&
    Number(persisted.client_sequence) === client.client_sequence &&
    persisted.captured_at.getTime() === new Date(client.captured_at).getTime()
  );
}
