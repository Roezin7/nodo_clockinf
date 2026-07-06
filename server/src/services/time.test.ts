/**
 * Invariante de zona horaria: TODA hora que ve el usuario (kiosco, asistencia,
 * reporte, export) sale de formatLocalTime/workDateOf con la MISMA zona de
 * settings. Estos tests fijan ese contrato en todas las zonas permitidas.
 */
import { describe, expect, it } from 'vitest';
import { formatLocalTime, localDayBoundsUtc, localToUtc, todayLocal, workDateOf } from './time.js';

const ZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Phoenix',
  'America/Los_Angeles',
  'America/Anchorage',
  'Pacific/Honolulu',
  'America/Mexico_City',
];

describe('formatLocalTime — una sola fuente de verdad para la hora mostrada', () => {
  // 2026-07-06 22:00 UTC en cada zona (julio = horario de verano en las que aplican DST)
  const instant = new Date('2026-07-06T22:00:00Z');
  const expected: Record<string, string> = {
    'America/New_York': '18:00', // EDT −4
    'America/Chicago': '17:00', // CDT −5
    'America/Denver': '16:00', // MDT −6
    'America/Phoenix': '15:00', // MST −7 (sin DST)
    'America/Los_Angeles': '15:00', // PDT −7
    'America/Anchorage': '14:00', // AKDT −8
    'Pacific/Honolulu': '12:00', // HST −10
    'America/Mexico_City': '16:00', // CST −6 (sin DST desde 2022)
  };

  for (const zone of ZONES) {
    it(`${zone} → ${expected[zone]}`, () => {
      expect(formatLocalTime(instant, zone)).toBe(expected[zone]);
    });
  }
});

describe('ida y vuelta: la hora capturada es la hora reportada', () => {
  for (const zone of ZONES) {
    it(`localToUtc ∘ formatLocalTime es identidad en ${zone}`, () => {
      const utc = localToUtc('2026-07-06T17:00', zone);
      expect(formatLocalTime(utc, zone)).toBe('17:00');
      expect(workDateOf(utc, zone)).toBe('2026-07-06');
    });
  }

  it('rechaza hora local inválida', () => {
    expect(() => localToUtc('2026-13-99T99:99', 'America/Chicago')).toThrow();
  });
});

describe('cortes de día: una checada nocturna cae en el día local correcto', () => {
  it('23:30 en Denver es el mismo día local aunque en UTC ya sea mañana', () => {
    const utc = localToUtc('2026-07-06T23:30', 'America/Denver'); // = 07-07 05:30 UTC
    expect(utc.toISOString()).toBe('2026-07-07T05:30:00.000Z');
    expect(workDateOf(utc, 'America/Denver')).toBe('2026-07-06');
  });

  it('la misma checada UTC cae en días distintos según la zona configurada', () => {
    const utc = new Date('2026-07-07T05:30:00Z');
    expect(workDateOf(utc, 'America/Denver')).toBe('2026-07-06'); // 23:30 del 6
    expect(workDateOf(utc, 'America/New_York')).toBe('2026-07-07'); // 01:30 del 7
  });

  it('localDayBoundsUtc y workDateOf son consistentes entre sí', () => {
    for (const zone of ZONES) {
      const now = new Date('2026-07-06T22:00:00Z');
      const { startUtc, endUtc, workDate } = localDayBoundsUtc(now, zone);
      expect(workDateOf(startUtc, zone)).toBe(workDate);
      expect(workDateOf(endUtc, zone)).toBe(workDate);
      expect(workDateOf(now, zone)).toBe(workDate);
    }
  });

  it('todayLocal coincide con workDateOf(ahora)', () => {
    for (const zone of ZONES) {
      expect(todayLocal(zone)).toBe(workDateOf(new Date(), zone));
    }
  });
});

describe('DST: el cambio de horario no rompe el corte de día', () => {
  it('día del cambio a horario de verano en Chicago (2026-03-08, 23h)', () => {
    // 02:00→03:00: el día tiene 23 horas pero sigue siendo un solo work_date
    const { startUtc, endUtc, workDate } = localDayBoundsUtc(
      localToUtc('2026-03-08T12:00', 'America/Chicago'),
      'America/Chicago'
    );
    expect(workDate).toBe('2026-03-08');
    const hours = (endUtc.getTime() - startUtc.getTime()) / 3_600_000;
    expect(Math.round(hours)).toBe(23);
  });

  it('Phoenix no tiene DST: siempre 24h', () => {
    const { startUtc, endUtc } = localDayBoundsUtc(
      localToUtc('2026-03-08T12:00', 'America/Phoenix'),
      'America/Phoenix'
    );
    expect((endUtc.getTime() - startUtc.getTime()) / 3_600_000).toBeCloseTo(24, 1);
  });
});
