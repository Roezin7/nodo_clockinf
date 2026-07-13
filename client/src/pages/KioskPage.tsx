import { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, Check, ChevronLeft, Clock3, Delete, RefreshCw, ShieldCheck, Wifi, WifiOff, X } from 'lucide-react';
import type { DeviceComponentStatus, PunchType } from '@clockai/shared';
import {
  acknowledgeEvent,
  enqueuePunch,
  markPending,
  markRejected,
  listQueuedEvents,
  prepareIdentityAttempt,
  queueStats,
  recoverProvisionalEvents,
  retryRejectedEvents,
  setIdentityOutcome,
  setIdentitySession,
  type QueueStats,
  type QueuedEvent,
} from '../kiosk/db';
import { flushKioskQueue, sendHeartbeat } from '../kiosk/sync';
import { cancelEnrollmentAttempt, completeEnrollment, enrollDevice, prepareEnrollmentAttempt } from '../kiosk/enrollment';
import { kioskFetch, KIOSK_TIMEOUT_MS } from '../kiosk/fetch';
import {
  INITIAL_IDENTITY_FLOW,
  applyIdentityResult,
  attemptsRemaining,
  normalizeIdentityAttemptResult,
  serverIdentityDisposition,
  type IdentityFlowState,
} from '../kiosk/identityFlow';
import {
  KIOSK_LANGUAGE_KEY,
  kioskText,
  normalizeKioskLanguage,
  type KioskLanguage,
  type KioskMessageKey,
} from '../kiosk/i18n';
import { retryIdentityTransport } from '../kiosk/identityTransport';

const TOKEN_KEY = 'clockai.kiosk.token';
const DEVICE_INFO_KEY = 'clockai.kiosk.deviceInfo';

const PUNCH_ACTIONS: { type: PunchType; accent: string }[] = [
  { type: 'shift_in', accent: 'border-success/60 bg-success/15' },
  { type: 'meal_out', accent: 'border-warning/60 bg-warning/15' },
  { type: 'meal_in', accent: 'border-info/60 bg-info/15' },
  { type: 'shift_out', accent: 'border-accent/60 bg-accent/15' },
];

interface KioskDevice {
  id: string;
  name: string;
  plant_name?: string;
  plant?: { name?: string };
  public_id?: string;
  timezone?: string;
}

interface IdentitySessionResponse {
  session_id: string;
  employee_name: string;
  status: 'pending' | 'verified' | 'review_required';
  next_action: 'capture' | 'punch';
  consuming_attempts: number;
  attempts_remaining: number;
  max_attempts: 3;
  provider: string;
  liveness_status: string;
  enrollment_status: string;
  duplicate?: boolean;
  attempt?: {
    id: string;
    result: string;
    consumed: boolean;
    attempt_number: number | null;
    similarity: number | null;
    liveness_status: string;
  };
  error?: string;
  code?: string;
}

interface IngestResponse {
  punch_id: string;
  employee_name: string;
  punched_at_local: string;
  timezone: string;
  identity_status?: 'verified' | 'identity_review' | 'review_approved' | 'review_rejected';
  error?: string;
  code?: string;
}

interface ActiveIdentity {
  event: QueuedEvent;
  employeeNumber: string;
  employeeName: string | null;
  punchType: PunchType;
  sessionId: string;
  flow: IdentityFlowState;
  message: string | null;
}

interface ConfirmationResult {
  employeeName: string;
  punchType: PunchType;
  displayedTime: string;
  pending: boolean;
  identityReview: boolean;
}

type Step =
  | { name: 'number' }
  | { name: 'action'; employeeNumber: string }
  | { name: 'identity'; identity: ActiveIdentity }
  | { name: 'confirm'; result: ConfirmationResult }
  | { name: 'error'; message: string };

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

function localDisplayTime(iso: string, timezone: string, language: KioskLanguage): string {
  return new Intl.DateTimeFormat(language === 'es' ? 'es-US' : 'en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: timezone,
  }).format(new Date(iso));
}

