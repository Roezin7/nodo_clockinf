import { describe, expect, it } from 'vitest';
import {
  MAX_BIOMETRIC_ATTEMPTS,
  consumesBiometricAttempt,
  transitionIdentity,
} from './identityPolicy.js';

describe('California kiosk identity policy', () => {
  it('counts exactly three biometric failures before requiring human review', () => {
    const first = transitionIdentity(0, 'no_match');
    const second = transitionIdentity(1, 'no_face');
    const third = transitionIdentity(2, 'quality_failed');

    expect(MAX_BIOMETRIC_ATTEMPTS).toBe(3);
    expect(first).toMatchObject({ consumes: true, attemptNumber: 1, status: 'pending' });
    expect(second).toMatchObject({ consumes: true, attemptNumber: 2, status: 'pending' });
    expect(third).toEqual({
      consumes: true,
      attemptNumber: 3,
      status: 'review_required',
      reviewReason: 'attempts_exhausted',
    });
  });

  it.each(['no_match', 'no_face', 'multiple_faces', 'quality_failed', 'liveness_failed'] as const)(
    'counts %s as an employee attempt',
    (result) => expect(consumesBiometricAttempt(result)).toBe(true)
  );

  it.each(['provider_error', 'provider_unavailable', 'no_enrollment', 'review_only'] as const)(
    'does not penalize the employee for %s and routes directly to review',
    (result) => {
      expect(transitionIdentity(0, result)).toEqual({
        consumes: false,
        attemptNumber: null,
        status: 'review_required',
        reviewReason: result,
      });
    }
  );

  it('never verifies a face match without a liveness-capable provider and a passed result', () => {
    expect(
      transitionIdentity(0, 'match', { capable: false, status: 'not_performed' })
    ).toMatchObject({ status: 'review_required', reviewReason: 'liveness_not_performed' });
    expect(
      transitionIdentity(0, 'match', { capable: true, status: 'unknown' })
    ).toMatchObject({ status: 'review_required', reviewReason: 'liveness_not_passed' });
    expect(
      transitionIdentity(0, 'match', { capable: true, status: 'passed' })
    ).toEqual({
      consumes: false,
      attemptNumber: null,
      status: 'verified',
      reviewReason: null,
    });
  });

  it('refuses a fourth counted attempt even if a caller is buggy', () => {
    expect(() => transitionIdentity(3, 'no_match')).toThrow(/tres intentos/i);
  });
});
