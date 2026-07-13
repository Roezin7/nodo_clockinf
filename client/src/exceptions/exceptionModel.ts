import type { UserRole } from '@clockai/shared';
import type { BadgeTone } from '../components/ui';

export const EXCEPTION_CODES = [
  'missing_shift_out',
  'missing_meal_in',
  'out_of_sequence',
  'overlap_between_plants',
  'negative_duration',
  'invalid_manual_time',
  'split_shift_policy_review',
  'first_meal_waiver_review',
  'first_meal_missing',
  'first_meal_short',
  'first_meal_late',
  'second_meal_waiver_review',
  'second_meal_missing',
  'second_meal_short',
  'second_meal_late',
  'identity_review',
  'device_unhealthy',
] as const;

export type ExceptionCode = (typeof EXCEPTION_CODES)[number];
export type ExceptionSeverity = 'blocker' | 'warning';
export type ExceptionStatus = 'open' | 'acknowledged' | 'resolved';
export type ExceptionStatusFilter = 'active' | ExceptionStatus | 'all';
export type ExceptionSourceType =
  | 'punch_sequence'
  | 'employee_workday'
  | 'manual_time'
  | 'identity_session'
  | 'device';
export type ExceptionAction = 'acknowledge' | 'resolve';

export interface ExceptionPlant {
  id: string;
  code: string;
  name: string;
}

export interface OperationalExceptionListItem {
  id: string;
  code: ExceptionCode;
  severity: ExceptionSeverity;
  source_type: ExceptionSourceType;
  employee_id: string | null;
  employee_number: number | null;
  employee_name: string | null;
  work_date: string | null;
  occurred_at: string;
  title: string;
  status: ExceptionStatus;
  first_detected_at: string;
  last_detected_at: string;
  acknowledged_at: string | null;
  resolved_at: string | null;
  resolution_reason: string | null;
  plants: ExceptionPlant[];
}

export interface OperationalExceptionEvent {
  id: string;
  sequence: number;
  event_type: 'opened' | 'refreshed' | 'acknowledged' | 'resolved' | 'reopened';
  from_status: ExceptionStatus | null;
  to_status: ExceptionStatus;
  actor_user_id: string | null;
  actor_name: string | null;
  reason: string | null;
  snapshot: Record<string, unknown>;
  created_at: string;
}

export interface OperationalExceptionDetail extends OperationalExceptionListItem {
  details: Record<string, unknown>;
  acknowledged_by_name: string | null;
  resolved_by_name: string | null;
  events: OperationalExceptionEvent[];
  events_next_before_sequence: number | null;
}

export interface OperationalExceptionPage {
  items: OperationalExceptionListItem[];
  total: number;
  next_offset: number | null;
}

export interface OperationalExceptionSummary {
  totals: {
    all: number;
    active: number;
    blockers: number;
    warnings: number;
  };
  by_status: Record<ExceptionStatus, number>;
  by_code: Record<ExceptionCode, number>;
}

export interface ExceptionFilters {
  status: ExceptionStatusFilter;
  severity: ExceptionSeverity | '';
  code: ExceptionCode | '';
  plantId: string;
}

export const EXCEPTION_CODE_LABELS: Record<ExceptionCode, string> = {
  missing_shift_out: 'Falta salida',
  missing_meal_in: 'Falta regreso de comida',
  out_of_sequence: 'Checadas fuera de secuencia',
  overlap_between_plants: 'Traslape entre plantas',
  negative_duration: 'Duración inválida',
  invalid_manual_time: 'Horas manuales inválidas',
  split_shift_policy_review: 'Revisión de turno dividido',
  first_meal_waiver_review: 'Revisar exención de primera comida',
  first_meal_missing: 'Primera comida faltante',
  first_meal_short: 'Primera comida corta',
  first_meal_late: 'Primera comida tardía',
  second_meal_waiver_review: 'Revisar exención de segunda comida',
  second_meal_missing: 'Segunda comida faltante',
  second_meal_short: 'Segunda comida corta',
  second_meal_late: 'Segunda comida tardía',
  identity_review: 'Identidad pendiente',
  device_unhealthy: 'Checador con problemas',
};

export const EXCEPTION_STATUS_PRESENTATION: Record<
  ExceptionStatus,
  { label: string; tone: BadgeTone }
> = {
  open: { label: 'Abierta', tone: 'danger' },
  acknowledged: { label: 'Reconocida', tone: 'warning' },
  resolved: { label: 'Resuelta', tone: 'success' },
};

export const EXCEPTION_EVENT_LABELS: Record<OperationalExceptionEvent['event_type'], string> = {
  opened: 'Incidencia detectada',
  refreshed: 'Evidencia actualizada',
  acknowledged: 'Incidencia reconocida',
  resolved: 'Incidencia resuelta',
  reopened: 'Incidencia reabierta',
};

export function canViewOperationalExceptions(
  role: UserRole,
): role is Extract<UserRole, 'admin' | 'foreman'> {
  return role === 'admin' || role === 'foreman';
}

export function exceptionActions(status: ExceptionStatus): readonly ExceptionAction[] {
  if (status === 'open') return ['acknowledge', 'resolve'];
  if (status === 'acknowledged') return ['resolve'];
  return [];
}

export function transitionReasonError(reason: string): string | null {
  const length = reason.trim().length;
  if (length < 3) return 'El motivo debe tener al menos 3 caracteres.';
  if (length > 2_000) return 'El motivo no puede exceder 2,000 caracteres.';
  return null;
}

export function buildExceptionListPath(
  filters: ExceptionFilters,
  offset: number,
  limit = 50,
): string {
  const params = new URLSearchParams({
    status: filters.status,
    limit: String(limit),
    offset: String(offset),
  });
  if (filters.severity) params.set('severity', filters.severity);
  if (filters.code) params.set('code', filters.code);
  if (filters.plantId) params.set('plant_id', filters.plantId);
  return `/api/operational-exceptions?${params.toString()}`;
}

export function buildExceptionSummaryPath(plantId: string): string {
  const params = new URLSearchParams();
  if (plantId) params.set('plant_id', plantId);
  const query = params.toString();
  return `/api/operational-exceptions/summary${query ? `?${query}` : ''}`;
}

/**
 * The API returns immutable lifecycle events by sequence. Sorting a copy keeps
 * rendering deterministic without mutating the evidence returned by the API.
 */
export function orderedExceptionEvents(
  events: readonly OperationalExceptionEvent[],
): OperationalExceptionEvent[] {
  return [...events].sort((left, right) => left.sequence - right.sequence);
}

export function formatExceptionPlants(plants: readonly ExceptionPlant[]): string {
  return plants.map((plant) => plant.name).join(', ') || '—';
}
