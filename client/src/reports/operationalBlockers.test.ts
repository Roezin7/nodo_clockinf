import { describe, expect, it } from 'vitest';
import { ApiError } from '../api';
import { parseOperationalBlockerConflict } from './operationalBlockers';

describe('conflicto de bloqueos operativos', () => {
  it('acepta sólo el contrato esperado y descarta filas mal formadas', () => {
    const error = new ApiError(409, 'Hay incidencias', 'operational_exception_blockers', {
      blockers: [
        {
          code: 'missing_shift_out',
          title: 'Falta checada de salida',
          employee_id: 'employee-1',
          work_date: '2026-07-11',
          plant_ids: ['plant-1'],
          source_key: 'employee-1:punch-1',
        },
        { code: 7 },
      ],
    });
    expect(parseOperationalBlockerConflict(error)?.blockers).toHaveLength(1);
    expect(parseOperationalBlockerConflict(new Error('network'))).toBeNull();
  });
});
