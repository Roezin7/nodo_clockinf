import { describe, expect, it } from 'vitest';
import { retryIdentityTransport } from './identityTransport';

describe('transporte idempotente de identidad', () => {
  it('reutiliza el mismo UUID capturado por el request cuando se pierde la primera respuesta', async () => {
    const attemptId = 'same-attempt-id';
    const seen: string[] = [];
    const result = await retryIdentityTransport(async () => {
      seen.push(attemptId);
      if (seen.length === 1) throw new Error('response lost');
      return 'duplicate-ack';
    });
    expect(result).toBe('duplicate-ack');
    expect(seen).toEqual([attemptId, attemptId]);
  });
});
