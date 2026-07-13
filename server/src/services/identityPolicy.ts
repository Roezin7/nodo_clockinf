import type { FaceAttemptResult } from './faceProvider.js';

export const MAX_BIOMETRIC_ATTEMPTS = 3;

export const CONSUMING_RESULTS = new Set<FaceAttemptResult>([
  'no_match',
  'no_face',
  'multiple_faces',
  'quality_failed',
  'liveness_failed',
]);

export function consumesBiometricAttempt(result: FaceAttemptResult): boolean {
  return CONSUMING_RESULTS.has(result);
}

export interface IdentityTransition {
  consumes: boolean;
  attemptNumber: number | null;
  status: 'pending' | 'verified' | 'review_required';
  reviewReason: string | null;
}

/** Pure transition function; the caller serializes a session row before use. */
export function transitionIdentity(
  consumedBefore: number,
  result: FaceAttemptResult,
  liveness: { capable: boolean; status: 'not_performed' | 'passed' | 'failed' | 'unknown' } = {
    capable: false,
    status: 'not_performed',
  }
): IdentityTransition {
  if (result === 'match') {
    if (!liveness.capable || liveness.status !== 'passed') {
      return {
        consumes: false,
        attemptNumber: null,
        status: 'review_required',
        reviewReason: !liveness.capable ? 'liveness_not_performed' : 'liveness_not_passed',
      };
    }
    return {
      consumes: false,
      attemptNumber: null,
      status: 'verified',
      reviewReason: null,
    };
  }
  const consumes = consumesBiometricAttempt(result);
  if (consumes) {
    const attemptNumber = consumedBefore + 1;
    if (attemptNumber > MAX_BIOMETRIC_ATTEMPTS) {
      throw new Error('La sesión ya agotó sus tres intentos biométricos');
    }
    return {
      consumes: true,
      attemptNumber,
      status: attemptNumber === MAX_BIOMETRIC_ATTEMPTS ? 'review_required' : 'pending',
      reviewReason: attemptNumber === MAX_BIOMETRIC_ATTEMPTS ? 'attempts_exhausted' : null,
    };
  }
  // Review-only, provider failures, quality problems and missing enrollment do
  // not penalize the worker and must never block the time event.
  return {
    consumes: false,
    attemptNumber: null,
    status: 'review_required',
    reviewReason: result,
  };
}
