import { describe, expect, it } from 'vitest';
import { kioskMessages, kioskText, normalizeKioskLanguage } from './i18n';

describe('idioma persistible del kiosco', () => {
  it('mantiene paridad de claves y traduce acciones y estados críticos', () => {
    expect(Object.keys(kioskMessages.en).sort()).toEqual(Object.keys(kioskMessages.es).sort());
    expect(kioskText('es', 'meal_out')).toBe('Salida a comer');
    expect(kioskText('en', 'meal_out')).toBe('Start meal');
    expect(kioskText('en', 'identityReview')).toContain('pending review');
    expect(normalizeKioskLanguage('en')).toBe('en');
    expect(normalizeKioskLanguage('fr')).toBe('es');
  });
});
