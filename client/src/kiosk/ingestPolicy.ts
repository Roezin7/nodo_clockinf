/** Sólo este código confirma que el 429 pertenece al bloqueo de PIN. */
export function isConfirmedPinLock(status: number, code: string | undefined): boolean {
  return status === 429 && code === 'pin_locked';
}

