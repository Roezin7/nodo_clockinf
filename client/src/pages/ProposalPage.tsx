import { useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { useParams } from 'react-router-dom';
import type { ProposalPayload } from '../proposal/types';
import { ProposalExperience } from '../proposal/ProposalExperience';
import '../proposal/proposal.css';

export default function ProposalPage() {
  const { clientSlug = '' } = useParams();
  const [payload, setPayload] = useState<ProposalPayload | null>(null);
  const [status, setStatus] = useState<'loading' | 'missing' | 'error'>('loading');

  useEffect(() => {
    let active = true;
    void fetch(`/api/proposals/${encodeURIComponent(clientSlug)}`, { cache: 'no-store' })
      .then(async (response) => {
        if (response.status === 404) { if (active) setStatus('missing'); return; }
        if (!response.ok) throw new Error('No fue posible abrir la propuesta.');
        if (active) setPayload(await response.json() as ProposalPayload);
      })
      .catch(() => { if (active) setStatus('error'); });
    return () => { active = false; };
  }, [clientSlug]);

  if (payload) return <ProposalExperience payload={payload} />;
  return <main className="proposal-loading" aria-live="polite">
    <section>
      <div className="proposal-mark">LS</div>
      <ShieldCheck size={30} />
      <h1>{status === 'loading' ? 'Abriendo propuesta' : status === 'missing' ? 'Propuesta no disponible' : 'No pudimos abrir la propuesta'}</h1>
      <p>{status === 'loading' ? 'Leader Solutions · NODO Clock-In' : 'Revisa el enlace o contacta a Leader Solutions.'}</p>
    </section>
  </main>;
}
