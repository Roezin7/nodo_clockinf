import { describe, expect, it } from 'vitest';
import {
  canViewEmployeeRates,
  initialRateError,
  initialRatePayload,
  parseEmployeeList,
  parseEmployeeRates,
  rateChangeError,
} from './model';

const employee = {
  id: 'employee-1',
  organization_id: 'org-1',
  employee_number: 7,
  full_name: 'Ana',
  social_security: 'private-ssn',
  phone: '555-0100',
  default_shift_id: null,
  active: true,
  hired_at: '2026-01-01',
  deactivated_at: null,
  created_at: '2026-01-01T12:00:00.000Z',
  current_biometric_enrollment_id: 'enrollment-1',
  current_rate: { hourly_rate: '24.5000', effective_from: '2026-07-01' },
};

describe('DTO de empleados por rol', () => {
  it('el listado admin conserva tasa pero elimina SSN', () => {
    const parsed = parseEmployeeList([employee], 'admin');
    expect(parsed[0]?.current_rate).toEqual({ hourly_rate: '24.5000', effective_from: '2026-07-01' });
    expect(JSON.stringify(parsed)).not.toContain('private-ssn');
  });

  it('foreman no recibe en su modelo teléfono, biometría ni tasa aunque el JSON los incluya', () => {
    const parsed = parseEmployeeList([employee], 'foreman');
    expect(parsed[0]).toMatchObject({ phone: null, current_rate: null, current_biometric_enrollment_id: null });
    expect(JSON.stringify(parsed)).not.toMatch(/24\.5000|555-0100|enrollment-1|private-ssn/);
    expect(canViewEmployeeRates('foreman')).toBe(false);
    expect(canViewEmployeeRates('admin')).toBe(true);
  });

  it('exige motivo, vigencia y decimal seguro para cambiar tasa', () => {
    expect(rateChangeError({ hourly_rate: '25.1250', effective_from: '2026-08-01', reason: 'Aumento anual' })).toBeNull();
    expect(rateChangeError({ hourly_rate: '99999999.9999', effective_from: '2026-08-01', reason: 'Tope permitido' })).toBeNull();
    expect(rateChangeError({ hourly_rate: '025.00', effective_from: '2026-08-01', reason: 'Formato inválido' })).toContain('tasa válida');
    expect(rateChangeError({ hourly_rate: '100000000', effective_from: '2026-08-01', reason: 'Fuera de rango' })).toContain('tasa válida');
    expect(rateChangeError({ hourly_rate: '25', effective_from: '', reason: 'ok' })).toContain('fecha');
    expect(rateChangeError({ hourly_rate: '25.12345', effective_from: '2026-08-01', reason: 'Aumento' })).toContain('4 decimales');
  });

  it('usa las claves estrictas del alta para la tasa inicial', () => {
    expect(initialRatePayload(' 24.5000 ', '2026-08-01')).toEqual({
      hourly_rate: '24.5000',
      rate_effective_from: '2026-08-01',
    });
    expect(initialRatePayload('', '2026-08-01')).toEqual({});
    expect(initialRateError('025.00', '2026-08-01')).toContain('tasa inicial válida');
    expect(initialRateError('99999999.9999', '2026-08-01')).toBeNull();
  });

  it('proyecta el historial de tasas sin actor ni IDs de empleado', () => {
    const parsed = parseEmployeeRates([{
      id: 'rate-1',
      employee_id: 'private',
      hourly_rate: '25.7500',
      effective_from: '2026-08-01',
      effective_to: null,
      reason: 'Aumento anual',
      created_at: '2026-07-14T12:00:00.000Z',
      created_by: 'private',
    }]);
    expect(parsed[0]).toMatchObject({ hourly_rate: '25.7500', reason: 'Aumento anual' });
    expect(JSON.stringify(parsed)).not.toMatch(/employee_id|created_by|private/);
  });
});
