import { describe, expect, it } from 'vitest';
import { computeDay, dropDuplicates, reconcileWeekOvertime, type EnginePunch } from './calcEngine.js';
import type { PunchType } from '../types.js';

const TZ = 'America/Mexico_City';
const DATE = '2026-07-06';

let seq = 0;
/** Checada a hora local de planta (CDMX = UTC−6 fijo). */
function punch(type: PunchType, hhmm: string): EnginePunch {
  return { id: `p${++seq}`, punch_type: type, punched_at: new Date(`${DATE}T${hhmm}:00-06:00`) };
}

const ctx = {
  employeeId: 'emp1',
  workDate: DATE,
  timezone: TZ,
  shiftStart: '07:00',
  toleranceMinutes: 5,
  duplicateWindowMinutes: 2,
};

describe('computeDay — día normal', () => {
  it('entrada, comida de 30min, salida: 9.5h trabajadas, sin anomalías', () => {
    const day = computeDay(
      [punch('shift_in', '07:00'), punch('meal_out', '13:00'), punch('meal_in', '13:30'), punch('shift_out', '17:00')],
      ctx
    );
    expect(day.worked_minutes).toBe(9 * 60 + 30); // 10h − 30min comida
    expect(day.meal_minutes).toBe(30);
    expect(day.late).toBe(false);
    expect(day.complete).toBe(true);
    expect(day.anomalies).toHaveLength(0);
  });

  it('entrada dentro de tolerancia (07:04) no es retardo', () => {
    const day = computeDay([punch('shift_in', '07:04'), punch('shift_out', '17:00')], ctx);
    expect(day.late).toBe(false);
  });

  it('entrada 07:06 es retardo de 6 minutos', () => {
    const day = computeDay([punch('shift_in', '07:06'), punch('shift_out', '17:00')], ctx);
    expect(day.late).toBe(true);
    expect(day.late_minutes).toBe(6);
  });
});

describe('computeDay — overtime diario', () => {
  it('día de 11h trabajadas se reporta completo; el OT lo decide la reconciliación', () => {
    const day = computeDay(
      [punch('shift_in', '06:00'), punch('meal_out', '13:00'), punch('meal_in', '13:30'), punch('shift_out', '17:30')],
      ctx
    );
    expect(day.worked_minutes).toBe(11 * 60); // 11.5h − 30min
    const { regular_minutes, overtime_minutes } = reconcileWeekOvertime([day.worked_minutes], 8 * 60, 48 * 60);
    expect(regular_minutes).toBe(8 * 60);
    expect(overtime_minutes).toBe(3 * 60);
  });
});

describe('computeDay — comida sin regreso', () => {
  it('meal_out sin meal_in al final del día → incompleto con anomalía', () => {
    const day = computeDay([punch('shift_in', '07:00'), punch('meal_out', '13:00')], ctx);
    expect(day.complete).toBe(false);
    expect(day.anomalies.map((a) => a.type)).toContain('missing_meal_in');
    // Solo cuenta lo trabajado hasta salir a comer
    expect(day.worked_minutes).toBe(6 * 60);
  });

  it('shift_out directo estando en comida → anomalía, comida no descontable', () => {
    const day = computeDay(
      [punch('shift_in', '07:00'), punch('meal_out', '13:00'), punch('shift_out', '17:00')],
      ctx
    );
    expect(day.complete).toBe(false);
    expect(day.anomalies.map((a) => a.type)).toContain('missing_meal_in');
    expect(day.worked_minutes).toBe(6 * 60); // 07:00→13:00
  });
});

describe('computeDay — falta shift_out', () => {
  it('se quedó adentro → incompleto', () => {
    const day = computeDay([punch('shift_in', '07:00')], ctx);
    expect(day.complete).toBe(false);
    expect(day.anomalies.map((a) => a.type)).toContain('missing_shift_out');
    expect(day.worked_minutes).toBe(0);
  });
});

