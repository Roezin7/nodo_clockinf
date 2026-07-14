import type { ProposalConfig } from './types';
import { calculateProposalTotals, usd } from './pricing';

export function PrintableProposal({ proposal }: { proposal: ProposalConfig }) {
  const totals = calculateProposalTotals(proposal.initialStations, proposal.initialPlants, proposal.initialEmployees);
  return (
    <article className="proposal-print-only" aria-label="Resumen imprimible de propuesta">
      <header className="print-cover">
        <p>LEADER SOLUTIONS · NODO CLOCK-IN</p>
        <h1>Propuesta para {proposal.commercialName}</h1>
        <p>De la checada de las 5:00 AM al cierre verificable del domingo.</p>
        <dl><dt>Fecha</dt><dd>{proposal.proposalDate}</dd><dt>Vigencia</dt><dd>{proposal.validUntil}</dd><dt>Versión</dt><dd>{proposal.version}</dd></dl>
      </header>
      <section><h2>Resumen ejecutivo</h2><p>NODO Clock-In convierte la captura, corrección y entrega semanal de horas en un flujo directo, auditable y preparado para múltiples plantas.</p></section>
      <section><h2>Alcance inicial</h2><p>{proposal.initialPlants} planta(s), {proposal.initialStations} estación(es) y aproximadamente {proposal.initialEmployees} empleados.</p><p>Incluye configuración, onboarding, turnos, tasas, permisos, estaciones, capacitación, piloto y estabilización.</p></section>
      <section><h2>Capacidades principales</h2><p>Kiosco bilingüe, cola offline, correcciones auditables, incidencias, salud de estaciones, cierre versionado y exportes para la contadora.</p></section>
      <section><h2>Implementación</h2><ol><li>Descubrimiento y configuración</li><li>Estaciones y capacitación</li><li>Piloto y primer cierre</li><li>Producción y estabilización</li></ol></section>
      <section><h2>Inversión</h2><table><tbody><tr><th>Implementación inicial</th><td>{usd(totals.implementationCents)}</td></tr><tr><th>Primer mes</th><td>{usd(totals.firstMonthCents)}</td></tr><tr><th>Desde el segundo mes</th><td>{usd(totals.normalMonthlyCents)}</td></tr><tr><th>Primer año estimado</th><td>{usd(totals.firstYearCents)}</td></tr><tr><th>A partir del segundo año</th><td>{usd(totals.secondYearCents)} / año</td></tr></tbody></table><p>USD, {proposal.taxesIncluded ? 'impuestos incluidos según esta configuración.' : 'antes de impuestos.'} Primer mes de estaciones incluido durante el piloto.</p></section>
      <section><h2>Próximos pasos</h2><p>Confirmar alcance y programar descubrimiento y piloto.</p></section>
      <footer><p>{proposal.provider.name} · {proposal.provider.email} · {proposal.provider.phone} · {proposal.provider.website}</p><p>Propuesta válida hasta {proposal.validUntil}.</p></footer>
    </article>
  );
}
