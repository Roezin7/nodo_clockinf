import { FormEvent, useEffect, useState } from 'react';
import { LockKeyhole, ShieldCheck } from 'lucide-react';
import { useParams } from 'react-router-dom';
import type { ProposalPayload } from '../proposal/types';
import { ProposalExperience } from '../proposal/ProposalExperience';
import '../proposal/proposal.css';

export default function ProposalPage() {
  const { clientSlug = '' } = useParams();
  const [payload, setPayload] = useState<ProposalPayload | null>(null);
  const [status, setStatus] = useState<'loading' | 'locked' | 'missing' | 'error'>('loading');
  const [code, setCode] = useState('');
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function load(): Promise<void> {
    setStatus('loading');
    try {
      const response = await fetch(`/api/proposals/${encodeURIComponent(clientSlug)}`, { credentials: 'same-origin', cache: 'no-store' });
      if (response.status === 403) { setStatus('locked'); return; }
      if (response.status === 404) { setStatus('missing'); return; }
      if (!response.ok) throw new Error('No fue posible abrir la propuesta.');
      setPayload(await response.json() as ProposalPayload);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'No fue posible abrir la propuesta.');
      setStatus('error');
    }
  }

  useEffect(() => { void load(); }, [clientSlug]);

  async function unlock(event: FormEvent): Promise<void> {
    event.preventDefault();
    setSubmitting(true); setMessage('');
    try {
      const response = await fetch(`/api/proposals/${encodeURIComponent(clientSlug)}/access`, {
        method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }),
      });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? 'Código de acceso incorrecto.');
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'No fue posible validar el acceso.');
    } finally { setSubmitting(false); }
  }

  if (payload) return <ProposalExperience payload={payload} />;
  return (
    <main className="proposal-access">
      <section className="proposal-access-card" aria-live="polite">
        <div className="proposal-mark">N<span>3</span></div>
        {status === 'loading' ? <><ShieldCheck size={30} /><h1>Validando propuesta</h1><p>Conexión privada con Nod3 Studio.</p></> : null}
        {status === 'locked' ? <>
          <LockKeyhole size={30} />
          <p className="proposal-eyebrow">NODO CLOCK-IN</p>
          <h1>Propuesta privada</h1>
          <p>Ingresa el código compartido por Nod3 Studio. La sesión expira automáticamente.</p>
          <form onSubmit={unlock}>
            <label htmlFor="proposal-code">Código de acceso</label>
            <input id="proposal-code" type="password" autoComplete="one-time-code" minLength={6} maxLength={128} required value={code} onChange={(event) => setCode(event.target.value)} />
            {message && <p className="proposal-form-error" role="alert">{message}</p>}
            <button type="submit" disabled={submitting}>{submitting ? 'Validando…' : 'Abrir propuesta'}</button>
          </form>
          <small>No compartas este código. La página no contiene información productiva ni datos de empleados reales.</small>
        </> : null}
        {status === 'missing' ? <><h1>Propuesta no disponible</h1><p>Revisa el enlace o solicita uno vigente a Nod3 Studio.</p></> : null}
        {status === 'error' ? <><h1>No pudimos abrir la propuesta</h1><p>{message}</p><button type="button" onClick={() => void load()}>Intentar de nuevo</button></> : null}
      </section>
    </main>
  );
}
