/**
 * Motor de cálculo de horas — el corazón del sistema.
 *
 * Funciones PURAS sobre checadas crudas: cualquier reporte puede regenerarse
 * desde el log y dar el mismo resultado. Nada de aquí se almacena como valor
 * editable.
 *
 * Reglas:
 * - Tiempo neto = Σ(shift_out − shift_in) − Σ(meal_in − meal_out), al segundo.
 * - Duplicados (mismo tipo, < ventana) se ignoran automáticamente.
 * - Checadas fuera de secuencia se reportan como anomalía y se excluyen.
 * - Falta shift_out o meal_in → día incompleto (requiere corrección admin).
 * La clasificación California vive exclusivamente en californiaOvertime.ts.
 */
import { DateTime } from 'luxon';
import type { Anomaly, DayCalc, PunchType } from '../types.js';

export interface EnginePunch {
  id: string;
  punch_type: PunchType;
  punched_at: Date;
}

export interface DayContext {
  employeeId: string;
  workDate: string; // 'YYYY-MM-DD' local de planta
  timezone: string;
  /** Inicio del turno 'HH:MM' o 'HH:MM:SS' (para retardo); sin turno → sin flag. */
  shiftStart?: string | null;
  toleranceMinutes?: number;
  duplicateWindowMinutes?: number;
}

/**
 * Elimina duplicados: mismo tipo con menos de `windowMinutes` respecto a la
 * checada anterior conservada del mismo tipo → se ignora la segunda.
 */
export function dropDuplicates(punches: EnginePunch[], windowMinutes: number): EnginePunch[] {
  const kept: EnginePunch[] = [];
  for (const p of [...punches].sort((a, b) => a.punched_at.getTime() - b.punched_at.getTime())) {
    const prev = kept[kept.length - 1];
    if (
      prev &&
      prev.punch_type === p.punch_type &&
      p.punched_at.getTime() - prev.punched_at.getTime() < windowMinutes * 60_000
    ) {
      continue;
    }
    kept.push(p);
  }
  return kept;
}

export function computeDay(punches: EnginePunch[], ctx: DayContext): DayCalc {
  const anomalies: Anomaly[] = [];
  const clean = dropDuplicates(punches, ctx.duplicateWindowMinutes ?? 2);

  // Máquina de estados sobre la secuencia shift_in → (meal_out → meal_in)* → shift_out
  type State = 'out' | 'in' | 'meal';
  let state: State = 'out';
  let currentShiftIn: Date | null = null;
  let currentMealOut: Date | null = null;
  let firstShiftIn: Date | null = null;
  let lastShiftOut: Date | null = null;
  let workedMs = 0;
  let mealMs = 0; // total de comidas cerradas (para reporte)
  let segmentMealMs = 0; // comidas dentro del segmento de turno abierto (para descontar)
  let openMealAnomaly = false;
  let openShiftAnomaly = false;

  const anomaly = (type: Anomaly['type'], punchId: string | null, detail: string): void => {
    anomalies.push({ type, employee_id: ctx.employeeId, work_date: ctx.workDate, punch_id: punchId, detail });
  };

  for (const p of clean) {
    switch (p.punch_type) {
      case 'shift_in':
        if (state !== 'out') {
          anomaly('out_of_sequence', p.id, `shift_in con estado ${state}; se ignora`);
          continue;
        }
        state = 'in';
        currentShiftIn = p.punched_at;
        segmentMealMs = 0;
        firstShiftIn ??= p.punched_at;
        break;
      case 'meal_out':
        if (state !== 'in') {
          anomaly('out_of_sequence', p.id, `meal_out con estado ${state}; se ignora`);
          continue;
        }
        state = 'meal';
        currentMealOut = p.punched_at;
        break;
      case 'meal_in':
        if (state !== 'meal' || !currentMealOut) {
          anomaly('out_of_sequence', p.id, `meal_in con estado ${state}; se ignora`);
          continue;
        }
        state = 'in';
        mealMs += p.punched_at.getTime() - currentMealOut.getTime();
        segmentMealMs += p.punched_at.getTime() - currentMealOut.getTime();
        currentMealOut = null;
        break;
      case 'shift_out':
        if (state === 'meal') {
          // Salió del turno sin regresar de comer: cerramos el turno pero el
          // tiempo desde meal_out no cuenta; queda la anomalía de comida.
          anomaly('missing_meal_in', p.id, 'shift_out sin regresar de comer');
          openMealAnomaly = true;
          if (currentShiftIn && currentMealOut) {
            workedMs += currentMealOut.getTime() - currentShiftIn.getTime() - segmentMealMs;
          }
          state = 'out';
          lastShiftOut = p.punched_at;
          currentShiftIn = null;
          currentMealOut = null;
          continue;
        }
        if (state !== 'in' || !currentShiftIn) {
          anomaly('out_of_sequence', p.id, `shift_out con estado ${state}; se ignora`);
          continue;
        }
        state = 'out';
        workedMs += p.punched_at.getTime() - currentShiftIn.getTime() - segmentMealMs;
        lastShiftOut = p.punched_at;
        currentShiftIn = null;
        break;
    }
  }

  // Estado final del día
  if (state === 'meal' && currentMealOut && currentShiftIn) {
    anomaly('missing_meal_in', null, 'no regresó de comer (falta meal_in)');
    openMealAnomaly = true;
    // Lo trabajado hasta salir a comer sí se acumula parcialmente
    workedMs += currentMealOut.getTime() - currentShiftIn.getTime() - segmentMealMs;
  } else if (state === 'in' && currentShiftIn) {
    anomaly('missing_shift_out', null, 'sin salida de turno (falta shift_out)');
    openShiftAnomaly = true;
  }

  const workedSeconds = Math.max(0, Math.round(workedMs / 1000));
  const mealSeconds = Math.max(0, Math.round(mealMs / 1000));
  const workedMinutes = workedSeconds / 60;
  const mealMinutes = mealSeconds / 60;

  // Retardo sobre el primer shift_in del día
  let late = false;
  let lateMinutes = 0;
  if (firstShiftIn && ctx.shiftStart) {
    const [h = 0, m = 0] = ctx.shiftStart.split(':').map(Number);
    const shiftStartLocal = DateTime.fromISO(ctx.workDate, { zone: ctx.timezone }).set({ hour: h, minute: m });
    const limit = shiftStartLocal.plus({ minutes: ctx.toleranceMinutes ?? 5 });
    const inLocal = DateTime.fromJSDate(firstShiftIn, { zone: ctx.timezone });
    if (inLocal > limit) {
      late = true;
      lateMinutes = Math.ceil(inLocal.diff(shiftStartLocal, 'minutes').minutes);
    }
  }

  const hasSequenceAnomaly = anomalies.some((a) => a.type === 'out_of_sequence');

  return {
    employee_id: ctx.employeeId,
    work_date: ctx.workDate,
    shift_in: firstShiftIn?.toISOString() ?? null,
    shift_out: lastShiftOut?.toISOString() ?? null,
    meal_minutes: mealMinutes,
    worked_minutes: workedMinutes,
    meal_seconds: mealSeconds,
    worked_seconds: workedSeconds,
    late,
    late_minutes: lateMinutes,
    complete: !openMealAnomaly && !openShiftAnomaly && !hasSequenceAnomaly && firstShiftIn !== null,
    state,
    anomalies,
  };
}