describe('computeDay — doble checada', () => {
  it('mismo tipo con <2 min se ignora la segunda', () => {
    const day = computeDay(
      [
        punch('shift_in', '07:00'),
        { id: 'dup', punch_type: 'shift_in', punched_at: new Date(`${DATE}T07:01:30-06:00`) },
        punch('shift_out', '17:00'),
      ],
      ctx
    );
    expect(day.complete).toBe(true);
    expect(day.anomalies).toHaveLength(0);
    expect(day.worked_minutes).toBe(10 * 60);
  });

  it('dropDuplicates conserva la primera de cada ráfaga', () => {
    const result = dropDuplicates(
      [
        punch('shift_in', '07:00'),
        { id: 'd1', punch_type: 'shift_in', punched_at: new Date(`${DATE}T07:00:40-06:00`) },
        { id: 'd2', punch_type: 'shift_in', punched_at: new Date(`${DATE}T07:01:20-06:00`) },
      ],
      2
    );
    expect(result).toHaveLength(1);
  });
});

describe('computeDay — fuera de secuencia', () => {
  it('meal_in sin meal_out se reporta y se ignora', () => {
    const day = computeDay(
      [punch('shift_in', '07:00'), punch('meal_in', '13:30'), punch('shift_out', '17:00')],
      ctx
    );
    expect(day.anomalies.map((a) => a.type)).toContain('out_of_sequence');
    expect(day.complete).toBe(false);
    expect(day.worked_minutes).toBe(10 * 60);
  });
});

describe('computeDay — corrección', () => {
  it('con la checada errónea anulada (excluida) y la manual agregada, el día queda limpio', () => {
    // El empleado olvidó checar salida; el admin anula nada y agrega shift_out manual 17:00.
    // El motor solo recibe checadas NO anuladas: la corrección es transparente.
    const corrected = computeDay(
      [punch('shift_in', '07:00'), punch('meal_out', '13:00'), punch('meal_in', '13:30'), punch('shift_out', '17:00')],
      ctx
    );
    expect(corrected.complete).toBe(true);
    expect(corrected.worked_minutes).toBe(9 * 60 + 30);
  });

  it('doble turno (dos ciclos in/out) suma ambos segmentos', () => {
    const day = computeDay(
      [
        punch('shift_in', '07:00'),
        punch('shift_out', '12:00'),
        punch('shift_in', '17:00'),
        punch('shift_out', '21:00'),
      ],
      ctx
    );
    expect(day.complete).toBe(true);
    expect(day.worked_minutes).toBe(9 * 60);
  });
});

describe('reconcileWeekOvertime', () => {
  const D = 8 * 60;
  const W = 48 * 60;

  it('semana sin excedentes: todo regular', () => {
    const r = reconcileWeekOvertime([480, 480, 480, 480, 480], D, W);
    expect(r.regular_minutes).toBe(2400);
    expect(r.overtime_minutes).toBe(0);
  });

  it('OT diario sin exceder semana', () => {
    const r = reconcileWeekOvertime([600, 480, 480], D, W); // 10h un día
    expect(r.regular_minutes).toBe(1440);
    expect(r.overtime_minutes).toBe(120);
  });

  it('OT semanal sin OT diario (6 días de 8h = 48h + 1 día 8h)', () => {
    const r = reconcileWeekOvertime([480, 480, 480, 480, 480, 480, 480], D, W);
    expect(r.regular_minutes).toBe(W);
    expect(r.overtime_minutes).toBe(480);
  });

  it('sin doble conteo: el excedente diario no vuelve a contar en el semanal', () => {
    // 6 días de 10h: 12h OT diario; regular acumulado 48h = umbral, sin extra semanal
    const r = reconcileWeekOvertime(Array(6).fill(600), D, W);
    expect(r.overtime_minutes).toBe(6 * 120);
    expect(r.regular_minutes).toBe(W);
    expect(r.regular_minutes + r.overtime_minutes).toBe(6 * 600);
  });

  it('umbrales configurables', () => {
    const r = reconcileWeekOvertime([540], 9 * 60, W);
    expect(r.overtime_minutes).toBe(0);
  });
});
