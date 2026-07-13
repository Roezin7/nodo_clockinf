import { ApiError } from '../api';

export interface DeviceHealthBlocker {
  id: string;
  name: string;
  plant_name: string;
  reasons: string[];
  pending_event_count: number;
  rejected_event_count: number;
  last_heartbeat_at: string | null;
}

export interface DeviceHealthConflict {
  message: string;
  devices: DeviceHealthBlocker[];
}

function isBlocker(value: unknown): value is DeviceHealthBlocker {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === 'string' &&
    typeof row.name === 'string' &&
    typeof row.plant_name === 'string' &&
    Array.isArray(row.reasons) &&
    row.reasons.every((reason) => typeof reason === 'string') &&
    typeof row.pending_event_count === 'number' &&
    typeof row.rejected_event_count === 'number' &&
    (row.last_heartbeat_at === null || typeof row.last_heartbeat_at === 'string')
  );
}

export function parseDeviceHealthConflict(error: unknown): DeviceHealthConflict | null {
  if (!(error instanceof ApiError) || error.code !== 'device_health_blockers') return null;
  const details = error.details as { devices?: unknown } | undefined;
  const devices = Array.isArray(details?.devices) ? details.devices.filter(isBlocker) : [];
  return { message: error.message, devices };
}

export function canOverrideDeviceHealth(input: {
  isAdmin: boolean;
  confirmed: boolean;
  reason: string;
}): boolean {
  return input.isAdmin && input.confirmed && input.reason.trim().length >= 3;
}

