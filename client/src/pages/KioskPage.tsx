import { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, Check, ChevronLeft, Clock3, Delete, RefreshCw, Wifi, WifiOff, X } from 'lucide-react';
import type { DeviceComponentStatus, PunchType } from '@clockai/shared';
import {
  acknowledgeEvent,
  deleteQueuedEvent,
  enqueuePunch,
  markPending,
  markRejected,
  queueStats,
  recoverProvisionalEvents,
  retryRejectedEvents,
  type QueueStats,
} from '../kiosk/db';
import { flushKioskQueue, sendHeartbeat } from '../kiosk/sync';
import { cancelEnrollmentAttempt, completeEnrollment, enrollDevice, prepareEnrollmentAttempt } from '../kiosk/enrollment';
import { kioskFetch, KIOSK_TIMEOUT_MS } from '../kiosk/fetch';
import { isConfirmedPinLock } from '../kiosk/ingestPolicy';

const TOKEN_KEY = 'clockai.kiosk.token';
const DEVICE_INFO_KEY = 'clockai.kiosk.deviceInfo';

const TYPE_LABELS: Record<PunchType, string> = {
  shift_in: 'ENTRADA',
  meal_out: 'SALIDA A COMER',
  meal_in: 'REGRESO DE COMER',
  shift_out: 'SALIDA',
};

const PUNCH_ACTIONS: { type: PunchType; label: string; accent: string }[] = [
  { type: 'shift_in', label: 'Entrada', accent: 'border-success/60 bg-success/15' },
  { type: 'meal_out', label: 'Salida a comer', accent: 'border-warning/60 bg-warning/15' },
  { type: 'meal_in', label: 'Regreso de comer', accent: 'border-info/60 bg-info/15' },
  { type: 'shift_out', label: 'Salida', accent: 'border-accent/60 bg-accent/15' },
];

interface KioskDevice {
  id: string;
  name: string;
  plant_name?: string;
  plant?: { name?: string };
  public_id?: string;
  timezone?: string;
}

function cachedDevice(): KioskDevice | null {
  try {
    return JSON.parse(localStorage.getItem(DEVICE_INFO_KEY) ?? 'null') as KioskDevice | null;
  } catch {
    return null;
  }
}

function storeDevice(device: KioskDevice | null): void {
  if (device) localStorage.setItem(DEVICE_INFO_KEY, JSON.stringify(device));
}

interface IngestResponse {
  punch_id: string;
  employee_name: string;
  punch_type_inferred?: PunchType;
  punch_type?: PunchType;
  punched_at: string;
  punched_at_local: string;
  timezone: string;
  error?: string;
  code?: string;
}

interface ConfirmationResult {
  employeeName: string;
  punchType: PunchType;
  displayedTime: string;
  pending: boolean;
}

type Step =
  | { name: 'number' }
  | { name: 'action'; employeeNumber: string }
  | { name: 'pin'; employeeNumber: string; punchType: PunchType; error?: string }
  | { name: 'locked'; seconds: number }
  | { name: 'confirm'; result: ConfirmationResult }
  | { name: 'error'; message: string };

function localDisplayTime(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat('es-US', { hour: 'numeric', minute: '2-digit', timeZone: timezone }).format(new Date(iso));
}

