import { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, Check, ChevronLeft, Clock3, RotateCcw, ShieldAlert, Wifi } from 'lucide-react';
import type { PunchType } from '@clockai/shared';
import { failedDemoIdentityOutcome } from '../demo/kioskDemo';

const DEMO_TOKEN_KEY = 'clockai.demo-kiosk.token';
const ACTIONS: Array<{ type: PunchType; label: string; tone: string }> = [
  { type: 'shift_in', label: 'Entrada', tone: 'border-success/60 bg-success/15' },
  { type: 'meal_out', label: 'Salida a lunch', tone: 'border-warning/60 bg-warning/15' },
  { type: 'meal_in', label: 'Regreso de lunch', tone: 'border-info/60 bg-info/15' },
  { type: 'shift_out', label: 'Salida', tone: 'border-accent/60 bg-accent/15' },
];

type Step = 'number' | 'action' | 'identity' | 'complete';
type Result = 'verified' | 'review';
interface DemoPunch { id: string; employee_number: number; employee_name: string; punch_type: PunchType; punched_at: string }

function readDemoToken(): string | null {
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const fromLink = fragment.get('demo');
  if (fromLink) {
    sessionStorage.setItem(DEMO_TOKEN_KEY, fromLink);
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    return fromLink;
  }
  return sessionStorage.getItem(DEMO_TOKEN_KEY);
}

function displayTime(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat('es-US', { hour: 'numeric', minute: '2-digit', timeZone: timezone }).format(new Date(iso));
}

