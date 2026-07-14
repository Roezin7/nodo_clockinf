export interface ProposalConfig {
  slug: string;
  version: string;
  clientName: string;
  commercialName: string;
  initialPlants: number;
  initialEmployees: number;
  initialStations: number;
  contactName: string;
  proposalDate: string;
  validUntil: string;
  logoUrl?: string;
  openingMessage: string;
  commercialNotes: string[];
  taxesIncluded: boolean;
  provider: { name: string; email: string; phone: string; website: string };
}

export interface ProposalPricing {
  implementationCents: number;
  platformMonthlyCents: number;
  stationMonthlyCents: number;
  includedPlants: number;
  includedEmployees: number;
}

export interface ProposalPayload {
  proposal: ProposalConfig;
  pricing: ProposalPricing;
}

export interface CommercialTotals {
  implementationCents: number;
  platformMonthlyCents: number;
  stationsMonthlyCents: number;
  firstMonthCents: number;
  normalMonthlyCents: number;
  firstYearCents: number;
  secondYearCents: number;
  expansionQuoteRequired: boolean;
}
