import type { UserRole } from '@clockai/shared';

export function canAccessEmployees(role: UserRole): boolean {
  return role === 'admin' || role === 'foreman';
}

export function canViewBiometricEnrollment(role: UserRole): boolean {
  return role === 'admin';
}

export function biometricEnrollmentState(value: {
  current_biometric_enrollment_id?: string | null;
  biometric_enrollment_status?: 'ready' | 'error' | null;
  biometric_enrollment?: { status: 'ready' | 'error' } | null;
}): 'ready' | 'error' | 'missing' {
  if (value.current_biometric_enrollment_id) return 'ready';
  const status = value.biometric_enrollment?.status ?? value.biometric_enrollment_status;
  return status === 'ready' || status === 'error' ? status : 'missing';
}