export default function DemoKioskPage() {
  const [token] = useState(readDemoToken);
  const [step, setStep] = useState<Step>('number');
  const [employeeNumber, setEmployeeNumber] = useState('');
  const [action, setAction] = useState<(typeof ACTIONS)[number] | null>(null);
  const [failedAttempts, setFailedAttempts] = useState(0);
  const [result, setResult] = useState<Result>('verified');
  const [resultPunch, setResultPunch] = useState<DemoPunch | null>(null);
  const [recent, setRecent] = useState<DemoPunch[]>([]);
  const [organizationName, setOrganizationName] = useState('');
  const [timezone, setTimezone] = useState('America/Los_Angeles');
  const [cameraMessage, setCameraMessage] = useState('');
  const [cameraActive, setCameraActive] = useState(false);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState('');
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  function stopCamera(): void {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }

  const loadRecent = useCallback(async () => {
    if (!token) return;
    try {
      const response = await fetch('/api/demo-kiosk/recent', { headers: { 'x-demo-kiosk-token': token }, cache: 'no-store' });
      const data = await response.json() as { punches?: DemoPunch[]; organization_name?: string; timezone?: string; error?: string };
      if (!response.ok) throw new Error(data.error ?? 'No fue posible cargar las pruebas');
      setRecent(data.punches ?? []);
      setOrganizationName(data.organization_name ?? 'Operación');
      setTimezone(data.timezone ?? 'America/Los_Angeles');
      setServerError('');
    } catch (error) {
      setServerError(error instanceof Error ? error.message : 'No fue posible conectar el kiosco de pruebas');
    }
  }, [token]);

  useEffect(() => { void loadRecent(); }, [loadRecent]);
  useEffect(() => () => stopCamera(), []);
  useEffect(() => () => { if (photoUrl) URL.revokeObjectURL(photoUrl); }, [photoUrl]);

  async function startCamera(): Promise<void> {
    setCameraMessage('');
    setCameraActive(false);
    try {
      stopCamera();
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 720 }, height: { ideal: 540 } }, audio: false });
      streamRef.current = stream;
      if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play(); }
      setCameraActive(true);
    } catch {
      setCameraMessage('La cámara no está disponible. La prueba continúa sin foto.');
    }
  }

  function captureLocalPhoto(): void {
    const video = videoRef.current;
    if (!video?.videoWidth || !video.videoHeight) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d')?.drawImage(video, 0, 0);
    canvas.toBlob((blob) => {
      if (!blob) return;
      setPhotoUrl((previous) => {
        if (previous) URL.revokeObjectURL(previous);
        return URL.createObjectURL(blob);
      });
    }, 'image/jpeg', 0.85);
  }

  async function chooseAction(nextAction: (typeof ACTIONS)[number]): Promise<void> {
    setAction(nextAction);
    setFailedAttempts(0);
    setServerError('');
    setStep('identity');
    await startCamera();
  }

  async function finish(nextResult: Result): Promise<void> {
    if (!token || !action || saving) return;
    captureLocalPhoto();
    stopCamera();
    setSaving(true);
    setServerError('');
    try {
      const response = await fetch('/api/demo-kiosk/punches', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-demo-kiosk-token': token },
        body: JSON.stringify({ employee_number: Number(employeeNumber), punch_type: action.type }),
      });
      const data = await response.json() as { punch?: DemoPunch; timezone?: string; error?: string };
      if (!response.ok || !data.punch) throw new Error(data.error ?? 'No fue posible guardar la checada de prueba');
      setResult(nextResult);
      setResultPunch(data.punch);
      setTimezone(data.timezone ?? timezone);
      setStep('complete');
      await loadRecent();
    } catch (error) {
      setServerError(error instanceof Error ? error.message : 'No fue posible guardar la checada de prueba');
    } finally {
      setSaving(false);
    }
  }

  function simulateFailure(): void {
    const next = failedAttempts + 1;
    captureLocalPhoto();
    setFailedAttempts(next);
    if (failedDemoIdentityOutcome(next) === 'review') void finish('review');
  }

  function reset(): void {
    stopCamera();
    setPhotoUrl((previous) => { if (previous) URL.revokeObjectURL(previous); return null; });
    setEmployeeNumber(''); setAction(null); setFailedAttempts(0); setCameraMessage(''); setServerError(''); setResultPunch(null); setStep('number');
  }

  if (!token) {
    return <DemoUnavailable message="Este kiosco de pruebas requiere el enlace secreto del administrador. Abre el enlace completo que termina en #demo=…" />;
  }

  return (
    <div className="flex min-h-screen select-none flex-col bg-kiosk-bg text-kiosk-ink">
      <header className="flex min-h-24 items-center justify-between gap-4 border-b border-kiosk-line px-5 py-3">
        <div><p className="font-display text-18 font-bold text-kiosk-ink-dim">NODO Clock-In</p><p className="mt-1 text-14 text-kiosk-ink-dim">Kiosco de pruebas · {organizationName || 'conectando…'}</p></div>
        <span className="rounded-full border border-warning/60 bg-warning/15 px-3 py-1.5 text-13 font-bold text-kiosk-ink">PRUEBAS · no afecta nómina</span>
      </header>

      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-8 p-6 lg:flex-row lg:items-center">
        <section className="flex min-w-0 flex-1 flex-col items-center justify-center text-center">
          {serverError && <div className="mb-5 max-w-lg rounded-control border border-danger/50 bg-danger/10 px-4 py-3 text-14 font-semibold text-kiosk-ink">{serverError}</div>}
          {step === 'number' && <>
            <Clock3 size={48} className="mb-6 text-accent" strokeWidth={1.5} /><h1 className="text-28 font-semibold text-kiosk-ink-dim">Número de empleado</h1>
            <p className="mt-2 text-16 text-kiosk-ink-dim">Usa un número real activo. Se guardará solamente como checada de prueba.</p>
            <div className="tnum mt-6 flex h-20 min-w-72 items-center justify-center rounded-card border border-kiosk-line bg-kiosk-raised px-8 font-display text-56 font-bold tracking-widest">{employeeNumber || <span className="text-kiosk-line">···</span>}</div>
            <div className="mt-6 grid grid-cols-3 gap-3">{[1, 2, 3, 4, 5, 6, 7, 8, 9].map((number) => <button key={number} onClick={() => setEmployeeNumber((value) => value.length < 8 ? `${value}${number}` : value)} className="h-16 w-20 rounded-card border border-kiosk-line bg-kiosk-raised text-24 font-bold active:bg-kiosk-line">{number}</button>)}<button onClick={() => setEmployeeNumber((value) => value.slice(0, -1))} className="h-16 rounded-card border border-kiosk-line bg-kiosk-raised text-14 font-bold">Borrar</button><button onClick={() => setEmployeeNumber((value) => value.length < 8 ? `${value}0` : value)} className="h-16 rounded-card border border-kiosk-line bg-kiosk-raised text-24 font-bold">0</button><button disabled={!employeeNumber} onClick={() => setStep('action')} className="h-16 rounded-card bg-accent text-14 font-bold text-white disabled:opacity-40">Continuar</button></div>
          </>}
          {step === 'action' && <>
            <h1 className="text-28 font-semibold text-kiosk-ink-dim">Empleado #{employeeNumber}</h1><p className="mt-2 text-16 text-kiosk-ink-dim">Selecciona una checada de prueba.</p>
            <div className="mt-8 grid w-full grid-cols-1 gap-4 sm:grid-cols-2">{ACTIONS.map((item) => <button key={item.type} onClick={() => void chooseAction(item)} className={`min-h-28 rounded-card border p-5 text-20 font-bold text-kiosk-ink transition-transform active:scale-[0.98] ${item.tone}`}>{item.label}</button>)}</div>
            <button onClick={() => setStep('number')} className="mt-8 inline-flex items-center gap-2 text-16 font-semibold text-kiosk-ink-dim"><ChevronLeft size={18} /> Regresar</button>
          </>}
          {step === 'identity' && action && <>
            <Camera size={48} className="mb-5 text-accent" strokeWidth={1.5} /><h1 className="text-28 font-semibold text-kiosk-ink-dim">Demostración facial</h1>
            <p className="mt-2 text-16 text-kiosk-ink-dim">La cámara es local para la demo: esta foto no se sube ni se guarda en el servidor.</p>
            <div className="relative mt-6 aspect-[4/3] w-full max-w-md overflow-hidden rounded-card border border-kiosk-line bg-kiosk-raised"><video ref={videoRef} muted playsInline className="h-full w-full object-cover" />{!cameraActive && <div className="absolute inset-0 flex items-center justify-center px-6 text-15 text-kiosk-ink-dim">{cameraMessage || 'Iniciando cámara…'}</div>}</div>
            {failedAttempts > 0 && <p className="mt-4 text-15 font-semibold text-warning">Intento no coincidente simulado: {failedAttempts} de 3</p>}
            <div className="mt-6 flex flex-wrap justify-center gap-3"><button disabled={saving} onClick={() => void finish('verified')} className="inline-flex min-h-14 items-center gap-2 rounded-control bg-success px-5 text-15 font-bold text-white disabled:opacity-50"><Check size={20} /> {saving ? 'Guardando…' : 'Registrar prueba'}</button><button disabled={saving} onClick={simulateFailure} className="inline-flex min-h-14 items-center gap-2 rounded-control border border-warning/70 bg-warning/15 px-5 text-15 font-bold text-kiosk-ink disabled:opacity-50"><ShieldAlert size={20} /> Simular fallo facial</button></div>
            <button onClick={reset} className="mt-7 text-15 font-semibold text-kiosk-ink-dim">Cancelar prueba</button>
          </>}
          {step === 'complete' && action && resultPunch && <>
            <div className={`flex h-24 w-24 items-center justify-center rounded-full ${result === 'verified' ? 'bg-success' : 'bg-warning'}`}>{result === 'verified' ? <Check size={50} className="text-white" /> : <ShieldAlert size={50} className="text-kiosk-ink" />}</div>
            <h1 className="mt-6 text-28 font-bold text-kiosk-ink-dim">{result === 'verified' ? 'Checada de prueba registrada' : 'Prueba registrada con alerta'}</h1>
            <p className="mt-3 text-18 font-semibold text-kiosk-ink-dim">{resultPunch.employee_name} · {action.label} · {displayTime(resultPunch.punched_at, timezone)}</p>
            <p className="mt-3 max-w-lg text-16 text-kiosk-ink-dim">{result === 'verified' ? 'Esta entrada aparece en la lista de pruebas, nunca en asistencia, horas, dashboard ni nómina.' : 'Tras tres fallos simulados, la prueba se etiqueta como alerta. No crea revisión ni evidencia biométrica productiva.'}</p>
            {photoUrl && <img src={photoUrl} alt="Foto local de demostración" className="mt-5 h-24 w-32 rounded-card border border-kiosk-line object-cover" />}
            <button onClick={reset} className="mt-7 inline-flex min-h-14 items-center gap-2 rounded-control bg-accent px-5 text-16 font-bold text-white"><RotateCcw size={19} /> Hacer otra prueba</button>
          </>}
        </section>
        <aside className="w-full rounded-card border border-kiosk-line bg-kiosk-raised p-5 text-left lg:w-80"><h2 className="font-display text-18 font-bold text-kiosk-ink">Últimas checadas de prueba</h2><p className="mt-1 text-13 text-kiosk-ink-dim">Visibles sólo desde el enlace secreto.</p><div className="mt-4 max-h-[420px] space-y-3 overflow-auto">{recent.length === 0 ? <p className="text-14 text-kiosk-ink-dim">Aún no hay pruebas registradas.</p> : recent.map((punch) => <div key={punch.id} className="rounded-control border border-kiosk-line p-3"><p className="text-14 font-bold text-kiosk-ink">{punch.employee_name}</p><p className="mt-1 text-13 text-kiosk-ink-dim">#{punch.employee_number} · {ACTIONS.find((item) => item.type === punch.punch_type)?.label ?? punch.punch_type}</p><p className="mt-1 text-12 text-kiosk-ink-dim">{displayTime(punch.punched_at, timezone)}</p></div>)}</div><button onClick={() => void loadRecent()} className="mt-4 text-13 font-bold text-accent">Actualizar lista</button></aside>
      </main>
      <footer className="flex items-center justify-center gap-2 border-t border-kiosk-line px-5 py-4 text-13 text-kiosk-ink-dim"><Wifi size={15} /> Las checadas de prueba viven en una tabla aislada y no afectan horas pagables.</footer>
    </div>
  );
}

function DemoUnavailable({ message }: { message: string }) {
  return <div className="flex min-h-screen items-center justify-center bg-kiosk-bg p-6 text-center text-kiosk-ink"><div className="max-w-lg rounded-card border border-kiosk-line bg-kiosk-raised p-8"><ShieldAlert size={44} className="mx-auto text-warning" /><h1 className="mt-5 text-24 font-bold">Kiosco de pruebas protegido</h1><p className="mt-3 text-16 text-kiosk-ink-dim">{message}</p></div></div>;
}
