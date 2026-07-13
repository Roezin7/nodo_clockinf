import { describe, expect, it } from 'vitest';
import { generatePin, hourlyRateSchema } from './employees.js';

describe('employee rate input', () => {
  it.each(['0', '0.0000', '25', '25.5', '99999999.9999'])(
    'keeps exact valid decimal %s',
    (value) => {
      expect(hourlyRateSchema.parse(value)).toBe(value);
    }
  );

  it.each([
    25,
    '-1',
    '01.00',
    '1.00000',
    '100000000',
    '1e2',
    'Infinity',
    '',
  ])('rejects non-contract rate %s', (value) => {
    expect(hourlyRateSchema.safeParse(value).success).toBe(false);
  });

  it('generates a printable four-digit fallback PIN', () => {
    for (let index = 0; index < 50; index += 1) {
      expect(generatePin()).toMatch(/^\d{4}$/);
    }
  });
});
