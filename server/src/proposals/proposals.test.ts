import { describe, expect, it } from 'vitest';
import { calculateCommercialTotals } from './pricing.js';
import { getProposal, proposalSlugs, validateProposalConfig } from './registry.js';

describe('proposal configuration', () => {
  it('registers unique valid slugs with the required default scope', () => {
    expect(new Set(proposalSlugs()).size).toBe(proposalSlugs().length);
    const proposal = getProposal('empacadora-jbl');
    expect(proposal).toMatchObject({ initialPlants: 1, initialStations: 2, initialEmployees: 80 });
    expect(validateProposalConfig(proposal!)).toEqual([]);
  });

  it('rejects unsafe configuration values', () => {
    const proposal = getProposal('empacadora-jbl')!;
    expect(validateProposalConfig({ ...proposal, slug: '../secret', logoUrl: 'javascript:alert(1)' })).toEqual(expect.arrayContaining(['slug inválido', 'logoUrl debe ser HTTPS o relativo']));
  });

});

describe('server-side accepted pricing', () => {
  it('recomputes accepted prices and never trusts a client total', () => {
    expect(calculateCommercialTotals({ stations: 3, plants: 1, employees: 80 })).toMatchObject({
      firstMonthCents: 384_900, normalMonthlyCents: 118_600,
      firstYearCents: 1_689_500, secondYearCents: 1_423_200,
    });
  });
});
