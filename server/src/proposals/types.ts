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
  nod3: {
    name: string;
    email: string;
    phone: string;
    website: string;
  };
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
