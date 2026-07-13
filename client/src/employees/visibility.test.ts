import { describe, expect, it } from 'vitest';
import {
  biometricEnrollmentState,
  canAccessEmployees,
  canViewBiometricEnrollment,
} from './visibility';

describe('visibilidad de enrollment facial', () => {
  it('lo reserva al admin y bloquea accountant de la página de empleados', () => {
    expect(canViewBiometricEnrollment('admin')).toBe(true);
    expect(canViewBiometricEnrollment('foreman')).toBe(false);
    expect(canViewBiometricEnrollment('accountant')).toBe(false);
    expect(canAccessEmployees('foreman')).toBe(true);
    expect(canAccessEmployees('accountant')).toBe(false);
  });

  it('reconoce el puntero versionado que devuelve el backend después de recargar', () => {
    expect(
      biometricEnrollmentState({
        current_biometric_enrollment_id: '11111111-1111-4111-8111-111111111111',
      })
    ).toBe('ready');
    expect(biometricEnrollmentState({ biometric_enrollment_status: 'error' })).toBe('error');
    expect(biometricEnrollmentState({ current_biometric_enrollment_id: null })).toBe('missing');
  });
});
