import type { UserRole } from '@clockai/shared';

type UnknownRecord = Record<string, unknown>;

const HOURLY_RATE_RE = /^(?:0|[1-9]\d{0,7})(?:\.\d{1,4})?$/;

export interface EmployeeCurrentRate {
  hourly_rate: string;
  effective_from: string;
}

export interface EmployeeListItem {
  id: string;
  organization_id: string;
  employee_number: number;
  full_name: string;
  phone: string | null;
  default_shift_id: string | null;
  active: boolean;
  hired_at: string | null;
  deactivated_at: string | null;
  created_at: string;
  current_biometric_enrollment_id: string | null;
  biometric_enrollment_status: 'ready' | 'error' | null;
  current_rate: EmployeeCurrentRate | null;
}

export interface EmployeeAdminDetail extends EmployeeListItem {
  social_security: string | null;
}

export interface EmployeeRateHistory {
  id: string;
  hourly_rate: string;
  effective_from: string;
  effective_to: string | null;
  reason: string | null;
  created_at: string;
}

function record(value: unknown): UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Respuesta de empleados inválida.');
  }
  return value as UnknownRecord;
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Falta ${field}.`);
  return value;
}

function nullableText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function nonnegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${field} inválido.`);
  }
  return value;
}

function decimal(value: unknown, field: string): string {
  const normalized = typeof value === 'number' ? value.toFixed(4) : value;
  if (typeof normalized !== 'string' || !HOURLY_RATE_RE.test(normalized)) {
    throw new Error(`${field} inválida.`);
  }
  return normalized;
}

function currentRate(source: UnknownRecord, admin: boolean): EmployeeCurrentRate | null {
  if (!admin) return null;
  const nested = source.current_rate;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    const rate = record(nested);
    return {
      hourly_rate: decimal(rate.hourly_rate, 'Tasa'),
      effective_from: text(rate.effective_from, 'vigencia de tasa'),
    };
  }
  const rate = source.current_hourly_rate ?? source.hourly_rate;
  if (rate === null || rate === undefined) return null;
  return {
    hourly_rate: decimal(rate, 'Tasa'),
    effective_from: text(
      source.current_rate_effective_from ?? source.rate_effective_from,
      'vigencia de tasa',
    ),
  };
}

function employee(value: unknown, admin: boolean): EmployeeListItem {
  const source = record(value);
  const enrollmentStatus = source.biometric_enrollment_status;
  return {
    id: text(source.id, 'ID de empleado'),
    organization_id: text(source.organization_id, 'organización'),
    employee_number: nonnegativeInteger(source.employee_number, 'Número de empleado'),
    full_name: text(source.full_name, 'nombre'),
    phone: admin ? nullableText(source.phone) : null,
    default_shift_id: nullableText(source.default_shift_id),
    active: source.active === true,
    hired_at: nullableText(source.hired_at),
    deactivated_at: nullableText(source.deactivated_at),
    created_at: text(source.created_at, 'fecha de creación'),
    current_biometric_enrollment_id: admin ? nullableText(source.current_biometric_enrollment_id) : null,
    biometric_enrollment_status: admin && (enrollmentStatus === 'ready' || enrollmentStatus === 'error')
      ? enrollmentStatus
      : null,
    current_rate: currentRate(source, admin),
  };
}

/** List DTO deliberately drops social_security even when a server regresses. */
export function parseEmployeeList(value: unknown, role: UserRole): EmployeeListItem[] {
  if (!Array.isArray(value)) throw new Error('Respuesta de empleados inválida.');
  const admin = role === 'admin';
  return value.map((row) => employee(row, admin));
}

export function parseEmployeeAdminDetail(value: unknown): EmployeeAdminDetail {
  const source = record(value);
  return {
    ...employee(source, true),
    social_security: nullableText(source.social_security),
  };
}

export function parseEmployeeRates(value: unknown): EmployeeRateHistory[] {
  if (!Array.isArray(value)) throw new Error('Respuesta de tasas inválida.');
  return value.map((item) => {
    const source = record(item);
    return {
      id: text(source.id, 'ID de tasa'),
      hourly_rate: decimal(source.hourly_rate, 'Tasa'),
      effective_from: text(source.effective_from, 'vigencia inicial'),
      effective_to: nullableText(source.effective_to),
      reason: nullableText(source.reason),
      created_at: text(source.created_at, 'fecha de registro'),
    };
  });
}

export function rateChangeError(input: {
  hourly_rate: string;
  effective_from: string;
  reason: string;
}): string | null {
  if (!HOURLY_RATE_RE.test(input.hourly_rate.trim())) {
    return 'Ingresa una tasa válida con máximo 4 decimales.';
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.effective_from)) return 'Selecciona la fecha de vigencia.';
  if (input.reason.trim().length < 3) return 'El motivo debe tener al menos 3 caracteres.';
  if (input.reason.trim().length > 2_000) return 'El motivo no puede exceder 2,000 caracteres.';
  return null;
}

export function initialRateError(hourlyRate: string, effectiveFrom: string): string | null {
  if (!hourlyRate.trim()) return null;
  if (!HOURLY_RATE_RE.test(hourlyRate.trim())) {
    return 'Ingresa una tasa inicial válida con máximo 4 decimales.';
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) {
    return 'Selecciona desde cuándo aplica la tasa inicial.';
  }
  return null;
}

export function initialRatePayload(
  hourlyRate: string,
  effectiveFrom: string,
): { hourly_rate: string; rate_effective_from: string } | Record<string, never> {
  return hourlyRate.trim()
    ? { hourly_rate: hourlyRate.trim(), rate_effective_from: effectiveFrom }
    : {};
}

export function canViewEmployeeRates(role: UserRole): boolean {
  return role === 'admin';
}
