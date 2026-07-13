import { describe, expect, it } from 'vitest';
import { ApiError } from '../api';
import { canOverrideDeviceHealth, parseDeviceHealthConflict } from './deviceHealth';

describe('excepción de salud al cerrar semana', () => {
  it('preserva el detalle estructurado y exige admin, motivo y confirmación', () => {
    const error = new ApiError(409, 'Hay dispositivos sin sincronizar', 'device_health_blockers', {
      devices: [{
        id: '11111111-1111-4111-8111-111111111111',
        name: 'Kiosco 1',
        plant_name: 'Planta A',
        reasons: ['Tiene eventos pendientes'],
        pending_event_count: 2,
        rejected_event_count: 1,
        last_heartbeat_at: null,
      }],
    });
    expect(parseDeviceHealthConflict(error)?.devices[0]?.pending_event_count).toBe(2);
    expect(canOverrideDeviceHealth({ isAdmin: true, confirmed: true, reason: 'Revisado' })).toBe(true);
    expect(canOverrideDeviceHealth({ isAdmin: false, confirmed: true, reason: 'Revisado' })).toBe(false);
    expect(canOverrideDeviceHealth({ isAdmin: true, confirmed: false, reason: 'Revisado' })).toBe(false);
    expect(canOverrideDeviceHealth({ isAdmin: true, confirmed: true, reason: '  ' })).toBe(false);
  });
});