export default function KioskPage() {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(TOKEN_KEY));
  const [enrollmentAttempt] = useState(prepareEnrollmentAttempt);
  const [activationRetry, setActivationRetry] = useState(0);
  const [activating, setActivating] = useState(Boolean(enrollmentAttempt));
  const [activationComplete, setActivationComplete] = useState(!enrollmentAttempt);
  const [step, setStep] = useState<Step>({ name: 'number' });
  const [numberInput, setNumberInput] = useState('');
  const [pinInput, setPinInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [browserOnline, setBrowserOnline] = useState(navigator.onLine);
  const [serverOnline, setServerOnline] = useState<boolean | null>(null);
  const [stats, setStats] = useState<QueueStats>({ pending: 0, rejected: 0 });
  const [device, setDevice] = useState<KioskDevice | null>(cachedDevice);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [storageStatus, setStorageStatus] = useState<DeviceComponentStatus>('unknown');
  const [storageWarning, setStorageWarning] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const submittingRef = useRef(false);

  useEffect(() => {
    if (!enrollmentAttempt) return;
    let cancelled = false;
    setActivating(true);
    void (async () => {
      try {
        const localStats = await queueStats();
        if (localStats.pending + localStats.rejected > 0) {
          throw new Error('Hay checadas locales pendientes. Sincronízalas antes de activar otra credencial.');
        }
        const result = await enrollDevice(enrollmentAttempt);
        const finalStats = await queueStats();
        if (finalStats.pending + finalStats.rejected > 0) {
          throw new Error('La cola cambió durante la activación. Requiere revisión del administrador.');
        }
        if (!cancelled) {
          completeEnrollment(result);
          setToken(result.deviceToken);
          setDevice(result.device);
          storeDevice(result.device);
          setDeviceError(null);
          setActivationComplete(true);
        }
      } catch (error) {
        if (!cancelled) setDeviceError(error instanceof Error ? error.message : 'No fue posible activar el checador.');
      } finally {
        if (!cancelled) setActivating(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enrollmentAttempt, activationRetry]);

  useEffect(() => {
    if (!enrollmentAttempt) return;
    const retry = () => setActivationRetry((current) => current + 1);
    window.addEventListener('online', retry);
    return () => window.removeEventListener('online', retry);
  }, [enrollmentAttempt]);

  const startCamera = useCallback(async () => {
    if (!token || !videoRef.current) return;
    setCameraError(null);
    setCameraReady(false);
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('unsupported');
      streamRef.current?.getTracks().forEach((track) => track.stop());
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      });
      streamRef.current = stream;
      if (!videoRef.current) throw new Error('video_not_mounted');
      videoRef.current.srcObject = stream;
      await videoRef.current.play();
      setCameraReady(true);
    } catch {
      setCameraError('Cámara no disponible. Usa el otro checador o avisa al foreman.');
    }
  }, [token]);

  useEffect(() => {
    if (!token) return;
    void startCamera();
    return () => streamRef.current?.getTracks().forEach((track) => track.stop());
  }, [token, startCamera]);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    void (async () => {
      try {
        if (!navigator.storage?.estimate) {
          if (!cancelled) {
            setStorageStatus('degraded');
            setStorageWarning('No se puede verificar la persistencia del almacenamiento en este navegador.');
          }
          return;
        }
        const wasPersistent = (await navigator.storage.persisted?.()) ?? false;
        const persistent = wasPersistent || ((await navigator.storage.persist?.()) ?? false);
        const estimate = await navigator.storage.estimate();
        const usage = estimate.usage ?? 0;
        const quota = estimate.quota ?? 0;
        const remaining = Math.max(0, quota - usage);
        if (!cancelled && quota > 0 && (usage / quota >= 0.9 || remaining < 25 * 1024 * 1024)) {
          setStorageStatus('unavailable');
          setStorageWarning('Almacenamiento casi lleno. Avisa al foreman antes de continuar.');
        } else if (!cancelled && !persistent) {
          setStorageStatus('degraded');
          setStorageWarning('El navegador no garantizó almacenamiento persistente; mantén esta app instalada.');
        } else if (!cancelled) {
          setStorageStatus('ready');
          setStorageWarning(null);
        }
      } catch {
        if (!cancelled) {
          setStorageStatus('unavailable');
          setStorageWarning('No se pudo validar el almacenamiento local. Avisa al foreman.');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const refreshStats = useCallback(async () => {
    try {
      setStats(await queueStats());
    } catch {
      setStorageStatus('unavailable');
      setStorageWarning('El almacenamiento local del kiosco no está disponible.');
    }
  }, []);

  const syncNow = useCallback(async () => {
    if (!token) return;
    setSyncing(true);
    try {
      let before: QueueStats | null = null;
      let effectiveStorageStatus = storageStatus;
      try {
        before = await queueStats();
      } catch {
        effectiveStorageStatus = 'unavailable';
        setStorageStatus('unavailable');
        setStorageWarning('No se pudieron leer las colas locales; sus contadores no fueron reemplazados en el servidor.');
      }
      const cameraStatus: DeviceComponentStatus = cameraReady
        ? 'ready'
        : cameraError
          ? 'unavailable'
          : 'unknown';
      const health = { cameraStatus, storageStatus: effectiveStorageStatus };
      // El servidor recibe primero la hora actual para normalizar de forma
      // confiable cualquier captured_at acumulado durante la desconexión.
      const beforeHeartbeat = await sendHeartbeat(token, before, cameraError ?? storageWarning, health);
      try {
        const result = await flushKioskQueue(token);
        setStats(result.stats);
        const heartbeatOk = await sendHeartbeat(
          token,
          result.stats,
          result.lastError ?? cameraError ?? storageWarning,
          health
        );
        setServerOnline(heartbeatOk || (beforeHeartbeat && result.serverReachable));
      } catch {
        setStorageStatus('unavailable');
        const heartbeatOk = await sendHeartbeat(
          token,
          null,
          'No se pudieron leer las colas locales',
          { cameraStatus, storageStatus: 'unavailable' }
        );
        setServerOnline(heartbeatOk);
      }
    } finally {
      setSyncing(false);
    }
  }, [token, cameraError, cameraReady, storageStatus, storageWarning]);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    void (async () => {
      try {
        await recoverProvisionalEvents();
        await refreshStats();
        const response = await kioskFetch(
          '/api/punches/kiosk/self',
          { headers: { 'x-device-token': token } },
          KIOSK_TIMEOUT_MS.self
        );
        if (response.ok) {
          const data = (await response.json()) as KioskDevice;
          if (!cancelled) {
            setDevice(data);
            storeDevice(data);
            setServerOnline(true);
            setDeviceError(null);
          }
        } else if (response.status === 401 && !cancelled) {
          setServerOnline(true);
          setDeviceError('Este checador fue revocado o su token no es válido.');
        }
      } catch {
        if (!cancelled) setServerOnline(false);
      }
      if (!cancelled) void syncNow();
    })();
    return () => {
      cancelled = true;
    };
  }, [token, refreshStats, syncNow]);

  useEffect(() => {
    if (!token) return;
    const onOnline = () => {
      setBrowserOnline(true);
      void syncNow();
    };
    const onOffline = () => {
      setBrowserOnline(false);
      setServerOnline(false);
    };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    const interval = window.setInterval(() => void syncNow(), 15_000);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      window.clearInterval(interval);
    };
  }, [token, syncNow]);

  const reset = useCallback(() => {
    setStep({ name: 'number' });
    setNumberInput('');
    setPinInput('');
    setBusy(false);
    submittingRef.current = false;
  }, []);

  useEffect(() => {
    if (step.name === 'confirm' || step.name === 'error') {
      const timeout = window.setTimeout(reset, step.name === 'confirm' ? 4_000 : 5_000);
      return () => window.clearTimeout(timeout);
    }
    if (step.name === 'locked') {
      const interval = window.setInterval(() => {
        setStep((current) => {
          if (current.name !== 'locked') return current;
          return current.seconds <= 1 ? { name: 'number' } : { name: 'locked', seconds: current.seconds - 1 };
        });
      }, 1_000);
      return () => window.clearInterval(interval);
    }
  }, [step.name, reset]);

  async function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
    return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82));
  }

  async function captureEvidence(): Promise<{
    photo: Blob;
    status: 'captured' | 'camera_unavailable';
  } | null> {
    const video = videoRef.current;
    const canvas = document.createElement('canvas');
    canvas.width = cameraReady && video?.videoWidth ? video.videoWidth : 640;
    canvas.height = cameraReady && video?.videoHeight ? video.videoHeight : 480;
    const context = canvas.getContext('2d');
    if (!context) return null;
    if (cameraReady && video && video.readyState >= 2 && video.videoWidth) {
      context.drawImage(video, 0, 0);
      const photo = await canvasBlob(canvas);
      return photo ? { photo, status: 'captured' } : null;
    }

    // La falla física de cámara genera evidencia diagnóstica y alerta, pero
    // nunca bloquea las horas. Fase 5 la convierte en incidente de revisión.
    context.fillStyle = '#111827';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#ef4444';
    context.font = 'bold 34px sans-serif';
    context.textAlign = 'center';
    context.fillText('CÁMARA NO DISPONIBLE', canvas.width / 2, canvas.height / 2 - 15);
    context.fillStyle = '#ffffff';
    context.font = '22px sans-serif';
    context.fillText(new Date().toISOString(), canvas.width / 2, canvas.height / 2 + 30);
    const photo = await canvasBlob(canvas);
    return photo ? { photo, status: 'camera_unavailable' } : null;
  }

  async function finishAsPending(
    eventId: string,
    employeeNumber: string,
    punchType: PunchType,
    capturedAt: string,
    error: string,
    reachable = false
  ): Promise<void> {
    await markPending(eventId, error);
    await refreshStats();
    setServerOnline(reachable);
    setStep({
      name: 'confirm',
      result: {
        employeeName: `Empleado ${employeeNumber}`,
        punchType,
        displayedTime: localDisplayTime(capturedAt, device?.timezone ?? 'America/Los_Angeles'),
        pending: true,
      },
    });
  }

  async function submitPunch(employeeNumber: string, pin: string, punchType: PunchType): Promise<void> {
    if (!token || submittingRef.current) return;
    submittingRef.current = true;
    setBusy(true);
    if (storageStatus === 'unavailable') {
      setStep({ name: 'error', message: 'Almacenamiento lleno o no disponible. Avisa al foreman.' });
      setBusy(false);
      submittingRef.current = false;
      return;
    }
    const evidence = await captureEvidence();
    if (!evidence) {
      setStep({ name: 'pin', employeeNumber, punchType, error: 'No se pudo proteger la evidencia. Avisa al foreman.' });
      setPinInput('');
      setBusy(false);
      submittingRef.current = false;
      return;
    }

    const capturedAt = new Date().toISOString();
    let queued: Awaited<ReturnType<typeof enqueuePunch>>;
    try {
      // La evidencia cifrada queda durable ANTES del request. El PIN sólo vive en memoria.
      queued = await enqueuePunch(token, {
        employeeNumber: Number(employeeNumber),
        punchType,
        capturedAt,
        photo: evidence.photo,
        evidenceStatus: evidence.status,
      });
      await refreshStats();
    } catch {
      setStep({ name: 'error', message: 'No se pudo guardar localmente. Avisa al foreman.' });
      setBusy(false);
      submittingRef.current = false;
      return;
    }

    try {
      const response = await kioskFetch('/api/punches/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-device-token': token },
        body: JSON.stringify({
          employee_number: Number(employeeNumber),
          pin,
          source: 'kiosk',
          punch_type: punchType,
          client_event_id: queued.id,
          captured_at: capturedAt,
          client_sequence: queued.payload.clientSequence,
          evidence_status: queued.payload.evidenceStatus,
          client_installation_id: queued.payload.clientInstallationId,
          client_clock_skew_seconds: queued.payload.clientClockSkewSeconds,
        }),
      }, KIOSK_TIMEOUT_MS.ingest);
      setServerOnline(true);
      const data = (await response.json().catch(() => ({}))) as Partial<IngestResponse>;

      if (isConfirmedPinLock(response.status, data.code)) {
        await deleteQueuedEvent(queued.id);
        await refreshStats();
        const match = /(\d+)s/.exec(data.error ?? '');
        setStep({ name: 'locked', seconds: match ? Number(match[1]) : 60 });
        setPinInput('');
      } else if (response.status === 429) {
        await finishAsPending(
          queued.id,
          employeeNumber,
          punchType,
          capturedAt,
          data.error ?? 'Límite temporal del servidor',
          true
        );
      } else if (response.status === 401) {
        // Confirmar que el token del checador sigue vigente antes de concluir
        // que fue el PIN. Si no puede confirmarse, conservar toda evidencia.
        let deviceAuthorized = false;
        try {
          const self = await kioskFetch(
            '/api/punches/kiosk/self',
            { headers: { 'x-device-token': token } },
            KIOSK_TIMEOUT_MS.self
          );
          deviceAuthorized = self.ok;
        } catch {
          deviceAuthorized = false;
        }
        if (deviceAuthorized) {
          await deleteQueuedEvent(queued.id);
          setStep({ name: 'pin', employeeNumber, punchType, error: 'Número o PIN incorrecto' });
          setPinInput('');
        } else {
          await markRejected(queued.id, '[device_unauthorized] No se pudo validar el checador');
          setDeviceError('Este checador fue revocado o su token no es válido.');
          setStep({ name: 'error', message: 'Checada protegida para revisión. Avisa al foreman.' });
        }
        await refreshStats();
      } else if (response.status >= 500) {
        await finishAsPending(
          queued.id,
          employeeNumber,
          punchType,
          capturedAt,
          data.error ?? 'Error temporal del servidor',
          true
        );
      } else if (response.ok && !data.punch_id) {
        // El servidor pudo haber confirmado la transacción antes de truncarse
        // la respuesta: reintentar por UUID es seguro e idempotente.
        await finishAsPending(
          queued.id,
          employeeNumber,
          punchType,
          capturedAt,
          'Confirmación incompleta del servidor',
          true
        );
      } else if (!response.ok) {
        await markRejected(
          queued.id,
          `${data.code ? `[${data.code}] ` : ''}${data.error ?? `Validación ${response.status}`}`
        );
        await refreshStats();
        setStep({ name: 'error', message: 'Checada guardada para revisión. Avisa al foreman.' });
      } else {
        const punchId = data.punch_id!; // rama 2xx con acknowledgement completo
        await acknowledgeEvent(token, queued.id, {
          punchId,
          employeeName: data.employee_name,
          punchedAtLocal: data.punched_at_local,
          timezone: data.timezone,
        });
        await refreshStats();
        setStep({
          name: 'confirm',
          result: {
            employeeName: data.employee_name ?? `Empleado ${employeeNumber}`,
            punchType,
            displayedTime:
              data.punched_at_local ?? localDisplayTime(capturedAt, device?.timezone ?? 'America/Los_Angeles'),
            pending: false,
          },
        });
        void syncNow();
      }
    } catch {
      await finishAsPending(queued.id, employeeNumber, punchType, capturedAt, 'Sin conexión con el servidor');
    } finally {
      setBusy(false);
      submittingRef.current = false;
    }
  }

  function pressDigit(digit: string): void {
    if (step.name === 'number') {
      if (numberInput.length < 6) setNumberInput(numberInput + digit);
    } else if (step.name === 'pin' && !busy) {
      const next = pinInput + digit;
      setPinInput(next);
      if (next.length === 4) void submitPunch(step.employeeNumber, next, step.punchType);
    }
  }

  function pressBack(): void {
    if (step.name === 'number') setNumberInput(numberInput.slice(0, -1));
    else if (step.name === 'pin') setPinInput(pinInput.slice(0, -1));
  }

  if (enrollmentAttempt && !activationComplete) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-kiosk-bg p-8 text-center text-kiosk-ink">
        <div>
          <h1 className="font-display text-28 font-bold">{activating ? 'Activando checador…' : 'Activación pendiente'}</h1>
          <p className="mt-4 max-w-lg text-16 text-kiosk-ink-dim">
            {activating ? 'Validando la credencial sin permitir nuevas checadas.' : deviceError ?? 'No fue posible activar.'}
          </p>
          {!activating && (
            <div className="mt-5 flex flex-col items-center gap-3">
              <button
                onClick={() => setActivationRetry((current) => current + 1)}
                className="rounded-control bg-accent px-5 py-3 text-15 font-semibold"
              >
                Reintentar activación
              </button>
              {token && (
                <button
                  onClick={() => {
                    cancelEnrollmentAttempt();
                    window.location.reload();
                  }}
                  className="text-14 font-semibold text-kiosk-ink-dim underline underline-offset-4"
                >
                  Cancelar y conservar checador actual
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (!token) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-kiosk-bg p-8 text-center text-kiosk-ink">
        <div>
          <h1 className="font-display text-28 font-bold">Kiosco sin configurar</h1>
          <p className="mt-4 max-w-lg text-16 text-kiosk-ink-dim">
            {deviceError ?? 'Un administrador debe crear este checador en Configuración y abrir aquí su enlace de activación.'}
          </p>
        </div>
      </div>
    );
  }

  const connected = browserOnline && serverOnline === true;
  const plantName = device?.plant_name ?? device?.plant?.name;

  return (
    <div className="flex min-h-screen select-none flex-col bg-kiosk-bg text-kiosk-ink">
      <header className="flex min-h-24 items-center justify-between gap-4 border-b border-kiosk-line px-5 py-3">
        <div className="min-w-0">
          <p className="font-display text-18 font-bold text-kiosk-ink-dim">
            NODO <span className="font-semibold">Clock-In</span>
          </p>
          <p className="mt-1 truncate text-14 text-kiosk-ink-dim">
            {device ? `${device.name}${plantName ? ` · ${plantName}` : ''}` : 'Verificando checador…'}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-3 text-13 font-semibold">
            <span className={`inline-flex items-center gap-1.5 ${connected ? 'text-success' : 'text-warning'}`}>
              {connected ? <Wifi size={16} /> : <WifiOff size={16} />}
              {connected ? 'En línea' : 'Sin conexión'}
            </span>
            <span className={stats.pending ? 'text-warning' : 'text-kiosk-ink-dim'}>
              {stats.pending} pendiente{stats.pending === 1 ? '' : 's'}
            </span>
            {stats.rejected > 0 && (
              <button
                className="text-danger underline decoration-danger/50 underline-offset-2"
                onClick={() => {
                  void retryRejectedEvents().then(refreshStats).then(syncNow);
                }}
              >
                {stats.rejected} rechazadas · reintentar
              </button>
            )}
            <button
              className="inline-flex items-center gap-1 text-kiosk-ink-dim disabled:opacity-50"
              disabled={syncing}
              onClick={() => void syncNow()}
            >
              <RefreshCw size={14} className={syncing ? 'animate-spin' : ''} /> Sincronizar
            </button>
          </div>
        </div>
        <div className="relative shrink-0">
          <video
            ref={videoRef}
            autoPlay
            muted
            playsInline
            className={`h-20 w-28 rounded-card border object-cover ${cameraReady ? 'border-kiosk-line' : 'border-danger'}`}
            style={{ transform: 'scaleX(-1)' }}
          />
          {!cameraReady && (
            <button
              onClick={() => void startCamera()}
              className="absolute inset-0 flex items-center justify-center rounded-card bg-kiosk-bg/80 text-kiosk-ink"
              aria-label="Reintentar cámara"
            >
              <Camera size={28} />
            </button>
          )}
        </div>
      </header>

      {(deviceError || cameraError || storageWarning) && (
        <div className="border-b border-danger/40 bg-danger/15 px-5 py-2 text-center text-13 font-semibold text-danger" role="alert">
          {deviceError ?? cameraError ?? storageWarning}
        </div>
      )}

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
            <X size={44} strokeWidth={2.5} />
          </div>
          <h1 className="mt-8 font-display text-32 font-bold">{step.message}</h1>
        </div>
      ) : step.name === 'action' ? (
        <ActionSelection
          employeeNumber={step.employeeNumber}
          onBack={() => setStep({ name: 'number' })}
          onSelect={(punchType) => {
            setPinInput('');
            setStep({ name: 'pin', employeeNumber: step.employeeNumber, punchType });
          }}
        />
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-5 px-6 pb-8 pt-4">
          <div className="text-center">
            <h1 className="text-22 font-semibold text-kiosk-ink-dim">
              {step.name === 'number' ? 'Número de empleado' : 'Ingresa tu PIN'}
            </h1>
            {step.name === 'pin' && (
              <p className="mt-2 font-display text-18 font-bold text-kiosk-ink">
                {TYPE_LABELS[step.punchType]} · #{step.employeeNumber}
              </p>
            )}
          </div>

          {step.name === 'number' ? (
            <div className="tnum flex h-20 min-w-72 items-center justify-center rounded-card border border-kiosk-line bg-kiosk-raised px-8 font-display text-56 font-bold tracking-widest">
              {numberInput || <span className="text-kiosk-line">···</span>}
            </div>
          ) : (
            <div className="flex h-20 items-center justify-center gap-6">
              {[0, 1, 2, 3].map((index) => (
                <div
                  key={index}
                  className={`h-6 w-6 rounded-full border-2 ${
                    index < pinInput.length ? 'border-kiosk-ink bg-kiosk-ink' : 'border-kiosk-line bg-transparent'
                  }`}
                />
              ))}
            </div>
          )}

          <p
            className={`h-7 text-center text-18 font-semibold ${
              step.name === 'pin' && step.error ? 'text-danger' : 'text-kiosk-ink-dim'
            }`}
            role={step.name === 'pin' && step.error ? 'alert' : undefined}
          >
            {step.name === 'pin' && step.error ? step.error : busy ? 'Guardando evidencia…' : ''}
          </p>

          <div className="grid w-full max-w-sm grid-cols-3 gap-3">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => (
              <Key key={digit} onPress={() => pressDigit(digit)} disabled={busy}>
                {digit}
              </Key>
            ))}
            <Key onPress={pressBack} muted disabled={busy} aria-label="Borrar">
              <Delete size={30} strokeWidth={1.5} />
            </Key>
            <Key onPress={() => pressDigit('0')} disabled={busy}>0</Key>
            {step.name === 'number' ? (
              <button
                disabled={!numberInput}
                onClick={() => setStep({ name: 'action', employeeNumber: numberInput })}
                className="flex h-20 items-center justify-center rounded-card bg-accent font-display text-26 font-bold transition-colors active:bg-accent-hover disabled:opacity-45"
              >
                OK
              </button>
            ) : (
              <Key
                onPress={() => setStep({ name: 'action', employeeNumber: step.employeeNumber })}
                muted
                disabled={busy}
                aria-label="Regresar"
              >
                <ChevronLeft size={30} strokeWidth={1.5} />
              </Key>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ActionSelection({
  employeeNumber,
  onSelect,
  onBack,
}: {
  employeeNumber: string;
  onSelect: (type: PunchType) => void;
  onBack: () => void;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 py-8">
      <p className="text-16 font-semibold text-kiosk-ink-dim">Empleado #{employeeNumber}</p>
      <h1 className="mt-2 font-display text-28 font-bold">¿Qué vas a registrar?</h1>
      <div className="mt-8 grid w-full max-w-2xl grid-cols-2 gap-4">
        {PUNCH_ACTIONS.map((action) => (
          <button
            key={action.type}
            onClick={() => onSelect(action.type)}
            className={`flex min-h-32 items-center justify-center rounded-card border-2 px-4 text-center font-display text-24 font-bold transition-transform active:scale-[.98] ${action.accent}`}
          >
            {action.label}
          </button>
        ))}
      </div>
      <button onClick={onBack} className="mt-8 inline-flex items-center gap-2 text-18 font-semibold text-kiosk-ink-dim">
        <ChevronLeft size={22} /> Cambiar empleado
      </button>
    </div>
  );
}

function Key({
  children,
  onPress,
  muted,
  disabled,
  ...rest
}: {
  children: React.ReactNode;
  onPress: () => void;
  muted?: boolean;
  disabled?: boolean;
  'aria-label'?: string;
}) {
  return (
    <button
      onClick={onPress}
      disabled={disabled}
      className={`flex h-20 items-center justify-center rounded-card border font-display text-36 font-bold transition-transform active:scale-95 disabled:opacity-45 ${
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

function Confirmation({ result }: { result: ConfirmationResult }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-8 py-6 text-center">
      <div
        className={`kiosk-check flex h-24 w-24 items-center justify-center rounded-full ${
          result.pending ? 'bg-warning' : 'bg-success'
        }`}
      >
        {result.pending ? <Clock3 size={50} strokeWidth={2.5} /> : <Check size={52} strokeWidth={3} />}
      </div>
      <h1 className="mt-8 font-display text-36 font-bold leading-tight">{result.employeeName}</h1>
      <p className="mt-4 font-display text-24 font-bold text-kiosk-ink-dim">{TYPE_LABELS[result.punchType]}</p>
      <p className="tnum mt-3 font-display text-56 font-bold">{result.displayedTime}</p>
      {result.pending ? (
        <div className="mt-6 rounded-card border border-warning/50 bg-warning/15 px-6 py-4">
          <p className="text-18 font-bold">Guardada sin conexión</p>
          <p className="mt-1 text-15 text-kiosk-ink-dim">Hora capturada en el checador; pendiente de validación automática.</p>
        </div>
      ) : (
        <div className="mt-6 text-16 font-semibold text-success">
          <p>Horas registradas.</p>
          <p className="mt-1 text-14 text-kiosk-ink-dim">Evidencia cifrada en este checador, pendiente de confirmación.</p>
        </div>
      )}
    </div>
  );
}
