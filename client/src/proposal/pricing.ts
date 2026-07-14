import type { CommercialTotals, ProposalPricing } from './types';

export const FIXED_PRICING: ProposalPricing = Object.freeze({
  implementationCents: 350_000,
  platformMonthlyCents: 34_900,
  stationMonthlyCents: 27_900,
  includedPlants: 3,
  includedEmployees: 80,
});

export function calculateProposalTotals(
  stations: number,
  plants: number,
  employees: number,
  pricing: ProposalPricing = FIXED_PRICING,
): CommercialTotals {
  if (![stations, plants, employees].every(Number.isInteger) || stations < 1 || plants < 1 || employees < 1) {
    throw new Error('El alcance requiere enteros positivos');
  }
  const stationsMonthlyCents = stations * pricing.stationMonthlyCents;
  const normalMonthlyCents = pricing.platformMonthlyCents + stationsMonthlyCents;
  const firstMonthCents = pricing.implementationCents + pricing.platformMonthlyCents;
  return {
    implementationCents: pricing.implementationCents,
    platformMonthlyCents: pricing.platformMonthlyCents,
    stationsMonthlyCents,
    firstMonthCents,
    normalMonthlyCents,
    firstYearCents: firstMonthCents + normalMonthlyCents * 11,
    secondYearCents: normalMonthlyCents * 12,
    expansionQuoteRequired: plants > pricing.includedPlants || employees > pricing.includedEmployees,
  };
}

export function usd(cents: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', maximumFractionDigits: 0,
  }).format(cents / 100);
}
