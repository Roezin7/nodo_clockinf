import { useCallback, useEffect, useRef, useState } from 'react';
import type { PunchIngestResponse, PunchType } from '@clockai/shared';

/**
 * Kiosco para tablet en modo retrato. Flujo: número de empleado → PIN de 4
 * dígitos → foto automática → confirmación 3s → reset. Optimizado para fila:
 * la checada se confirma sin esperar la foto; la foto se sube en background
 * con cola de reintentos en localStorage.
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

  // Auto-reset de confirmación / error
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
      <div className="flex min-h-screen items-center justify-center bg-ink p-8 text-center text-white">
        <div>
          <h1 className="text-3xl font-extrabold">Kiosco sin configurar</h1>
          <p className="mt-4 text-lg opacity-70">
            Abre <code className="rounded bg-white/10 px-2 py-1">/kiosk?token=TOKEN_DEL_DISPOSITIVO</code> una vez
            para registrar esta tablet.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-surface select-none">
      {/* Cámara: preview pequeño, siempre activa */}
      <div className="flex items-center justify-between px-6 pt-4">
        <span className="text-xl font-extrabold tracking-tight text-wine-600">
          NODO <span className="font-medium text-ink">CLOCK-IN</span>
        </span>
        <video
          ref={videoRef}
          autoPlay
          muted
          playsInline
          className="h-20 w-28 rounded-xl border border-line object-cover"
          style={{ transform: 'scaleX(-1)' }}
        />
      </div>

      {step.name === 'confirm' ? (
        <Confirmation result={step.result} />
      ) : step.name === 'locked' ? (
        <div className="flex flex-1 flex-col items-center justify-center px-8 text-center">
          <div className="text-7xl">⏳</div>
          <h1 className="mt-6 text-4xl font-extrabold text-bad">Demasiados intentos</h1>
          <p className="mt-4 text-2xl text-ink-soft">
            Espera <span className="font-extrabold tabular-nums text-ink">{step.seconds}</span> segundos
          </p>
        </div>
      ) : step.name === 'error' ? (
        <div className="flex flex-1 flex-col items-center justify-center px-8 text-center">
          <div className="text-7xl">⚠️</div>
          <h1 className="mt-6 text-4xl font-extrabold text-bad">{step.message}</h1>
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-6 px-6 pb-8">
          <h1 className="text-3xl font-bold text-ink-soft">
            {step.name === 'number' ? 'Número de empleado' : 'PIN'}
          </h1>

          {step.name === 'number' ? (
            <div className="flex h-24 min-w-64 items-center justify-center rounded-2xl border-2 border-line bg-card px-8 text-6xl font-extrabold tabular-nums tracking-widest">
              {numberInput || <span className="text-line">—</span>}
            </div>
          ) : (
            <div className="flex h-24 items-center justify-center gap-5">
              {[0, 1, 2, 3].map((i) => (
                <div
                  key={i}
                  className={`h-8 w-8 rounded-full border-2 ${
                    i < pinInput.length ? 'border-wine-600 bg-wine-600' : 'border-line bg-card'
                  }`}
                />
              ))}
            </div>
          )}

          {step.name === 'pin' && step.error && (
            <p className="text-2xl font-bold text-bad">{step.error}</p>
          )}
          {busy && <p className="text-2xl font-bold text-ink-soft">Registrando…</p>}

          {/* Teclado: touch targets ≥64px (funciona con guantes) */}
          <div className="grid w-full max-w-md grid-cols-3 gap-3">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
              <Key key={d} onPress={() => pressDigit(d)} label={d} />
            ))}
            <Key onPress={pressBack} label="⌫" muted />
            <Key onPress={() => pressDigit('0')} label="0" />
            {step.name === 'number' ? (
              <button
                disabled={!numberInput}
                onClick={() => {
                  setStep({ name: 'pin', employeeNumber: numberInput });
                  setPinInput('');
                }}
                className="h-20 rounded-2xl bg-wine-600 text-2xl font-extrabold text-white active:bg-wine-700 disabled:opacity-30"
              >
                OK
              </button>
            ) : (
              <Key onPress={reset} label="✕" muted />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Key({ label, onPress, muted }: { label: string; onPress: () => void; muted?: boolean }) {
  return (
    <button
      onClick={onPress}
      className={`h-20 rounded-2xl border text-4xl font-extrabold active:scale-95 ${
        muted ? 'border-line bg-surface text-ink-soft' : 'border-line bg-card text-ink active:bg-wine-50'
      }`}
    >
      {label}
    </button>
  );
}

function Confirmation({ result }: { result: PunchIngestResponse }) {
  // La hora la formatea el SERVIDOR en la zona de la planta (punched_at_local):
  // el kiosco nunca usa el reloj/zona del dispositivo para mostrarla.
  const time = result.punched_at_local;
  return (
    <div className="flex flex-1 flex-col items-center justify-center bg-ok/5 px-8 text-center">
      <div className="flex h-24 w-24 items-center justify-center rounded-full bg-ok text-5xl text-white">✓</div>
      <h1 className="mt-8 text-5xl font-extrabold leading-tight">{result.employee_name}</h1>
      <p className="mt-6 text-4xl font-extrabold text-wine-600">{TYPE_LABELS[result.punch_type_inferred]}</p>
      <p className="mt-4 text-6xl font-extrabold tabular-nums">{time}</p>
    </div>
  );
}
