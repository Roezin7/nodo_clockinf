import { describe, expect, it } from 'vitest';
import { isConfirmedPinLock } from './ingestPolicy';

describe('política de 429 del kiosco', () => {
  it('sólo descarta el provisional ante pin_locked confirmado', () => {
    expect(isConfirmedPinLock(429, 'pin_locked')).toBe(true);
    expect(isConfirmedPinLock(429, undefined)).toBe(false);
    expect(isConfirmedPinLock(429, 'rate_limit')).toBe(false);
  });
});

