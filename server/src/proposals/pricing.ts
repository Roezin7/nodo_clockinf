import type { CommercialTotals } from './types.js';

export const PROPOSAL_PRICING = Object.freeze({
  implementationCents: 350_000,
  platformMonthlyCents: 34_900,
  stationMonthlyCents: 27_900,
  includedPlants: 3,
  includedEmployees: 80,
});

export function calculateCommercialTotals(input: {
  stations: number;
  plants: number;
  employees: number;
}): CommercialTotals {
  if (![input.stations, input.plants, input.employees].every(Number.isInteger)
    || input.stations < 1 || input.plants < 1 || input.employees < 1) {
    throw new Error('El alcance comercial requiere enteros positivos');
  }
  const stationsMonthlyCents = input.stations * PROPOSAL_PRICING.stationMonthlyCents;
  const normalMonthlyCents = PROPOSAL_PRICING.platformMonthlyCents + stationsMonthlyCents;
  const firstMonthCents = PROPOSAL_PRICING.implementationCents + PROPOSAL_PRICING.platformMonthlyCents;
  return {
    implementationCents: PROPOSAL_PRICING.implementationCents,
    platformMonthlyCents: PROPOSAL_PRICING.platformMonthlyCents,
    stationsMonthlyCents,
    firstMonthCents,
    normalMonthlyCents,
    firstYearCents: firstMonthCents + normalMonthlyCents * 11,
    secondYearCents: normalMonthlyCents * 12,
    expansionQuoteRequired: input.plants > PROPOSAL_PRICING.includedPlants
      || input.employees > PROPOSAL_PRICING.includedEmployees,
  };
}
