import { describe, expect, it } from 'vitest';
import { ApiError } from '../api';
import { parseReviewBlockerConflict } from './reviewBlockers';

describe('prevalidación para enviar una semana a revisión', () => {
  it('acepta sólo el conflicto estructurado y reduce el detalle operativo', () => {
    const parsed = parseReviewBlockerConflict(new ApiError(
      409,
      'La semana tiene incidencias',
      'review_operational_blockers',
      {
        anomaly_count: 2,
        blockers: [{
          code: 'missing_shift_out',
          employee_id: 'no conservar',
          work_date: '2026-07-11',
          plant_ids: ['no conservar'],
        }],
      },
    ));
    expect(parsed).toEqual({
      message: 'La semana tiene incidencias',
      anomaly_count: 2,
      blockers: [{ code: 'missing_shift_out', work_date: '2026-07-11' }],
    });
    expect(parseReviewBlockerConflict(new Error('network'))).toBeNull();
  });
});
