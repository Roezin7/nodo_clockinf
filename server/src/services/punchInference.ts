/**
 * Inferencia del tipo de checada por secuencia.
 *
 * Secuencia válida de un día: shift_in → (meal_out → meal_in)* → shift_out
 *
 * Reglas (sobre la última checada NO anulada del día local de planta):
 * 1. Sin checadas, o última = shift_out  → shift_in   (entra a trabajar / doble turno)
 * 2. Última = meal_out                   → meal_in    (regresa de comer)
 * 3. Última = shift_in o meal_in         → ambiguo: puede salir a comer o salir del turno.
 *    Se resuelve con las ventanas de comida del turno: si la hora local cae dentro de
 *    una ventana expandida (MEAL_MARGIN_MINUTES antes y después) → meal_out;
 *    fuera de toda ventana → shift_out.
 *    Si el turno no tiene ventanas de comida, siempre → shift_out.
 */
import { DateTime } from 'luxon';
import type { MealWindow, PunchType } from '../types.js';

export const MEAL_MARGIN_MINUTES = 30;

function toMinutes(hhmm: string): number {
  const [h = 0, m = 0] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/** ¿La hora local (minutos desde medianoche) cae en alguna ventana de comida expandida? */
export function inMealWindow(localMinutes: number, windows: MealWindow[], marginMinutes = MEAL_MARGIN_MINUTES): boolean {
  return windows.some((w) => {
    const start = toMinutes(w.start) - marginMinutes;
    const end = toMinutes(w.end) + marginMinutes;
    return localMinutes >= start && localMinutes <= end;
  });
}

export function inferPunchType(
  lastPunchType: PunchType | null,
  punchedAtUtc: Date,
  mealWindows: MealWindow[],
  timezone: string
): PunchType {
  switch (lastPunchType) {
    case null:
    case 'shift_out':
      return 'shift_in';
    case 'meal_out':
      return 'meal_in';
    case 'shift_in':
    case 'meal_in': {
      const local = DateTime.fromJSDate(punchedAtUtc, { zone: timezone });
      const localMinutes = local.hour * 60 + local.minute;
      return inMealWindow(localMinutes, mealWindows) ? 'meal_out' : 'shift_out';
    }
  }
}
