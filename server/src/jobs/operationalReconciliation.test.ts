import { describe, expect, it } from 'vitest';
import {
  operationalReconciliationWindow,
  operationalReconciliationWindows,
} from './operationalReconciliation.js';

describe('ventana automática de reconciliación', () => {
  it('incluye la semana previa y la semana abierta en hora de Modesto', () => {
    expect(
      operationalReconciliationWindow(
        new Date('2026-07-13T08:30:00.000Z'),
        'America/Los_Angeles',
      ),
    ).toEqual({ fromDate: '2026-07-05', toDate: '2026-07-13' });
  });

  it('usa la fecha local durante el cambio de horario y no la fecha UTC', () => {
    expect(
      operationalReconciliationWindow(
        new Date('2026-11-01T06:30:00.000Z'),
        'America/Los_Angeles',
      ),
    ).toEqual({ fromDate: '2026-10-18', toDate: '2026-10-31' });
  });

  it('incluye semanas históricas reabiertas y elimina duplicados', () => {
    expect(
      operationalReconciliationWindows(
        new Date('2026-07-13T08:30:00.000Z'),
        'America/Los_Angeles',
        [
          { week_start: '2026-05-03', week_end: '2026-05-09' },
          { week_start: '2026-05-03', week_end: '2026-05-09' },
        ],
      ),
    ).toEqual([
      { fromDate: '2026-05-03', toDate: '2026-05-09' },
      { fromDate: '2026-07-05', toDate: '2026-07-13' },
    ]);
  });
});
