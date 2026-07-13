import { describe, expect, it } from 'vitest';
import type { CaliforniaWorkChunk } from './californiaOvertime.js';
import {
  buildSyntheticOpenChunks,
  calculateWeekCost,
  decimal4Ratio,
  parseHourlyRateUnits,
  type EffectiveRate,
  type EmployeeCostInput,
} from './dashboardCosts.js';

const WEEK = '2026-07-05';
const plants = [
  { id: 'plant-1', code: 'P1', name: 'Plant 1' },
  { id: 'plant-2', code: 'P2', name: 'Plant 2' },
];

function chunk(
  id: string,
  workDate: string,
  hours: number,
  plantId = 'plant-1',
  source: 'clock' | 'manual' = 'clock',
  order = 0,
): CaliforniaWorkChunk {
  return { id, workDate, durationSeconds: hours * 3_600, plantId, source, order };
}

function employee(chunks: CaliforniaWorkChunk[], rates: EffectiveRate[]): EmployeeCostInput {
  return {
    employee_id: 'employee-1',
    employee_number: 41,
    full_name: 'Worker One',
    chunks,
    rates,
  };
}

const rate = (hourly_rate: string, effective_from = WEEK, effective_to: string | null = null): EffectiveRate => ({
  hourly_rate,
  effective_from,
  effective_to,
});