export default function KioskPage() {
  const [language, setLanguage] = useState<KioskLanguage>(() =>
    normalizeKioskLanguage(localStorage.getItem(KIOSK_LANGUAGE_KEY))
  );
  const t = useCallback((key: KioskMessageKey) => kioskText(language, key), [language]);
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(TOKEN_KEY));
  const [enrollmentAttempt] = useState(prepareEnrollmentAttempt);
  const [activationRetry, setActivationRetry] = useState(0);
  const [activating, setActivating] = useState(Boolean(enrollmentAttempt));
  const [activationComplete, setActivationComplete] = useState(!enrollmentAttempt);
  const [step, setStep] = useState<Step>({ name: 'number' });
  const [numberInput, setNumberInput] = useState('');
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

  function toggleLanguage(): void {
    setLanguage((current) => {
      const next = current === 'es' ? 'en' : 'es';
      localStorage.setItem(KIOSK_LANGUAGE_KEY, next);
      return next;
    });
  }

  useEffect(() => {
    if (!enrollmentAttempt) return;
    let cancelled = false;
    setActivating(true);
    void (async () => {
      try {
        const localStats = await queueStats();
        if (localStats.pending + localStats.rejected > 0) {
          throw new Error(
            language === 'es'
              ? 'Hay checadas locales pendientes. Sincronízalas antes de activar otra credencial.'
              : 'Local punches are pending. Sync them before activating another credential.'
          );
        }
        const result = await enrollDevice(enrollmentAttempt);
        const finalStats = await queueStats();
        if (finalStats.pending + finalStats.rejected > 0) {
          throw new Error(
            language === 'es'
              ? 'La cola cambió durante la activación. Requiere revisión del administrador.'
              : 'The queue changed during activation. Administrator review is required.'
          );
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
        if (!cancelled) setDeviceError(error instanceof Error ? error.message : t('activationFailed'));
      } finally {
        if (!cancelled) setActivating(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enrollmentAttempt, activationRetry, language, t]);

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
      setCameraError(t('cameraUnavailable'));
    }
  }, [token, t]);

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
            setStorageWarning(
              language === 'es'
                ? 'No se puede verificar la persistencia del almacenamiento en este navegador.'
                : 'Storage persistence cannot be verified in this browser.'
            );
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
          setStorageWarning(t('storageUnavailable'));
        } else if (!cancelled && !persistent) {
          setStorageStatus('degraded');
          setStorageWarning(
            language === 'es'
              ? 'El navegador no garantizó almacenamiento persistente; mantén esta app instalada.'
              : 'The browser did not guarantee persistent storage; keep this app installed.'
          );
        } else if (!cancelled) {
          setStorageStatus('ready');
          setStorageWarning(null);
        }
      } catch {
        if (!cancelled) {
          setStorageStatus('unavailable');
          setStorageWarning(t('storageUnavailable'));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, language, t]);

  const refreshStats = useCallback(async () => {
    try {
      setStats(await queueStats());
    } catch {
      setStorageStatus('unavailable');
      setStorageWarning(t('storageUnavailable'));
    }
  }, [t]);

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
        setStorageWarning(t('storageUnavailable'));
      }
      const cameraStatus: DeviceComponentStatus = cameraReady
        ? 'ready'
        : cameraError
          ? 'unavailable'
          : 'unknown';
      const health = { cameraStatus, storageStatus: effectiveStorageStatus };
      const beforeHeartbeat = await sendHeartbeat(token, before, cameraError ?? storageWarning, health);
      try {
        const result = await flushKioskQueue(token);
        setStats(result.stats);
        const heartbeatOk = await sendHeartbeat(token, result.stats, result.lastError ?? cameraError ?? storageWarning, health);
        setServerOnline(heartbeatOk || (beforeHeartbeat && result.serverReachable));
      } catch {
        setStorageStatus('unavailable');
        const heartbeatOk = await sendHeartbeat(token, null, 'local queue unavailable', {
          cameraStatus,
          storageStatus: 'unavailable',
        });
        setServerOnline(heartbeatOk);
      }
    } finally {
      setSyncing(false);
    }
  }, [token, cameraError, cameraReady, storageStatus, storageWarning, t]);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    void (async () => {
      try {
        await recoverProvisionalEvents();
        await refreshStats();
        const response = await kioskFetch('/api/punches/kiosk/self', {
          headers: { 'x-device-token': token },
        }, KIOSK_TIMEOUT_MS.self);
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
          setDeviceError(
            language === 'es'
              ? 'Este checador fue revocado o su token no es válido.'
              : 'This time clock was revoked or its token is invalid.'
          );
        }
      } catch {
        if (!cancelled) setServerOnline(false);
      }
      if (!cancelled) void syncNow();
    })();
    return () => {
      cancelled = true;
    };
  }, [token, refreshStats, syncNow, language]);

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
    setBusy(false);
    submittingRef.current = false;
  }, []);

  useEffect(() => {
    if (step.name === 'confirm' || step.name === 'error') {
      const timeout = window.setTimeout(reset, step.name === 'confirm' ? 5_500 : 5_000);
      return () => window.clearTimeout(timeout);
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
      context.save();
      context.translate(canvas.width, 0);
      context.scale(-1, 1);
      context.drawImage(video, 0, 0);
      context.restore();
      const photo = await canvasBlob(canvas);
      return photo ? { photo, status: 'captured' } : null;
    }

    context.fillStyle = '#111827';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#ef4444';
    context.font = 'bold 32px sans-serif';
    context.textAlign = 'center';
    context.fillText(t('cameraDiagnostic'), canvas.width / 2, canvas.height / 2 - 15);
    context.fillStyle = '#ffffff';
    context.font = '22px sans-serif';
    context.fillText(new Date().toISOString(), canvas.width / 2, canvas.height / 2 + 30);
    const photo = await canvasBlob(canvas);
    return photo ? { photo, status: 'camera_unavailable' } : null;
  }

  function showPendingConfirmation(
    event: QueuedEvent,
    employeeName: string | null,
    identityReview = true
  ): void {
    setStep({
      name: 'confirm',
      result: {
        employeeName: employeeName ?? `${t('employee')} ${event.payload.employeeNumber}`,
        punchType: event.payload.punchType,
        displayedTime: localDisplayTime(
          event.payload.capturedAt,
          device?.timezone ?? 'America/Los_Angeles',
          language
        ),
        pending: true,
        identityReview,
      },
    });
  }

  async function submitQueuedPunch(
    event: QueuedEvent,
    employeeName: string | null,
    identitySessionId: string | null,
    identityReview: boolean,
    bypassReason: 'camera_unavailable' | 'provider_unavailable' | 'offline' | null
  ): Promise<void> {
    if (!token) return;
    await setIdentityOutcome(token, event.id, identityReview ? 'identity_review' : 'verified', bypassReason);
    const persistedEvent = (await listQueuedEvents(token)).find((candidate) => candidate.id === event.id) ?? event;
    await markPending(event.id);
    await refreshStats();

    if (!navigator.onLine) {
      setServerOnline(false);
      showPendingConfirmation(persistedEvent, employeeName, true);
      return;
    }

    try {
      const response = await kioskFetch('/api/punches/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-device-token': token },
        body: JSON.stringify({
          employee_number: persistedEvent.payload.employeeNumber,
          source: 'kiosk',
          punch_type: persistedEvent.payload.punchType,
          client_event_id: persistedEvent.id,
          captured_at: persistedEvent.payload.capturedAt,
          client_sequence: persistedEvent.payload.clientSequence,
          evidence_status: persistedEvent.payload.evidenceStatus,
          client_installation_id: persistedEvent.payload.clientInstallationId,
          client_clock_skew_seconds: persistedEvent.payload.clientClockSkewSeconds,
          identity_session_id: identitySessionId ?? persistedEvent.payload.identitySessionId ?? undefined,
          identity_bypass_reason: bypassReason ?? persistedEvent.payload.identityBypassReason ?? undefined,
        }),
      }, KIOSK_TIMEOUT_MS.ingest);
      setServerOnline(true);
      const data = (await response.json().catch(() => ({}))) as Partial<IngestResponse>;
      if (response.status === 401) {
        await markRejected(event.id, '[device_unauthorized] Device credential rejected');
        await refreshStats();
        setDeviceError(
          language === 'es'
            ? 'Este checador fue revocado o su token no es válido.'
            : 'This time clock was revoked or its token is invalid.'
        );
        setStep({ name: 'error', message: t('protectedForReview') });
      } else if (response.status === 429 || response.status >= 500 || (response.ok && !data.punch_id)) {
        await markPending(event.id, data.error ?? 'Temporary or incomplete server response');
        await refreshStats();
        showPendingConfirmation(persistedEvent, employeeName, true);
      } else if (!response.ok) {
        await markRejected(event.id, `${data.code ? `[${data.code}] ` : ''}${data.error ?? `Validation ${response.status}`}`);
        await refreshStats();
        setStep({ name: 'error', message: t('protectedForReview') });
      } else {
        await acknowledgeEvent(token, event.id, {
          punchId: data.punch_id!,
          employeeName: data.employee_name,
          punchedAtLocal: data.punched_at_local,
          timezone: data.timezone,
        });
        await refreshStats();
        const review = data.identity_status
          ? data.identity_status === 'identity_review'
          : identityReview;
        setStep({
          name: 'confirm',
          result: {
            employeeName: data.employee_name ?? employeeName ?? `${t('employee')} ${persistedEvent.payload.employeeNumber}`,
            punchType: persistedEvent.payload.punchType,
            displayedTime:
              data.punched_at_local ??
              localDisplayTime(persistedEvent.payload.capturedAt, device?.timezone ?? 'America/Los_Angeles', language),
            pending: false,
            identityReview: review,
          },
        });
        void syncNow();
      }
    } catch {
      await markPending(event.id, 'Server unavailable');
      await refreshStats();
      setServerOnline(false);
      showPendingConfirmation(persistedEvent, employeeName, true);
    }
  }

  async function finishIdentity(
    identity: ActiveIdentity,
    verified: boolean,
    bypassReason: 'camera_unavailable' | 'provider_unavailable' | 'offline' | null = null
  ): Promise<void> {
    await submitQueuedPunch(
      identity.event,
      identity.employeeName,
      identity.sessionId || null,
      !verified,
      bypassReason
    );
  }

  async function sendIdentityAttempt(identity: ActiveIdentity, photo?: Blob): Promise<void> {
    if (!token || submittingRef.current) return;
    submittingRef.current = true;
    setBusy(true);
    try {
      const evidence = photo
        ? { photo, status: 'captured' as const }
        : await captureEvidence();
      if (!evidence) {
        await finishIdentity(identity, false, 'camera_unavailable');
        return;
      }
      if (evidence.status === 'camera_unavailable') {
        const attemptId = crypto.randomUUID();
        await prepareIdentityAttempt(token, identity.event.id, {
          attemptId,
          capturedAt: new Date().toISOString(),
          photo: evidence.photo,
          evidenceStatus: evidence.status,
        });
        await finishIdentity(identity, false, 'camera_unavailable');
        return;
      }

      const clientAttemptId = crypto.randomUUID();
      const attemptCapturedAt = new Date().toISOString();
      await prepareIdentityAttempt(token, identity.event.id, {
        attemptId: clientAttemptId,
        capturedAt: attemptCapturedAt,
        photo: evidence.photo,
        evidenceStatus: evidence.status,
      });
      const form = new FormData();
      form.append('client_attempt_id', clientAttemptId);
      form.append('captured_at', attemptCapturedAt);
      form.append('photo', evidence.photo, `${clientAttemptId}.jpg`);
      let response: Response;
      try {
        response = await retryIdentityTransport(() =>
          kioskFetch(
            `/api/punches/kiosk/identity/sessions/${encodeURIComponent(identity.sessionId)}/attempts`,
            { method: 'POST', headers: { 'x-device-token': token }, body: form },
            KIOSK_TIMEOUT_MS.identityAttempt
          )
        );
      } catch {
        await finishIdentity(identity, false, 'provider_unavailable');
        return;
      }
      const data = (await response.json().catch(() => ({}))) as Partial<IdentitySessionResponse>;
      if (!response.ok) {
        // Un 409 puede significar respuesta perdida con payload diferente; la
        // hora queda a revisión en lugar de pedir un cuarto intento.
        await finishIdentity(identity, false, 'provider_unavailable');
        return;
      }

      const rawResult = data.attempt?.result ?? (data.status === 'verified' ? 'match' : 'provider_error');
      const nextFlow = applyIdentityResult(identity.flow, normalizeIdentityAttemptResult(rawResult));
      const nextIdentity: ActiveIdentity = {
        ...identity,
        employeeName: data.employee_name ?? identity.employeeName,
        flow: nextFlow,
        message: nextFlow.status === 'retry' ? t('identityFailure') : null,
      };
      const disposition = serverIdentityDisposition(
        data.status ?? 'pending',
        data.next_action ?? 'punch',
        nextFlow
      );
      if (disposition === 'verified') {
        await finishIdentity(nextIdentity, true);
      } else if (disposition === 'review') {
        await finishIdentity(nextIdentity, false);
      } else {
        // Nunca se representa un cuarto intento, aunque un proveedor defectuoso
        // respondiera retry después de tres resultados consumibles.
        if (nextFlow.countedAttempts >= 3) await finishIdentity(nextIdentity, false);
        else setStep({ name: 'identity', identity: nextIdentity });
      }
    } finally {
      setBusy(false);
      submittingRef.current = false;
    }
  }

  async function beginIdentity(employeeNumber: string, punchType: PunchType): Promise<void> {
    if (!token || submittingRef.current) return;
    submittingRef.current = true;
    setBusy(true);
    const capturedAt = new Date().toISOString();
    const clientEventId = crypto.randomUUID();
    let event: QueuedEvent | null = null;
    try {
      if (storageStatus === 'unavailable') {
        setStep({ name: 'error', message: t('storageUnavailable') });
        return;
      }
      const evidence = await captureEvidence();
      if (!evidence) {
        setStep({ name: 'error', message: t('localSaveFailed') });
        return;
      }
      event = await enqueuePunch(token, {
        clientEventId,
        employeeNumber: Number(employeeNumber),
        punchType,
        capturedAt,
        photo: evidence.photo,
        evidenceStatus: evidence.status,
      });
      await refreshStats();

      const baseIdentity: ActiveIdentity = {
        event,
        employeeNumber,
        employeeName: null,
        punchType,
        sessionId: '',
        flow: INITIAL_IDENTITY_FLOW,
        message: null,
      };
      setStep({ name: 'identity', identity: baseIdentity });

      if (evidence.status === 'camera_unavailable') {
        await finishIdentity(baseIdentity, false, 'camera_unavailable');
        return;
      }
      if (!navigator.onLine) {
        await finishIdentity(baseIdentity, false, 'offline');
        return;
      }

      let response: Response;
      try {
        const sessionBody = JSON.stringify({
          employee_number: event.payload.employeeNumber,
          punch_type: event.payload.punchType,
          client_event_id: event.id,
          client_installation_id: event.payload.clientInstallationId,
          client_sequence: event.payload.clientSequence,
          captured_at: event.payload.capturedAt,
        });
        response = await retryIdentityTransport(() =>
          kioskFetch('/api/punches/kiosk/identity/sessions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-device-token': token },
            body: sessionBody,
          }, KIOSK_TIMEOUT_MS.identitySession)
        );
      } catch {
        await finishIdentity(baseIdentity, false, 'offline');
        return;
      }
      const data = (await response.json().catch(() => ({}))) as Partial<IdentitySessionResponse>;
      if (!response.ok || !data.session_id) {
        await finishIdentity(baseIdentity, false, response.status >= 500 ? 'provider_unavailable' : null);
        return;
      }

      await setIdentitySession(token, event.id, data.session_id);
      const identity: ActiveIdentity = {
        ...baseIdentity,
        employeeName: data.employee_name ?? null,
        sessionId: data.session_id,
      };
      if (data.status === 'verified') {
        await finishIdentity({ ...identity, flow: applyIdentityResult(identity.flow, 'match') }, true);
      } else if (data.next_action === 'punch' || data.status === 'review_required') {
        await finishIdentity(identity, false);
      } else {
        // Primera foto ya era durable; se reusa para el primer intento.
        submittingRef.current = false;
        await sendIdentityAttempt(identity, evidence.photo);
      }
    } catch {
      if (event) {
        await markPending(event.id, 'Identity flow interrupted');
        await refreshStats();
        showPendingConfirmation(event, null, true);
      } else {
        setStep({ name: 'error', message: t('localSaveFailed') });
      }
    } finally {
      setBusy(false);
      submittingRef.current = false;
    }
  }

  function pressDigit(digit: string): void {
    if (step.name === 'number' && numberInput.length < 6) setNumberInput(numberInput + digit);
  }

  function pressBack(): void {
    if (step.name === 'number') setNumberInput(numberInput.slice(0, -1));
  }

  const languageToggle = (
    <button
      onClick={toggleLanguage}
      className="rounded-control border border-kiosk-line px-3 py-2 text-13 font-bold text-kiosk-ink"
      aria-label={language === 'es' ? 'Switch to English' : 'Cambiar a español'}
    >
      {language === 'es' ? 'English' : 'Español'}
    </button>
  );

  if (enrollmentAttempt && !activationComplete) {
    return (
      <div className="relative flex min-h-screen items-center justify-center bg-kiosk-bg p-8 text-center text-kiosk-ink">
        <div className="absolute right-5 top-5">{languageToggle}</div>
        <div>
          <h1 className="font-display text-28 font-bold">{activating ? t('activating') : t('activationPending')}</h1>
          <p className="mt-4 max-w-lg text-16 text-kiosk-ink-dim">
            {activating ? t('activationChecking') : deviceError ?? t('activationFailed')}
          </p>
          {!activating && (
            <div className="mt-5 flex flex-col items-center gap-3">
              <button
                onClick={() => setActivationRetry((current) => current + 1)}
                className="rounded-control bg-accent px-5 py-3 text-15 font-semibold"
              >
                {t('retryActivation')}
              </button>
              {token && (
                <button
                  onClick={() => {
                    cancelEnrollmentAttempt();
                    window.location.reload();
                  }}
                  className="text-14 font-semibold text-kiosk-ink-dim underline underline-offset-4"
                >
                  {t('cancelActivation')}
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
      <div className="relative flex min-h-screen items-center justify-center bg-kiosk-bg p-8 text-center text-kiosk-ink">
        <div className="absolute right-5 top-5">{languageToggle}</div>
        <div>
          <h1 className="font-display text-28 font-bold">{t('kioskUnconfigured')}</h1>
          <p className="mt-4 max-w-lg text-16 text-kiosk-ink-dim">{deviceError ?? t('configureHelp')}</p>
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
          <p className="font-display text-18 font-bold text-kiosk-ink-dim">{t('brand')}</p>
          <p className="mt-1 truncate text-14 text-kiosk-ink-dim">
            {device ? `${device.name}${plantName ? ` · ${plantName}` : ''}` : t('verifyingDevice')}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-3 text-13 font-semibold">
            <span className={`inline-flex items-center gap-1.5 ${connected ? 'text-success' : 'text-warning'}`}>
              {connected ? <Wifi size={16} /> : <WifiOff size={16} />}
              {connected ? t('online') : t('offline')}
            </span>
            <span className={stats.pending ? 'text-warning' : 'text-kiosk-ink-dim'}>
              {stats.pending} {stats.pending === 1 ? t('pending') : t('pendingPlural')}
            </span>
            {stats.rejected > 0 && (
              <button
                className="text-danger underline decoration-danger/50 underline-offset-2"
                onClick={() => void retryRejectedEvents().then(refreshStats).then(syncNow)}
              >
                {stats.rejected} {stats.rejected === 1 ? t('rejected') : t('rejectedPlural')} · {t('retry')}
              </button>
            )}
            <button
              className="inline-flex items-center gap-1 text-kiosk-ink-dim disabled:opacity-50"
              disabled={syncing}
              onClick={() => void syncNow()}
            >
              <RefreshCw size={14} className={syncing ? 'animate-spin' : ''} /> {t('sync')}
            </button>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {languageToggle}
          <div className="relative">
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
                aria-label={t('retryCamera')}
              >
                <Camera size={28} />
              </button>
            )}
          </div>
        </div>
      </header>

      {(deviceError || cameraError || storageWarning) && (
        <div className="border-b border-danger/40 bg-danger/15 px-5 py-2 text-center text-13 font-semibold text-danger" role="alert">
          {deviceError ?? cameraError ?? storageWarning}
        </div>
      )}

      {step.name === 'confirm' ? (
        <Confirmation result={step.result} language={language} />
      ) : step.name === 'error' ? (
        <div className="flex flex-1 flex-col items-center justify-center px-8 text-center">
          <div className="flex h-20 w-20 items-center justify-center rounded-full bg-danger">
            <X size={44} strokeWidth={2.5} />
          </div>
          <h1 className="mt-8 font-display text-32 font-bold">{step.message}</h1>
        </div>
      ) : step.name === 'identity' ? (
        <IdentityVerification
          identity={step.identity}
          busy={busy}
          language={language}
          onRetry={() => void sendIdentityAttempt(step.identity)}
        />
      ) : step.name === 'action' ? (
        <ActionSelection
          employeeNumber={step.employeeNumber}
          language={language}
          busy={busy}
          onBack={() => setStep({ name: 'number' })}
          onSelect={(punchType) => void beginIdentity(step.employeeNumber, punchType)}
        />
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-5 px-6 pb-8 pt-4">
          <h1 className="text-22 font-semibold text-kiosk-ink-dim">{t('employeeNumber')}</h1>
          <div className="tnum flex h-20 min-w-72 items-center justify-center rounded-card border border-kiosk-line bg-kiosk-raised px-8 font-display text-56 font-bold tracking-widest">
            {numberInput || <span className="text-kiosk-line">···</span>}
          </div>
          <p className="h-7 text-center text-18 font-semibold text-kiosk-ink-dim">{busy ? t('savingEvidence') : ''}</p>
          <div className="grid w-full max-w-sm grid-cols-3 gap-3">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => (
              <Key key={digit} onPress={() => pressDigit(digit)} disabled={busy}>{digit}</Key>
            ))}
            <Key onPress={pressBack} muted disabled={busy} aria-label={language === 'es' ? 'Borrar' : 'Delete'}>
              <Delete size={30} strokeWidth={1.5} />
            </Key>
            <Key onPress={() => pressDigit('0')} disabled={busy}>0</Key>
            <button
              disabled={!numberInput || busy}
              onClick={() => setStep({ name: 'action', employeeNumber: numberInput })}
              className="flex h-20 items-center justify-center rounded-card bg-accent font-display text-26 font-bold transition-colors active:bg-accent-hover disabled:opacity-45"
            >
              OK
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ActionSelection({
  employeeNumber,
  language,
  busy,
  onSelect,
  onBack,
}: {
  employeeNumber: string;
  language: KioskLanguage;
  busy: boolean;
  onSelect: (type: PunchType) => void;
  onBack: () => void;
}) {
  const t = (key: KioskMessageKey) => kioskText(language, key);
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 py-8">
      <p className="text-16 font-semibold text-kiosk-ink-dim">{t('employee')} #{employeeNumber}</p>
      <h1 className="mt-2 font-display text-28 font-bold">{t('chooseAction')}</h1>
      <div className="mt-8 grid w-full max-w-2xl grid-cols-2 gap-4">
        {PUNCH_ACTIONS.map((action) => (
          <button
            key={action.type}
            disabled={busy}
            onClick={() => onSelect(action.type)}
            className={`flex min-h-32 items-center justify-center rounded-card border-2 px-4 text-center font-display text-24 font-bold transition-transform active:scale-[.98] disabled:opacity-50 ${action.accent}`}
          >
            {t(action.type)}
          </button>
        ))}
      </div>
      <button disabled={busy} onClick={onBack} className="mt-8 inline-flex items-center gap-2 text-18 font-semibold text-kiosk-ink-dim">
        <ChevronLeft size={22} /> {t('changeEmployee')}
      </button>
    </div>
  );
}

function IdentityVerification({
  identity,
  busy,
  language,
  onRetry,
}: {
  identity: ActiveIdentity;
  busy: boolean;
  language: KioskLanguage;
  onRetry: () => void;
}) {
  const t = (key: KioskMessageKey) => kioskText(language, key);
  const remaining = attemptsRemaining(identity.flow);
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-8 py-8 text-center">
      <div className="flex h-24 w-24 items-center justify-center rounded-full border-2 border-accent bg-accent/15">
        <Camera size={48} strokeWidth={1.8} className={busy ? 'animate-pulse' : ''} />
      </div>
      <p className="mt-5 text-16 font-semibold text-kiosk-ink-dim">
        {identity.employeeName ?? `${t('employee')} #${identity.employeeNumber}`} · {t(identity.punchType)}
      </p>
      <h1 className="mt-2 font-display text-32 font-bold">{t('verifyingFace')}</h1>
      <p className="mt-3 max-w-md text-18 text-kiosk-ink-dim">{identity.message ?? t('lookAtCamera')}</p>
      {identity.flow.countedAttempts > 0 && (
        <p className="mt-4 text-18 font-bold text-warning" role="status">
          {remaining} {remaining === 1 ? t('oneAttemptRemaining') : t('attemptsRemaining')}
        </p>
      )}
      <button
        disabled={busy}
        onClick={onRetry}
        className="mt-7 min-w-64 rounded-card bg-accent px-7 py-4 font-display text-20 font-bold disabled:opacity-50"
      >
        {busy ? t('savingEvidence') : identity.flow.status === 'retry' ? t('retryFace') : t('takePhoto')}
      </button>
      <p className="mt-5 inline-flex items-center gap-2 text-14 font-semibold text-kiosk-ink-dim">
        <ShieldCheck size={17} /> {language === 'es' ? 'La falla biométrica nunca impide registrar tu hora.' : 'A biometric failure never blocks your punch.'}
      </p>
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

function Confirmation({ result, language }: { result: ConfirmationResult; language: KioskLanguage }) {
  const t = (key: KioskMessageKey) => kioskText(language, key);
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-8 py-6 text-center">
      <div className={`kiosk-check flex h-24 w-24 items-center justify-center rounded-full ${result.pending ? 'bg-warning' : 'bg-success'}`}>
        {result.pending ? <Clock3 size={50} strokeWidth={2.5} /> : <Check size={52} strokeWidth={3} />}
      </div>
      <h1 className="mt-8 font-display text-36 font-bold leading-tight">{result.employeeName}</h1>
      <p className="mt-4 font-display text-24 font-bold text-kiosk-ink-dim">{t(result.punchType)}</p>
      <p className="tnum mt-3 font-display text-56 font-bold">{result.displayedTime}</p>
      {result.identityReview && (
        <div className="mt-5 inline-flex items-center gap-2 rounded-full bg-warning/20 px-4 py-2 text-15 font-bold text-warning">
          <ShieldCheck size={18} /> {t('reviewBadge')}
        </div>
      )}
      {result.pending ? (
        <div className="mt-5 rounded-card border border-warning/50 bg-warning/15 px-6 py-4">
          <p className="text-18 font-bold">{t('savedOffline')}</p>
          <p className="mt-1 text-15 text-kiosk-ink-dim">{t('pendingValidation')}</p>
        </div>
      ) : result.identityReview ? (
        <p className="mt-5 max-w-lg text-16 font-semibold text-warning">{t('identityReview')}</p>
      ) : (
        <div className="mt-5 text-16 font-semibold text-success">
          <p>{t('hoursRecorded')}</p>
          <p className="mt-1 text-14 text-kiosk-ink-dim">{t('evidencePending')}</p>
        </div>
      )}
    </div>
  );
}
