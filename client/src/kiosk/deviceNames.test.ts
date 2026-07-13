import { describe, expect, it } from 'vitest';
import { kioskNamesToReachTarget } from './deviceNames';

describe('nombres automáticos de checadores', () => {
  it('no reutiliza nombres revocados ni activos', () => {
    const devices = [
      { plant_id: 'a', name: 'Kiosco 1', active: false },
      { plant_id: 'a', name: 'Kiosco 2', active: true },
      { plant_id: 'b', name: 'Kiosco 3', active: true },
    ];
    expect(kioskNamesToReachTarget(devices, 'a')).toEqual(['Kiosco 3']);
    expect(kioskNamesToReachTarget([], 'a')).toEqual(['Kiosco 1', 'Kiosco 2']);
  });
});

