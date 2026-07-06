import { DateTime } from 'luxon';

/** Fecha local de planta ('YYYY-MM-DD') de un instante UTC. */
export function workDateOf(utc: Date, timezone: string): string {
  return DateTime.fromJSDate(utc, { zone: timezone }).toISODate()!;
}

/** Límites UTC del día local de planta que contiene el instante dado. */
export function localDayBoundsUtc(utc: Date, timezone: string): { startUtc: Date; endUtc: Date; workDate: string } {
  const local = DateTime.fromJSDate(utc, { zone: timezone });
  return {
    startUtc: local.startOf('day').toUTC().toJSDate(),
    endUtc: local.endOf('day').toUTC().toJSDate(),
    workDate: local.toISODate()!,
  };
}

/** Límites UTC de una fecha local 'YYYY-MM-DD'. */
export function dateBoundsUtc(workDate: string, timezone: string): { startUtc: Date; endUtc: Date } {
  const local = DateTime.fromISO(workDate, { zone: timezone });
  return {
    startUtc: local.startOf('day').toUTC().toJSDate(),
    endUtc: local.endOf('day').toUTC().toJSDate(),
  };
}

/** Fecha local de hoy en la zona de la planta. */
export function todayLocal(timezone: string): string {
  return DateTime.now().setZone(timezone).toISODate()!;
}

/** 'HH:mm' local de planta de un instante UTC — TODA hora mostrada sale de aquí. */
export function formatLocalTime(utc: Date, timezone: string): string {
  return DateTime.fromJSDate(utc, { zone: timezone }).toFormat('HH:mm');
}

/** Interpreta 'YYYY-MM-DDTHH:mm' como hora local de planta y regresa el instante UTC. */
export function localToUtc(localDateTime: string, timezone: string): Date {
  const dt = DateTime.fromISO(localDateTime, { zone: timezone });
  if (!dt.isValid) throw new Error(`Fecha/hora local inválida: ${localDateTime}`);
  return dt.toUTC().toJSDate();
}
