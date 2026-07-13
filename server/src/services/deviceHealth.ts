import { DateTime } from 'luxon';

export interface DeviceHealthState {
  pending_event_count: number;
  rejected_event_count: number;
  last_heartbeat_at: Date | null;
  storage_status: 'unknown' | 'ready' | 'degraded' | 'unavailable';
}

export interface RevocableDeviceHealthState extends DeviceHealthState {
  enrolled_at: Date | null;
}

export function deviceHealthReasons(
  device: DeviceHealthState,
  now = new Date(),
  requiredHeartbeatAfter?: Date
): string[] {
  const reasons: string[] = [];
  if (device.pending_event_count > 0) {
    reasons.push(`${device.pending_event_count} evento(s) pendiente(s)`);
  }
  if (device.rejected_event_count > 0) {
    reasons.push(`${device.rejected_event_count} evento(s) rechazado(s)`);
  }
  if (device.storage_status === 'unknown') {
    reasons.push('Estado del almacenamiento sin confirmar');
  } else if (device.storage_status === 'unavailable') {
    reasons.push('Almacenamiento local no disponible');
  }
  if (!device.last_heartbeat_at) {
    reasons.push('Sin heartbeat registrado');
  } else {
    if (
      requiredHeartbeatAfter &&
      device.last_heartbeat_at.getTime() <= requiredHeartbeatAfter.getTime()
    ) {
      reasons.push('Heartbeat no confirmado después del cierre del periodo');
    }
    if (now.getTime() - device.last_heartbeat_at.getTime() > 24 * 60 * 60 * 1000) {
      reasons.push('Heartbeat con más de 24 horas');
    }
  }
  return reasons;
}

/**
 * An unused activation record may be revoked immediately. Once a kiosk has
 * enrolled, however, revocation must not make unhealthy local state disappear
 * from the pay-period finalization gate.
 */
export function deviceRevocationReasons(
  device: RevocableDeviceHealthState,
  now = new Date()
): string[] {
  return device.enrolled_at ? deviceHealthReasons(device, now) : [];
}

export function periodHeartbeatBoundary(weekEnd: string, timezone: string): Date {
  const boundary = DateTime.fromISO(weekEnd, { zone: timezone }).plus({ days: 1 }).startOf('day');
  if (!boundary.isValid) throw new Error('invalid pay-period boundary');
  return boundary.toJSDate();
}
