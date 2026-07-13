import { describe, expect, it } from 'vitest';
import {
  canViewLaborCosts,
  dashboardPathsForRole,
  laborCostDisplay,
  parseAdminWeekDashboard,
  parseLaborTrendPage,
  parseOperationsDashboard,
} from './model';

describe('privacidad y RBAC del dashboard', () => {
  it('foreman sólo solicita operación y accountant no puede solicitar dashboard', () => {
    expect(dashboardPathsForRole('foreman')).toEqual(['/api/dashboard/operations']);
    expect(dashboardPathsForRole('accountant')).toEqual([]);
    expect(dashboardPathsForRole('admin')).toContain('/api/dashboard/admin/current-week');
    expect(canViewLaborCosts('foreman')).toBe(false);
    expect(canViewLaborCosts('accountant')).toBe(false);
    expect(canViewLaborCosts('admin')).toBe(true);
  });

  it('proyecta operaciones con allowlist y elimina costos, tasas, SSN y motivos', () => {
    const parsed = parseOperationsDashboard({
      generated_at: '2026-07-14T12:00:00.000Z',
      timezone: 'America/Los_Angeles',
      hourly_rate: '25.00',
      direct_cost: '999.00',
      social_security: 'private',
      reason: 'private',
      plants: [{
        id: 'plant-1', code: 'P1', name: 'Planta Uno',
        workers: {
          inside: [{
            employee_number: 7,
            full_name: 'Ana',
            state: 'inside',
            since: '2026-07-14T12:00:00.000Z',
            stale: false,
            social_security: 'private',
          }],
          on_meal: [],
          stale_open: [{
            employee_number: 8,
            full_name: 'Luis',
            state: 'stale_open',
            since: '2026-07-01T12:00:00.000Z',
            stale: true,
            employee_active: false,
            last_punch_type: 'shift_in',
          }],
          inside_count: 1,
          on_meal_count: 0,
          stale_open_count: 1,
          open_sequences_count: 2,
        },
        identity_reviews_open: 0,
        exceptions_open: { blockers: 0, warnings: 1, total: 1, reason: 'private' },
        devices: [{
          id: 'device-1', name: 'Kiosco 1', active: true,
          last_heartbeat_at: null, last_sync_at: null,
          pending_event_count: 0, rejected_event_count: 0,
          camera_status: 'ready', storage_status: 'ready', sync_status: 'healthy',
          last_error: 'private',
        }],
      }],
      totals: {
        inside: 1, on_meal: 0, stale_open: 1, open_sequences: 2,
        identity_reviews_open: 0, exceptions_open: 1, devices_attention: 0,
      },
    });
    expect(parsed.plants[0]?.workers.inside[0]).toEqual({
      employee_number: 7,
      full_name: 'Ana',
      state: 'inside',
      since: '2026-07-14T12:00:00.000Z',
      stale: false,
    });
    expect(parsed.plants[0]?.workers.stale_open[0]).toMatchObject({
      employee_number: 8,
      state: 'stale_open',
      stale: true,
      employee_active: false,
    });
    expect(JSON.stringify(parsed)).not.toMatch(/hourly|cost|social_security|private|last_error|reason/);
  });

  it('mantiene costo incompleto como null y reduce thresholds/manuales a allowlists admin', () => {
    const metric = {
      seconds: {
        regular: 28_800, overtime_1_5: 3_600, double_time: 0,
        clock: 31_500, manual: 900, total: 32_400, costed: 28_800, uncosted: 3_600,
      },
      direct_cost_costed: '200.0000',
      direct_cost_complete: null,
      coverage_ratio: '0.8889',
    };
    const parsed = parseAdminWeekDashboard({
      generated_at: '2026-07-14T12:00:00.000Z',
      timezone: 'America/Los_Angeles',
      week_start: '2026-07-12',
      week_end: '2026-07-18',
      as_of: '2026-07-14T12:00:00.000Z',
      disclaimer: 'Costo directo estimado.',
      actual: metric,
      plants: [{ plant_id: 'p1', code: 'P1', name: 'Planta Uno', metric }],
      thresholds: {
        daily_7_to_8: 1,
        daily_11_to_12: 0,
        weekly_36_to_40: 0,
        daily_at_or_over_8: 0,
        daily_at_or_over_12: 0,
        weekly_at_or_over_40: 1,
      },
      threshold_details: [{ code: 'near_8h', employee_id: 'private' }],
      previous_week: { metric },
      projection: {
        metric,
        as_of: '2026-07-14T12:00:00.000Z',
        method: 'actual_plus_open_elapsed_capped_16h',
        synthetic: true,
        payable: false,
      },
      missing_rates: [{ employee_id: 'private' }],
      recent_manual_changes: [{
        employee_number: 7,
        full_name: 'Ana',
        plant_code: 'P1',
        plant_name: 'Planta Uno',
        work_date: '2026-07-14',
        duration_seconds: 900,
        actor_name: 'Foreman',
        created_at: '2026-07-14T13:00:00.000Z',
        reason: 'Bono solicitado',
        employee_id: 'private',
      }],
    });
    expect(parsed.actual.direct_cost_complete).toBeNull();
    expect(laborCostDisplay(parsed.actual)).toEqual({
      complete: false,
      amount: null,
      known_amount: '200.0000',
      status: 'missing_rates',
    });
    expect(parsed.missing_rates).toBe(1);
    expect(parsed.thresholds).toMatchObject({ daily_7_to_8: 1, weekly_at_or_over_40: 1 });
    expect(parsed.manual_changes[0]).toMatchObject({ duration_seconds: 900, reason: 'Bono solicitado' });
    expect(JSON.stringify(parsed)).not.toMatch(/employee_id|"private"/);

    const trend = parseLaborTrendPage({
      grain: 'week',
      items: [{
        period_start: '2026-07-06',
        period_end: '2026-07-12',
        metric,
        cost_status: 'unavailable_legacy',
        source: 'legacy_report_without_cost_snapshot',
        missing_rates: [{ employee_id: 'private' }],
      }],
    });
    expect(trend.items[0]?.cost_status).toBe('unavailable_legacy');
    expect(JSON.stringify(trend)).not.toMatch(/employee_id|"private"|source/);
  });
});
