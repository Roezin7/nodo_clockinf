import { describe, expect, it } from 'vitest';
import { calculateProposalTotals } from './pricing';

describe('proposal commercial calculations', () => {
  it('calculates the default two-station proposal from formulas', () => {
    expect(calculateProposalTotals(2, 1, 80)).toEqual({
      implementationCents: 350_000,
      platformMonthlyCents: 34_900,
      stationsMonthlyCents: 55_800,
      firstMonthCents: 384_900,
      normalMonthlyCents: 90_700,
      firstYearCents: 1_382_600,
      secondYearCents: 1_088_400,
      expansionQuoteRequired: false,
    });
  });

  it('matches the required three-station example', () => {
    const totals = calculateProposalTotals(3, 3, 80);
    expect(totals.firstMonthCents).toBe(384_900);
    expect(totals.normalMonthlyCents).toBe(118_600);
    expect(totals.firstYearCents).toBe(1_689_500);
    expect(totals.secondYearCents).toBe(1_423_200);
  });

  it('flags expansion without inventing a price', () => {
    const base = calculateProposalTotals(2, 1, 80);
    const expanded = calculateProposalTotals(2, 4, 81);
    expect(expanded.expansionQuoteRequired).toBe(true);
    expect(expanded.firstYearCents).toBe(base.firstYearCents);
  });
});