describe('exact direct-labor costing over California classified parts', () => {
  it('parses decimal(12,4) without Number and rejects ambiguous precision', () => {
    expect(parseHourlyRateUnits('18.3750')).toBe(183_750n);
    expect(parseHourlyRateUnits('0')).toBe(0n);
    expect(() => parseHourlyRateUnits('18.37501')).toThrow(/at most 4/);
    expect(() => parseHourlyRateUnits('1e2')).toThrow(/decimal/);
    expect(() => parseHourlyRateUnits('-1.0000')).toThrow(/non-negative/);
    expect(decimal4Ratio(1, 3)).toBe('0.3333');
  });

  it('costs daily regular, 1.5x and double-time buckets exactly', () => {
    const result = calculateWeekCost({
      weekStart: WEEK,
      employees: [employee([chunk('long-day', '2026-07-06', 13)], [rate('20.0000')])],
      plants,
    });
    expect(result.metric.seconds).toMatchObject({
      regular: 8 * 3_600,
      overtime_1_5: 4 * 3_600,
      double_time: 3_600,
      total: 13 * 3_600,
      costed: 13 * 3_600,
      uncosted: 0,
    });
    expect(result.metric.direct_cost_by_bucket_costed).toEqual({
      regular: '160.0000',
      overtime_1_5: '120.0000',
      double_time: '40.0000',
    });
    expect(result.metric.direct_cost_complete).toBe('320.0000');
  });

  it('applies weekly >40 non-pyramiding overtime to regular candidates', () => {
    const chunks = Array.from({ length: 6 }, (_, day) =>
      chunk(`day-${day}`, `2026-07-${String(5 + day).padStart(2, '0')}`, 8));
    const result = calculateWeekCost({
      weekStart: WEEK,
      employees: [employee(chunks, [rate('10.0000')])],
      plants,
    });
    expect(result.metric.seconds).toMatchObject({
      regular: 40 * 3_600,
      overtime_1_5: 8 * 3_600,
      double_time: 0,
    });
    expect(result.metric.direct_cost_complete).toBe('520.0000');
  });

  it('applies seventh-consecutive-day overtime in addition to prior weekly overtime', () => {
    const chunks = Array.from({ length: 7 }, (_, day) =>
      chunk(`day-${day}`, `2026-07-${String(5 + day).padStart(2, '0')}`, 8));
    const result = calculateWeekCost({
      weekStart: WEEK,
      employees: [employee(chunks, [rate('10.0000')])],
      plants,
    });
    expect(result.metric.seconds).toMatchObject({
      regular: 40 * 3_600,
      overtime_1_5: 16 * 3_600,
      double_time: 0,
    });
    expect(result.metric.direct_cost_complete).toBe('640.0000');
  });

  it('uses the effective rate of each work date when a rate changes midweek', () => {
    const result = calculateWeekCost({
      weekStart: WEEK,
      employees: [employee(
        [chunk('old', '2026-07-06', 1), chunk('new', '2026-07-09', 1)],
        [rate('10.0000', WEEK, '2026-07-07'), rate('20.0000', '2026-07-08')],
      )],
      plants,
    });
    expect(result.metric.direct_cost_complete).toBe('30.0000');
  });

  it('allocates a same-day multi-plant manual credit to its classified source and plant', () => {
    const result = calculateWeekCost({
      weekStart: WEEK,
      employees: [employee([
        chunk('p1', '2026-07-06', 4, 'plant-1'),
        chunk('p2', '2026-07-06', 4, 'plant-2', 'clock', 1),
        chunk('manual', '2026-07-06', 1, 'plant-2', 'manual', 2),
      ], [rate('10.0000')])],
      plants,
    });
    expect(result.metric.seconds).toMatchObject({
      regular: 8 * 3_600,
      overtime_1_5: 3_600,
      clock: 8 * 3_600,
      manual: 3_600,
    });
    expect(result.metric.direct_cost_complete).toBe('95.0000');
    expect(result.plants).toEqual([
      expect.objectContaining({ code: 'P1', metric: expect.objectContaining({ direct_cost_complete: '40.0000' }) }),
      expect.objectContaining({ code: 'P2', metric: expect.objectContaining({ direct_cost_complete: '55.0000' }) }),
    ]);
  });

  it('never treats a missing rate as zero and reports exact coverage', () => {
    const result = calculateWeekCost({
      weekStart: WEEK,
      employees: [employee(
        [chunk('costed', '2026-07-06', 1), chunk('missing', '2026-07-09', 1)],
        [rate('10.0000', WEEK, '2026-07-07')],
      )],
      plants,
    });
    expect(result.metric.seconds).toMatchObject({ costed: 3_600, uncosted: 3_600, total: 7_200 });
    expect(result.metric.direct_cost_costed).toBe('10.0000');
    expect(result.metric.direct_cost_complete).toBeNull();
    expect(result.metric.coverage_ratio).toBe('0.5000');
    expect(result.missing_rates).toEqual([{
      employee_id: 'employee-1',
      employee_number: 41,
      full_name: 'Worker One',
      work_dates: ['2026-07-09'],
      uncosted_seconds: 3_600,
    }]);
  });

  it('assigns deterministic rounding residuals so organization equals plant totals', () => {
    const result = calculateWeekCost({
      weekStart: WEEK,
      employees: [employee([
        { ...chunk('tiny-p1', '2026-07-06', 1, 'plant-1'), durationSeconds: 1 },
        { ...chunk('tiny-p2', '2026-07-06', 1, 'plant-2'), durationSeconds: 1 },
      ], [rate('0.1000')])],
      plants,
    });
    const plantTotal = result.plants.reduce(
      (sum, plant) => sum + parseHourlyRateUnits(plant.metric.direct_cost_costed),
      0n,
    );
    const plantRegular = result.plants.reduce(
      (sum, plant) => sum + parseHourlyRateUnits(plant.metric.direct_cost_by_bucket_costed.regular),
      0n,
    );
    expect(plantTotal).toBe(parseHourlyRateUnits(result.metric.direct_cost_costed));
    expect(plantRegular).toBe(
      parseHourlyRateUnits(result.metric.direct_cost_by_bucket_costed.regular),
    );
  });

  it('keeps total = buckets = plant sums under adversarial half-unit rounding', () => {
    const tinyRegular: EmployeeCostInput = {
      employee_id: 'tiny-regular',
      employee_number: 51,
      full_name: 'Tiny Regular',
      chunks: [{
        id: 'half-unit-regular',
        workDate: '2026-07-06',
        durationSeconds: 1_800,
        plantId: 'plant-1',
        source: 'clock',
        order: 0,
      }],
      rates: [rate('0.0001')],
    };
    const tinyOvertime: EmployeeCostInput = {
      employee_id: 'tiny-overtime',
      employee_number: 52,
      full_name: 'Tiny Overtime',
      chunks: [{
        id: 'regular-plus-half-unit-overtime',
        workDate: '2026-07-06',
        durationSeconds: 30_000,
        plantId: 'plant-2',
        source: 'clock',
        order: 0,
      }],
      rates: [rate('0.0001')],
    };
    const result = calculateWeekCost({
      weekStart: WEEK,
      employees: [tinyRegular, tinyOvertime],
      plants,
    });
    const units = parseHourlyRateUnits;
    const organizationBucketSum = Object.values(result.metric.direct_cost_by_bucket_costed)
      .reduce((sum, value) => sum + units(value), 0n);
    const plantTotalSum = result.plants.reduce(
      (sum, plant) => sum + units(plant.metric.direct_cost_costed),
      0n,
    );
    expect(result.metric.direct_cost_costed).toBe('0.0009');
    expect(organizationBucketSum).toBe(units(result.metric.direct_cost_costed));
    expect(plantTotalSum).toBe(units(result.metric.direct_cost_costed));
    for (const plant of result.plants) {
      const bucketSum = Object.values(plant.metric.direct_cost_by_bucket_costed)
        .reduce((sum, value) => sum + units(value), 0n);
      expect(bucketSum).toBe(units(plant.metric.direct_cost_costed));
    }
  });

  it('splits a synthetic overnight open interval at civil midnight without parsing IDs', () => {
    const chunks = buildSyntheticOpenChunks({
      punches: [{
        id: 'punch-1',
        employee_id: 'employee-with-hyphens',
        plant_id: 'plant-with-hyphens',
        punch_type: 'shift_in',
        punched_at: new Date('2026-07-07T06:00:00.000Z'), // Jul 6, 23:00 PDT
      }],
      now: new Date('2026-07-07T09:00:00.000Z'), // Jul 7, 02:00 PDT
      timezone: 'America/Los_Angeles',
      fromWeekStart: WEEK,
      toWeekEnd: '2026-07-11',
    });
    expect(chunks.map((part) => ({
      employee_id: part.employee_id,
      work_date: part.workDate,
      seconds: part.durationSeconds,
    }))).toEqual([
      { employee_id: 'employee-with-hyphens', work_date: '2026-07-06', seconds: 3_600 },
      { employee_id: 'employee-with-hyphens', work_date: '2026-07-07', seconds: 7_200 },
    ]);
    expect(new Set(chunks.map((part) => part.open_sequence_id)).size).toBe(1);
  });

  it('caps one projected open sequence at 16 hours without multiplying its count by civil days', () => {
    const chunks = buildSyntheticOpenChunks({
      punches: [{
        id: 'open-punch',
        employee_id: 'employee-1',
        plant_id: 'plant-1',
        punch_type: 'shift_in',
        punched_at: new Date('2026-07-06T22:00:00.000Z'),
      }],
      now: new Date('2026-07-08T22:00:00.000Z'),
      timezone: 'America/Los_Angeles',
      fromWeekStart: WEEK,
      toWeekEnd: '2026-07-11',
    });
    expect(chunks.reduce((sum, part) => sum + part.durationSeconds, 0)).toBe(16 * 3_600);
    expect(chunks.every((part) => part.capped_at_16_hours)).toBe(true);
    expect(new Set(chunks.map((part) => part.open_sequence_id)).size).toBe(1);
  });
});
