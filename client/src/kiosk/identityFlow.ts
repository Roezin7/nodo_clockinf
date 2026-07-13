/**
 * La máquina biométrica es intencionalmente pura: la UI y la red pueden
 * reintentarse sin alterar la regla contractual de exactamente tres fallas.
 */
export const COUNTED_IDENTITY_FAILURES = [
  'no_match',
  'no_face',
  'multiple_faces',
  'quality_failed',
  'liveness_failed',
] as const;

export type CountedIdentityFailure = (typeof COUNTED_IDENTITY_FAILURES)[number];
export type IdentityAttemptResult =
  | 'match'
  | CountedIdentityFailure
  | 'provider_error'
  | 'timeout'
  | 'offline'
  | 'not_enrolled'
  | 'camera_unavailable'
  | 'server_unavailable';

/** Resultados que el proveedor/backend puede usar para declarar fallback. */
export type IdentityFallbackResult =
  | 'review_only'
  | 'incomplete_fallback'
  | 'review_required';

export function normalizeIdentityAttemptResult(value: unknown): IdentityAttemptResult {
  if (value === 'no_enrollment') return 'not_enrolled';
  if (value === 'provider_unavailable') return 'server_unavailable';
  if (value === 'review_only' || value === 'incomplete_fallback' || value === 'review_required') {
    return 'provider_error';
  }
  const known: readonly IdentityAttemptResult[] = [
    'match',
    ...COUNTED_IDENTITY_FAILURES,
    'provider_error',
    'timeout',
    'offline',
    'not_enrolled',
    'camera_unavailable',
    'server_unavailable',
  ];
  return typeof value === 'string' && (known as readonly string[]).includes(value)
    ? (value as IdentityAttemptResult)
    : 'provider_error';
}

export interface IdentityFlowState {
  countedAttempts: number;
  status: 'verifying' | 'retry' | 'verified' | 'review';
  reason: IdentityAttemptResult | null;
}

export const INITIAL_IDENTITY_FLOW: IdentityFlowState = {
  countedAttempts: 0,
  status: 'verifying',
  reason: null,
};

export function isCountedIdentityFailure(
  result: IdentityAttemptResult
): result is CountedIdentityFailure {
  return (COUNTED_IDENTITY_FAILURES as readonly string[]).includes(result);
}

export function applyIdentityResult(
  current: IdentityFlowState,
  result: IdentityAttemptResult
): IdentityFlowState {
  if (current.status === 'verified' || current.status === 'review') return current;
  if (result === 'match') {
    return { ...current, status: 'verified', reason: result };
  }
  if (!isCountedIdentityFailure(result)) {
    // Fallas técnicas y modo offline nunca consumen los tres intentos ni
    // impiden registrar la hora: se envían directamente a revisión humana.
    return { ...current, status: 'review', reason: result };
  }
  const countedAttempts = Math.min(3, current.countedAttempts + 1);
  return {
    countedAttempts,
    status: countedAttempts === 3 ? 'review' : 'retry',
    reason: result,
  };
}

export function attemptsRemaining(state: IdentityFlowState): number {
  return Math.max(0, 3 - state.countedAttempts);
}

/** El servidor es la única fuente que puede declarar identidad verificada. */
export function serverIdentityDisposition(
  serverStatus: 'pending' | 'verified' | 'review_required',
  nextAction: 'capture' | 'punch',
  localState: IdentityFlowState
): 'verified' | 'retry' | 'review' {
  if (serverStatus === 'verified') return 'verified';
  if (serverStatus === 'review_required' || nextAction === 'punch') return 'review';
  if (localState.status === 'retry' && localState.countedAttempts < 3) return 'retry';
  // Incluye match local con sesión aún pending: nunca elevar privilegios con
  // una respuesta parcial o con un proveedor sin prueba de vivacidad.
  return 'review';
}
