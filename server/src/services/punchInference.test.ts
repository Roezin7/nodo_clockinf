import { describe, expect, it } from 'vitest';
import { inferPunchType, inMealWindow } from './punchInference.js';
import type { MealWindow } from '../types.js';

const TZ = 'America/Mexico_City';
const MEALS: MealWindow[] = [{ name: 'Comida', start: '13:00', end: '13:30', paid: false }];

/** Instante UTC que corresponde a una hora local de planta (CST, UTC-6 sin DST desde 2022 en MX). */
function localTime(hhmm: string): Date {
  return new Date(`2026-07-06T${hhmm}:00-06:00`);
}

describe('inferPunchType — secuencia', () => {
  it('sin checadas en el día → shift_in', () => {
    expect(inferPunchType(null, localTime('06:55'), MEALS, TZ)).toBe('shift_in');
  });

  it('última shift_out → shift_in (doble turno)', () => {
    expect(inferPunchType('shift_out', localTime('17:05'), MEALS, TZ)).toBe('shift_in');
  });

  it('última meal_out → meal_in (regresa de comer)', () => {
    expect(inferPunchType('meal_out', localTime('13:35'), MEALS, TZ)).toBe('meal_in');
  });

  it('última shift_in + hora dentro de ventana de comida → meal_out', () => {
    expect(inferPunchType('shift_in', localTime('13:05'), MEALS, TZ)).toBe('meal_out');
  });

  it('última shift_in + margen de 30min antes de la ventana → meal_out', () => {
    expect(inferPunchType('shift_in', localTime('12:35'), MEALS, TZ)).toBe('meal_out');
  });

  it('última shift_in + fuera de ventana de comida → shift_out', () => {
    expect(inferPunchType('shift_in', localTime('17:02'), MEALS, TZ)).toBe('shift_out');
  });

  it('última meal_in + fuera de ventana → shift_out', () => {
    expect(inferPunchType('meal_in', localTime('17:00'), MEALS, TZ)).toBe('shift_out');
  });

  it('turno sin ventanas de comida: después de shift_in siempre shift_out', () => {
    expect(inferPunchType('shift_in', localTime('13:05'), [], TZ)).toBe('shift_out');
  });
});

describe('inMealWindow', () => {
  it('respeta el margen configurado', () => {
    expect(inMealWindow(13 * 60 + 15, MEALS)).toBe(true);
    expect(inMealWindow(12 * 60 + 29, MEALS)).toBe(false); // 12:29 < 13:00−30min
    expect(inMealWindow(14 * 60 + 1, MEALS)).toBe(false); // 14:01 > 13:30+30min
  });
});
