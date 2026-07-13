import { describe, expect, it } from 'vitest';
import {
  INITIAL_IDENTITY_FLOW,
  applyIdentityResult,
  attemptsRemaining,
  serverIdentityDisposition,
} from './identityFlow';

describe('máquina de identidad del kiosco', () => {
  it('acepta match y manda a revisión exactamente después de tres fallas biométricas', () => {
    const first = applyIdentityResult(INITIAL_IDENTITY_FLOW, 'no_match');
    expect(first).toMatchObject({ countedAttempts: 1, status: 'retry' });
    expect(attemptsRemaining(first)).toBe(2);

    const second = applyIdentityResult(first, 'no_face');
    expect(second).toMatchObject({ countedAttempts: 2, status: 'retry' });
    expect(attemptsRemaining(second)).toBe(1);

    const third = applyIdentityResult(second, 'liveness_failed');
    expect(third).toMatchObject({ countedAttempts: 3, status: 'review' });
    expect(attemptsRemaining(third)).toBe(0);
    expect(applyIdentityResult(third, 'match')).toBe(third);

    expect(applyIdentityResult(INITIAL_IDENTITY_FLOW, 'match')).toMatchObject({
      countedAttempts: 0,
      status: 'verified',
    });
  });

  it.each(['provider_error', 'timeout', 'offline', 'not_enrolled', 'camera_unavailable'] as const)(
    '%s no consume intentos y nunca bloquea la checada',
    (result) => {
      expect(applyIdentityResult(INITIAL_IDENTITY_FLOW, result)).toMatchObject({
        countedAttempts: 0,
        status: 'review',
        reason: result,
      });
    }
  );

  it('no considera verificado un match de AWS cuando el servidor exige revisión por falta de liveness', () => {
    const localMatch = applyIdentityResult(INITIAL_IDENTITY_FLOW, 'match');
    expect(localMatch.status).toBe('verified');
    expect(serverIdentityDisposition('review_required', 'punch', localMatch)).toBe('review');
    expect(serverIdentityDisposition('verified', 'punch', localMatch)).toBe('verified');
  });
});
