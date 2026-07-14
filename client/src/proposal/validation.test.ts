import { describe, expect, it } from 'vitest';
import type { AcceptanceInput } from './types';
import { validateAcceptance } from './validation';

const valid: AcceptanceInput = {
  legalCompanyName: 'Empaque del Valle LLC', representativeName: 'María López',
  email: 'maria@example.com', phone: '+1 209 555 0181', stations: 2, plants: 1,
  employees: 80, pricingConfirmed: true, termsAccepted: true,
  signature: 'María López', requestKickoff: true,
};

describe('proposal acceptance validation', () => {
  it('accepts a complete matching electronic signature', () => {
    expect(validateAcceptance(valid)).toEqual({});
  });

  it('requires contact, confirmations and an exact representative signature', () => {
    const errors = validateAcceptance({ ...valid, email: 'invalid', phone: '12', pricingConfirmed: false, termsAccepted: false, signature: 'Otra Persona' });
    expect(errors).toMatchObject({ email: expect.any(String), phone: expect.any(String), pricingConfirmed: expect.any(String), termsAccepted: expect.any(String), signature: expect.any(String) });
  });
});
