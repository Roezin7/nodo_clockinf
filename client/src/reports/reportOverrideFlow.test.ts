import { describe, expect, it } from 'vitest';
import {
  mergeReportOverrides,
  NO_REPORT_OVERRIDES,
  reportOverridePayload,
} from './reportOverrideFlow';

describe('overrides encadenados del cierre semanal', () => {
  it('acumula device health y bloqueos operativos sin perder el primero', () => {
    const device = mergeReportOverrides(NO_REPORT_OVERRIDES, { device: true });
    const both = mergeReportOverrides(device, { operational: true });
    expect(both).toEqual({ device: true, operational: true });
    expect(reportOverridePayload(both, '  Verificado con el foreman  ')).toEqual({
      override_device_health: true,
      override_operational_blockers: true,
      reason: 'Verificado con el foreman',
    });
  });

  it('no manda motivo ni flags en la validación normal', () => {
    expect(reportOverridePayload(NO_REPORT_OVERRIDES, 'texto residual')).toEqual({});
  });
});
