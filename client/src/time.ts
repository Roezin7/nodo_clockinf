/**
 * Zona horaria de la planta — ÚNICA fuente para formatear fechas/horas en la UI.
 *
 * Regla: NUNCA usar new Date().toLocaleTimeString() sin timeZone, ni hardcodear
 * una zona. Siempre importar fmtTime/fmtDateTime/todayLocal de este módulo.
 * La zona viene de /api/settings (el servidor manda la misma que usa para
 * calcular reportes), así el kiosco, la asistencia y el reporte siempre
 * muestran la misma hora.
 */
import { useSyncExternalStore } from 'react';

let currentTz = 'America/Mexico_City'; // provisional hasta cargar settings
const listeners = new Set<() => void>();

export function setAppTimezone(tz: string): void {
  if (tz && tz !== currentTz) {
    currentTz = tz;
    listeners.forEach((l) => l());
  }
}

export function getAppTimezone(): string {
  return currentTz;
}

/** Hook: re-renderiza la página cuando cambia la zona en Configuración. */
export function useAppTimezone(): string {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => currentTz
  );
}

/** 'HH:mm' local de planta. */
export function fmtTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('es-MX', {
    timeZone: currentTz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/** 'dd mmm HH:mm' local de planta. */
export function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString('es-MX', {
    timeZone: currentTz,
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/** 'YYYY-MM-DD' de hoy en la zona de la planta. */
export function todayLocal(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: currentTz }).format(new Date());
}
