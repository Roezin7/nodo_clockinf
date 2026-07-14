import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ProposalConfig } from './types';
import { PrintableProposal } from './print';

const proposal: ProposalConfig = {
  slug: 'cliente-prueba', version: '2026.07.1', clientName: 'Cliente Prueba LLC',
  commercialName: 'Cliente Prueba', initialPlants: 1, initialEmployees: 80,
  initialStations: 2, contactName: 'Operaciones', proposalDate: '2026-07-14',
  validUntil: '2026-08-13', openingMessage: 'Mensaje', commercialNotes: [],
  taxesIncluded: false, nod3: { name: 'Nod3 Studio', email: 'hola@example.com', phone: '209', website: 'https://example.com' },
};

describe('printable proposal', () => {
  it('renders client, scope, formula-derived totals, exclusions and validity', () => {
    const html = renderToStaticMarkup(<PrintableProposal proposal={proposal} />);
    expect(html).toContain('Cliente Prueba');
    expect(html).toContain('$13,826');
    expect(html).toContain('Exclusiones');
    expect(html).toContain('2026-08-13');
    expect(html).toContain('proposal-print-only');
  });
});
