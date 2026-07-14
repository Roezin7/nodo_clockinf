import type { PunchType } from '@clockai/shared';

export const DEMO_DATASET_ID = 'nodo-proposal-fixtures-v1';
export const DEMO_EMPLOYEES = Object.freeze([
  { id: 'demo-ana', number: 1042, name: 'Ana Rivera' },
  { id: 'demo-luis', number: 1071, name: 'Luis Vega' },
  { id: 'demo-maria', number: 1088, name: 'María Soto' },
]);

export const DEMO_ACTIONS: ReadonlyArray<{ type: PunchType; label: string }> = [
  { type: 'shift_in', label: 'Entrada' },
  { type: 'meal_out', label: 'Salida a comida' },
  { type: 'meal_in', label: 'Regreso de comida' },
  { type: 'shift_out', label: 'Salida' },
];

export const WEEK_EVENTS = Object.freeze([
  ['Lunes · 5:00 AM', 'Ana registra entrada', 'La estación confirma el evento.'],
  ['Lunes · 9:00 AM', 'Salida a comida', 'La secuencia permanece abierta y visible.'],
  ['Lunes · 9:30 AM', 'Regreso de comida', 'El descanso queda asociado a la jornada.'],
  ['Martes', 'Luis trabaja temporalmente en Planta Norte', 'La estación determina la planta; el empleado no la elige.'],
  ['Miércoles', 'La estación pierde internet', 'La checada se conserva cifrada en la cola local.'],
  ['Miércoles · minutos después', 'Regresa la conexión', 'Los eventos se sincronizan en orden y sin duplicados.'],
  ['Jueves', 'María olvida el regreso de comida', 'Se abre una incidencia revisable.'],
  ['Viernes', 'El foreman corrige el evento', 'Debe explicar el motivo; el registro original no se borra.'],
  ['Domingo', 'La contadora revisa el resumen', 'Se congela una versión y se exporta XLSX o CSV.'],
] as const);

export const DEMO_API_ALLOWLIST = Object.freeze(['/api/proposals/']);

export interface LocalDemoPunch {
  id: string;
  employeeId: string;
  action: PunchType;
  capturedAt: string;
  state: 'synced' | 'pending';
}
