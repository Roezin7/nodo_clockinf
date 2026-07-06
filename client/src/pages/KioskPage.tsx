import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Delete, X } from 'lucide-react';
import type { PunchIngestResponse, PunchType } from '@clockai/shared';

/**
 * Kiosco para tablet en modo retrato — modo oscuro para reducir
 * deslumbramiento a las 6 AM. Flujo: número de empleado → PIN → foto
 * automática → confirmación 3s → reset. La checada se confirma sin esperar
 * la foto; la foto se sube en background con cola de reintentos.
 *
 * Token de dispositivo: /kiosk?token=XYZ lo guarda en localStorage.
 */

const TOKEN_KEY = 'clockai.kiosk.token';
const QUEUE_KEY = 'clockai.kiosk.photoQueue';
const MAX_QUEUE = 30;

const TYPE_LABELS: Record<PunchType, string> = {
  shift_in: 'ENTRADA',
  shift_out: 'SALIDA',
  meal_out: 'SALIDA A COMER',
  meal_in: 'REGRESO DE COMER',
};

interface QueueItem {
  punchId: string;
  dataUrl: string;
}

function getQueue(): QueueItem[] {
  try {
    return JSON.parse(localStorage.getItem(QUEUE_KEY) ?? '[]') as QueueItem[];
  } catch {
    return [];
  }
}

function setQueue(items: QueueItem[]): void {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(items.slice(-MAX_QUEUE)));
}

async function uploadPhoto(token: string, item: QueueItem): Promise<boolean> {
  try {
    const blob = await (await fetch(item.dataUrl)).blob();
    const form = new FormData();
    form.append('photo', blob, 'punch.jpg');
    const res = await fetch(`/api/punches/${item.punchId}/photo`, {
      method: 'POST',
      headers: { 'x-device-token': token },
      body: form,
    });
    return res.ok || res.status === 404; // 404: checada anulada, no reintentar
  } catch {
    return false;
  }
}

async function flushQueue(token: string): Promise<void> {
  const queue = getQueue();
  const remaining: QueueItem[] = [];
  for (const item of queue) {
    if (!(await uploadPhoto(token, item))) remaining.push(item);
  }
  setQueue(remaining);
}

type Step =
  | { name: 'number' }
  | { name: 'pin'; employeeNumber: string; error?: string }
  | { name: 'locked'; seconds: number }
  | { name: 'confirm'; result: PunchIngestResponse }
  | { name: 'error'; message: string };

