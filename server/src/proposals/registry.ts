import type { ProposalConfig } from './types.js';

const proposals = [
  {
    slug: 'empacadora-jbl',
    version: '2026.07.1',
    clientName: 'Jessy Sandoval',
    commercialName: 'Empacadora JBL',
    initialPlants: 1,
    initialEmployees: 80,
    initialStations: 2,
    contactName: 'Dirección de operaciones',
    proposalDate: '2026-07-14',
    validUntil: '2026-08-13',
    openingMessage: 'Una operación más clara comienza con registros confiables desde cada estación.',
    commercialNotes: [
      'Alcance base preparado para crecer hasta tres plantas y 80 empleados.',
      'La configuración final se valida durante descubrimiento antes de iniciar el piloto.',
    ],
    taxesIncluded: false,
    nod3: {
      name: 'Leader Solutions',
      email: 'leader@leadersolutions.com',
      phone: 'Contacto en la propuesta final',
      website: 'https://nod3.studio',
    },
  },
] as const satisfies readonly ProposalConfig[];

export function validateProposalConfig(proposal: ProposalConfig): string[] {
  const errors: string[] = [];
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(proposal.slug)) errors.push('slug inválido');
  if (!/^\d{4}\.\d{2}\.\d+$/.test(proposal.version)) errors.push('versión inválida');
  if (!proposal.clientName.trim() || !proposal.commercialName.trim()) errors.push('cliente incompleto');
  if (![proposal.initialPlants, proposal.initialEmployees, proposal.initialStations].every((value) => Number.isInteger(value) && value > 0)) {
    errors.push('alcance inicial inválido');
  }
  if (Number.isNaN(Date.parse(proposal.proposalDate)) || Number.isNaN(Date.parse(proposal.validUntil))) {
    errors.push('fechas inválidas');
  } else if (proposal.validUntil < proposal.proposalDate) {
    errors.push('vigencia anterior a la propuesta');
  }
  if (!proposal.nod3.email.includes('@') || !proposal.nod3.name.trim()) errors.push('contacto Nod3 incompleto');
  if (proposal.logoUrl && !/^(https:\/\/|\/)/.test(proposal.logoUrl)) errors.push('logoUrl debe ser HTTPS o relativo');
  return errors;
}

for (const proposal of proposals) {
  const errors = validateProposalConfig(proposal);
  if (errors.length) throw new Error(`Propuesta ${proposal.slug} inválida: ${errors.join(', ')}`);
}

export function getProposal(slug: string): ProposalConfig | null {
  return proposals.find((proposal) => proposal.slug === slug) ?? null;
}

export function proposalSlugs(): string[] {
  return proposals.map((proposal) => proposal.slug);
}
