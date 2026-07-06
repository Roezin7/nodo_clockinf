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
