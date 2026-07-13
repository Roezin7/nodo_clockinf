import { describe, expect, it } from 'vitest';
import {
  buildExceptionListPath,
  buildExceptionSummaryPath,
  canViewOperationalExceptions,
  exceptionActions,
  orderedExceptionEvents,
  transitionReasonError,
  type OperationalExceptionEvent,
} from './exceptionModel';

describe('modelo de incidencias operativas', () => {
  it('impide que accountant y platform_operator entren al panel operativo', () => {
    expect(canViewOperationalExceptions('admin')).toBe(true);
    expect(canViewOperationalExceptions('foreman')).toBe(true);
    expect(canViewOperationalExceptions('accountant')).toBe(false);
    expect(canViewOperationalExceptions('platform_operator')).toBe(false);
  });

  it('construye filtros paginados con los nombres exactos del API', () => {
    const path = buildExceptionListPath(
      {
        status: 'acknowledged',
        severity: 'blocker',
        code: 'missing_shift_out',
        plantId: 'd6a9d0c1-e35f-4626-a8d8-a695e12fe68b',
      },
      100,
      50,
    );
    const url = new URL(path, 'https://clockai.test');
    expect(url.pathname).toBe('/api/operational-exceptions');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      status: 'acknowledged',
      severity: 'blocker',
      code: 'missing_shift_out',
      plant_id: 'd6a9d0c1-e35f-4626-a8d8-a695e12fe68b',
      limit: '50',
      offset: '100',
    });
    expect(buildExceptionSummaryPath('')).toBe('/api/operational-exceptions/summary');
  });

  it('solo ofrece transiciones válidas y exige un motivo auditable', () => {
    expect(exceptionActions('open')).toEqual(['acknowledge', 'resolve']);
    expect(exceptionActions('acknowledged')).toEqual(['resolve']);
    expect(exceptionActions('resolved')).toEqual([]);
    expect(transitionReasonError('  no  ')).toBe('El motivo debe tener al menos 3 caracteres.');
    expect(transitionReasonError('  revisado por el supervisor  ')).toBeNull();
    expect(transitionReasonError('x'.repeat(2_001))).toContain('2,000');
  });

  it('ordena el timeline por secuencia sin modificar la evidencia original', () => {
    const event = (sequence: number): OperationalExceptionEvent => ({
      id: `event-${sequence}`,
      sequence,
      event_type: sequence === 1 ? 'opened' : 'refreshed',
      from_status: sequence === 1 ? null : 'open',
      to_status: 'open',
      actor_user_id: null,
      actor_name: null,
      reason: null,
      snapshot: {},
      created_at: '2026-07-13T12:00:00.000Z',
    });
    const source = [event(2), event(1)];
    expect(orderedExceptionEvents(source).map((item) => item.sequence)).toEqual([1, 2]);
    expect(source.map((item) => item.sequence)).toEqual([2, 1]);
  });
});