export default function KioskPage() {
  const [token, setToken] = useState<string | null>(null);
  const [step, setStep] = useState<Step>({ name: 'number' });
  const [numberInput, setNumberInput] = useState('');
  const [pinInput, setPinInput] = useState('');
  const [busy, setBusy] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // Token de dispositivo desde ?token= o localStorage
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get('token');
    if (fromUrl) {
      localStorage.setItem(TOKEN_KEY, fromUrl);
      window.history.replaceState(null, '', '/kiosk');
    }
    setToken(localStorage.getItem(TOKEN_KEY));
  }, []);

  // Cámara siempre encendida (kiosco dedicado): captura instantánea, sin espera
  useEffect(() => {
    let cancelled = false;
    void navigator.mediaDevices
      ?.getUserMedia({ video: { facingMode: 'user', width: 640, height: 480 } })
      .then((stream) => {
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;
      })
      .catch(() => {
        // Sin cámara: el kiosco sigue funcionando, la checada no depende de la foto
      });
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  // Cola de fotos pendientes: reintento cada 15s
  useEffect(() => {
    if (!token) return;
    void flushQueue(token);
    const interval = setInterval(() => void flushQueue(token), 15_000);
    return () => clearInterval(interval);
  }, [token]);

  const reset = useCallback(() => {
    setStep({ name: 'number' });
    setNumberInput('');
    setPinInput('');
    setBusy(false);
  }, []);

  // Auto-reset de confirmación / error / countdown de bloqueo
  useEffect(() => {
    if (step.name === 'confirm' || step.name === 'error') {
      const t = setTimeout(reset, step.name === 'confirm' ? 3000 : 4000);
      return () => clearTimeout(t);
    }
    if (step.name === 'locked') {
      const t = setInterval(() => {
        setStep((s) => {
          if (s.name !== 'locked') return s;
          return s.seconds <= 1 ? { name: 'number' } : { name: 'locked', seconds: s.seconds - 1 };
        });
      }, 1000);
      return () => clearInterval(t);
    }
  }, [step.name, reset]);

  function capturePhoto(): string | null {
    const video = videoRef.current;
    if (!video || video.readyState < 2) return null;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d')!.drawImage(video, 0, 0);
    return canvas.toDataURL('image/jpeg', 0.8);
  }

  async function submitPunch(employeeNumber: string, pin: string): Promise<void> {
    if (!token) return;
    setBusy(true);
    const photo = capturePhoto(); // se captura al confirmar, antes del request
    try {
      const res = await fetch('/api/punches/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-device-token': token },
        body: JSON.stringify({ employee_number: Number(employeeNumber), pin, source: 'kiosk' }),
      });
      const data = (await res.json().catch(() => ({}))) as PunchIngestResponse & {
        error?: string;
        code?: string;
      };
      if (res.status === 429) {
        const match = /(\d+)s/.exec(data.error ?? '');
        setStep({ name: 'locked', seconds: match ? Number(match[1]) : 60 });
        setPinInput('');
        setBusy(false);
        return;
      }
      if (res.status === 401) {
        setStep({ name: 'pin', employeeNumber, error: 'Número o PIN incorrecto' });
        setPinInput('');
        setBusy(false);
        return;
      }
      if (!res.ok) throw new Error(data.error ?? 'Error');

      // Checada confirmada: encolar la foto y subir en background
      if (photo) {
        setQueue([...getQueue(), { punchId: data.punch_id, dataUrl: photo }]);
        void flushQueue(token);
      }
      setStep({ name: 'confirm', result: data });
      setBusy(false);
    } catch {
      setStep({ name: 'error', message: 'Sin conexión. Avisa a tu supervisor.' });
      setBusy(false);
    }
  }

  function pressDigit(d: string): void {
    if (step.name === 'number') {
      if (numberInput.length < 5) setNumberInput(numberInput + d);
    } else if (step.name === 'pin' && !busy) {
      const next = pinInput + d;
      setPinInput(next);
      if (next.length === 4) void submitPunch(step.employeeNumber, next);
    }
  }

  function pressBack(): void {
    if (step.name === 'number') setNumberInput(numberInput.slice(0, -1));
    else if (step.name === 'pin') setPinInput(pinInput.slice(0, -1));
  }

  if (!token) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-kiosk-bg p-8 text-center text-kiosk-ink">
        <div>
          <h1 className="font-display text-28 font-bold">Kiosco sin configurar</h1>
          <p className="mt-4 text-16 text-kiosk-ink-dim">
            Abre <code className="rounded-control bg-kiosk-raised px-2 py-1">/kiosk?token=TOKEN</code> una vez para
            registrar esta tablet.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen select-none flex-col bg-kiosk-bg text-kiosk-ink">
      {/* Header mínimo: identidad + preview de cámara. Cero cromo de navegación. */}
      <div className="flex items-center justify-between px-6 pt-4">
        <span className="font-display text-18 font-bold text-kiosk-ink-dim">
          NODO <span className="font-semibold">Clock-In</span>
        </span>
        <video
          ref={videoRef}
          autoPlay
          muted
          playsInline
          className="h-20 w-28 rounded-card border border-kiosk-line object-cover"
          style={{ transform: 'scaleX(-1)' }}
        />
      </div>

      {step.name === 'confirm' ? (
        <Confirmation result={step.result} />
      ) : step.name === 'locked' ? (
        <div className="flex flex-1 flex-col items-center justify-center px-8 text-center">
          <h1 className="font-display text-40 font-bold text-danger">Demasiados intentos</h1>
          <p className="mt-6 text-28 text-kiosk-ink-dim">
            Espera <span className="tnum font-display font-bold text-kiosk-ink">{step.seconds}</span> segundos
          </p>
        </div>
      ) : step.name === 'error' ? (
        <div className="flex flex-1 flex-col items-center justify-center px-8 text-center">
          <div className="flex h-20 w-20 items-center justify-center rounded-full bg-danger">
            <X size={44} strokeWidth={2.5} className="text-kiosk-ink" />
          </div>
          <h1 className="mt-8 font-display text-40 font-bold">{step.message}</h1>
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-6 px-6 pb-10">
          <h1 className="text-22 font-semibold text-kiosk-ink-dim">
            {step.name === 'number' ? 'Número de empleado' : 'PIN'}
          </h1>

          {step.name === 'number' ? (
            <div className="tnum flex h-24 min-w-72 items-center justify-center rounded-card border border-kiosk-line bg-kiosk-raised px-8 font-display text-64 font-bold tracking-widest">
              {numberInput || <span className="text-kiosk-line">···</span>}
            </div>
          ) : (
            <div className="flex h-24 items-center justify-center gap-6">
              {[0, 1, 2, 3].map((i) => (
                <div
                  key={i}
                  className={`h-6 w-6 rounded-full border-2 ${
                    i < pinInput.length ? 'border-kiosk-ink bg-kiosk-ink' : 'border-kiosk-line bg-transparent'
                  }`}
                />
              ))}
            </div>
          )}

          <p
            className={`h-8 text-22 font-semibold ${
              step.name === 'pin' && step.error ? 'text-danger' : 'text-kiosk-ink-dim'
            }`}
            role={step.name === 'pin' && step.error ? 'alert' : undefined}
          >
            {step.name === 'pin' && step.error ? step.error : busy ? 'Registrando…' : ''}
          </p>

          {/* Teclado: teclas de 88px, funciona con guantes */}
          <div className="grid w-full max-w-sm grid-cols-3 gap-3">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
              <Key key={d} onPress={() => pressDigit(d)}>
                {d}
              </Key>
            ))}
            <Key onPress={pressBack} muted aria-label="Borrar">
              <Delete size={32} strokeWidth={1.5} />
            </Key>
            <Key onPress={() => pressDigit('0')}>0</Key>
            {step.name === 'number' ? (
              <button
                disabled={!numberInput}
                onClick={() => {
                  setStep({ name: 'pin', employeeNumber: numberInput });
                  setPinInput('');
                }}
                className="flex h-22 items-center justify-center rounded-card bg-accent font-display text-28 font-bold text-kiosk-ink transition-colors duration-150 active:bg-accent-hover disabled:opacity-45"
              >
                OK
              </button>
            ) : (
              <Key onPress={reset} muted aria-label="Cancelar">
                <X size={32} strokeWidth={1.5} />
              </Key>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Key({
  children,
  onPress,
  muted,
  ...rest
}: {
  children: React.ReactNode;
  onPress: () => void;
  muted?: boolean;
  'aria-label'?: string;
}) {
  return (
    <button
      onClick={onPress}
      className={`flex h-22 items-center justify-center rounded-card border font-display text-40 font-bold transition-transform duration-150 active:scale-95 ${
        muted
          ? 'border-kiosk-line bg-transparent text-kiosk-ink-dim'
          : 'border-kiosk-line bg-kiosk-raised text-kiosk-ink active:bg-kiosk-line'
      }`}
      {...rest}
    >
      {children}
    </button>
  );
}

function Confirmation({ result }: { result: PunchIngestResponse }) {
  // La hora la formatea el SERVIDOR en la zona de la planta (punched_at_local):
  // el kiosco nunca usa el reloj/zona del dispositivo para mostrarla.
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-8 text-center">
      <div className="kiosk-check flex h-24 w-24 items-center justify-center rounded-full bg-success">
        <Check size={52} strokeWidth={3} className="text-kiosk-ink" />
      </div>
      <h1 className="mt-10 font-display text-40 font-bold leading-tight">{result.employee_name}</h1>
      <p className="mt-5 font-display text-28 font-bold text-kiosk-ink-dim">
        {TYPE_LABELS[result.punch_type_inferred]}
      </p>
      <p className="tnum mt-4 font-display text-64 font-bold">{result.punched_at_local}</p>
    </div>
  );
}
