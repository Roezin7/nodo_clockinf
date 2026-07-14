import type { PunchType } from '@clockai/shared';

export const DEMO_DATASET_ID = 'nodo-proposal-fixtures-v1';
export const DEMO_EMPLOYEES = Object.freeze([
  { id: 'demo-ana', number: 1042, name: 'Ana Rivera' },
  { id: 'demo-luis', number: 1071, name: 'Luis Vega' },
  { id: 'demo-maria', number: 1088, name: 'María Soto' },
]);

export const DEMO_ACTIONS: ReadonlyArray<{ type: PunchType; label: string; labelEn: string }> = [
  { type: 'shift_in', label: 'Entrada', labelEn: 'Clock in' },
  { type: 'meal_out', label: 'Salida a comida', labelEn: 'Start meal' },
  { type: 'meal_in', label: 'Regreso de comida', labelEn: 'End meal' },
  { type: 'shift_out', label: 'Salida', labelEn: 'Clock out' },
];

export function findDemoEmployeeByNumber(number: string) {
  return DEMO_EMPLOYEES.find((employee) => String(employee.number) === number.trim());
}

export function getDemoActionLabel(type: PunchType, language: 'es' | 'en'): string {
  const action = DEMO_ACTIONS.find((candidate) => candidate.type === type);
  return language === 'en' ? action?.labelEn ?? type : action?.label ?? type;
}

export const WEEK_EVENTS = Object.freeze([
  ['Lunes · 5:00 AM', 'Entrada y comida', 'La estación registra entrada, salida y regreso de comida en una sola secuencia.'],
  ['Martes', 'Cambio temporal de planta', 'La estación asigna la planta correcta sin depender de mensajes externos.'],
  ['Miércoles', 'Internet interrumpido', 'La checada queda en cola local y se sincroniza en orden al recuperar conexión.'],
  ['Jueves', 'Incidencia y corrección', 'El foreman explica el motivo; el evento original permanece en auditoría.'],
  ['Domingo', 'Cierre para la contadora', 'Se congela una versión verificable y se exporta XLSX o CSV.'],
] as const);

export const DEMO_API_ALLOWLIST = Object.freeze(['/api/proposals/']);

export interface LocalDemoPunch {
  id: string;
  employeeId: string;
  action: PunchType;
  capturedAt: string;
  state: 'synced' | 'pending';
}
