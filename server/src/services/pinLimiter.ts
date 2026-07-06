/**
 * Anti fuerza bruta del kiosco: 3 intentos de PIN fallidos por número de
 * empleado → bloqueo de 60 segundos. En memoria: un dedazo no castiga de más
 * y un reinicio del server solo resetea contadores.
 */
const MAX_ATTEMPTS = 3;
const LOCK_MS = 60_000;
const WINDOW_MS = 5 * 60_000;

interface Entry {
  fails: number;
  firstFailAt: number;
  lockedUntil: number;
}

const entries = new Map<number, Entry>();

/** Segundos restantes de bloqueo, o 0 si puede intentar. */
export function lockedForSeconds(employeeNumber: number, now = Date.now()): number {
  const e = entries.get(employeeNumber);
  if (!e) return 0;
  if (e.lockedUntil > now) return Math.ceil((e.lockedUntil - now) / 1000);
  return 0;
}

export function recordFailure(employeeNumber: number, now = Date.now()): void {
  const e = entries.get(employeeNumber);
  if (!e || now - e.firstFailAt > WINDOW_MS) {
    entries.set(employeeNumber, { fails: 1, firstFailAt: now, lockedUntil: 0 });
    return;
  }
  e.fails += 1;
  if (e.fails >= MAX_ATTEMPTS) {
    e.lockedUntil = now + LOCK_MS;
    e.fails = 0;
    e.firstFailAt = now;
  }
}

export function recordSuccess(employeeNumber: number): void {
  entries.delete(employeeNumber);
}
