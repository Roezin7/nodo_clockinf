import { DateTime } from 'luxon';
import type { PoolClient, QueryResultRow } from 'pg';
import { query } from '../db.js';
import {
  classifyCaliforniaOvertime,
  type CaliforniaClassifiedPart,
  type CaliforniaPayBucket,
  type CaliforniaWorkChunk,
  type CaliforniaWorkSource,
} from './californiaOvertime.js';
import { weekBoundsForDate } from './payPeriodService.js';
import { buildWorkSegments, type WorkSegmentPunchType } from './workSegments.js';

const MONEY_SCALE = 10_000n;
const COST_DENOMINATOR = 7_200n;
const DECIMAL_RATE = /^(?:0|[1-9]\d{0,7})(?:\.(\d{1,4}))?$/;

export interface EffectiveRate {
  hourly_rate: string;
  effective_from: string;
  effective_to: string | null;
}

export interface EmployeeCostInput {
  employee_id: string;
  employee_number: number;
  full_name: string;
  chunks: CaliforniaWorkChunk[];
  rates: EffectiveRate[];
}

export interface MissingRateRow {
  employee_id: string;
  employee_number: number;
  full_name: string;
  work_dates: string[];
  uncosted_seconds: number;
}

export interface DashboardLaborMetric {
  seconds: {
    regular: number;
    overtime_1_5: number;
    double_time: number;
    clock: number;
    manual: number;
    total: number;
    costed: number;
    uncosted: number;
  };
  direct_cost_by_bucket_costed: {
    regular: string;
    overtime_1_5: string;
    double_time: string;
  };
  direct_cost_costed: string;
  direct_cost_complete: string | null;
  coverage_ratio: string;
}

export type ThresholdCode = 'near_8h' | 'at_8h' | 'near_12h' | 'at_12h' | 'near_40h' | 'at_40h';

export interface DashboardThresholdRow {
  employee_id: string;
  employee_number: number;
  full_name: string;
  work_date: string | null;
  total_seconds: number;
  code: ThresholdCode;
  next_threshold_seconds: number | null;
}

export interface DashboardPlantCost {
  plant_id: string;
  code: string;
  name: string;
  metric: DashboardLaborMetric;
}

export interface DashboardRateFact {
  employee_number: number;
  full_name: string;
  work_date: string;
  plant_code: string;
  plant_name: string;
  source: CaliforniaWorkSource;
  bucket: CaliforniaPayBucket;
  hourly_rate: string | null;
  seconds: number;
  direct_cost_costed: string | null;
}

export interface DashboardWeekCost {
  week_start: string;
  week_end: string;
  metric: DashboardLaborMetric;
  plants: DashboardPlantCost[];
  thresholds: DashboardThresholdRow[];
  missing_rates: MissingRateRow[];
  rate_facts: DashboardRateFact[];
}

interface CostAccumulator {
  regular: number;
  overtime15: number;
  doubleTime: number;
  clock: number;
  manual: number;
  costed: number;
  uncosted: number;
  costNumerator: bigint;
  regularCostNumerator: bigint;
  overtimeCostNumerator: bigint;
  doubleTimeCostNumerator: bigint;
}

export interface DashboardProjectionPunch {
  id: string;
  employee_id: string;
  plant_id: string;
  punch_type: WorkSegmentPunchType;
  punched_at: Date;
}

interface RawManualRow {
  id: string;
  employee_id: string;
  plant_id: string;
  work_date: string;
  duration_seconds: string | number;
}

interface EmployeeRow {
  id: string;
  employee_number: number;
  full_name: string;
}

interface RateRow extends EffectiveRate {
  employee_id: string;
}

interface PlantRow {
  id: string;
  code: string;
  name: string;
}

export interface SyntheticOpenChunk extends CaliforniaWorkChunk {
  employee_id: string;
  open_sequence_id: string;
  synthetic: true;
  projection_reason: 'open_shift_elapsed';
  capped_at_16_hours: boolean;
}

export interface DashboardCostInputs {
  from_week_start: string;
  to_week_end: string;
  employees: EmployeeCostInput[];
  plants: PlantRow[];
  synthetic_open_chunks: SyntheticOpenChunk[];
}

export interface AdminDirectCostSnapshotV1 {
  schema_version: 1;
  contract: 'clockai-admin-direct-cost-v1';
  report_version: number;
  week_start: string;
  week_end: string;
  timezone: string;
  created_at: string;
  disclaimer: 'estimated_direct_labor_only_excludes_taxes_benefits_burden';
  week: DashboardWeekCost;
}

function emptyAccumulator(): CostAccumulator {
  return {
    regular: 0,
    overtime15: 0,
    doubleTime: 0,
    clock: 0,
    manual: 0,
    costed: 0,
    uncosted: 0,
    costNumerator: 0n,
    regularCostNumerator: 0n,
    overtimeCostNumerator: 0n,
    doubleTimeCostNumerator: 0n,
  };
}

export function parseHourlyRateUnits(value: string): bigint {
  const match = DECIMAL_RATE.exec(value);
  if (!match) throw new Error('hourly_rate must be a non-negative decimal with at most 4 places');
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole!) * MONEY_SCALE + BigInt(fraction.padEnd(4, '0'));
}

function roundedDivide(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator / 2n) / denominator;
}

export function formatMoneyNumerator(numerator: bigint): string {
  const units = roundedMoneyUnits(numerator);
  const whole = units / MONEY_SCALE;
  const fraction = (units % MONEY_SCALE).toString().padStart(4, '0');
  return `${whole}.${fraction}`;
}

function roundedMoneyUnits(numerator: bigint): bigint {
  return roundedDivide(numerator, COST_DENOMINATOR);
}

export function decimal4Ratio(numerator: number, denominator: number): string {
  if (denominator <= 0) return '1.0000';
  const scaled = roundedDivide(BigInt(numerator) * MONEY_SCALE, BigInt(denominator));
  return `${scaled / MONEY_SCALE}.${(scaled % MONEY_SCALE).toString().padStart(4, '0')}`;
}

export function subtractDecimalMoney(left: string, right: string): string {
  const parseSigned = (value: string): bigint => {
    const negative = value.startsWith('-');
    const units = parseHourlyRateUnits(negative ? value.slice(1) : value);
    return negative ? -units : units;
  };
  const result = parseSigned(left) - parseSigned(right);
  const sign = result < 0n ? '-' : '';
  const absolute = result < 0n ? -result : result;
  return `${sign}${absolute / MONEY_SCALE}.${(absolute % MONEY_SCALE).toString().padStart(4, '0')}`;
}

function multiplierNumerator(bucket: CaliforniaPayBucket): bigint {
  if (bucket === 'regular') return 2n;
  if (bucket === 'overtime_1_5') return 3n;
  return 4n;
}

function rateForDate(rates: readonly EffectiveRate[], workDate: string): EffectiveRate | null {
  return rates.find(
    (rate) => rate.effective_from <= workDate && (!rate.effective_to || rate.effective_to >= workDate),
  ) ?? null;
}

function addSeconds(accumulator: CostAccumulator, part: CaliforniaClassifiedPart): void {
  if (part.bucket === 'regular') accumulator.regular += part.durationSeconds;
  else if (part.bucket === 'overtime_1_5') accumulator.overtime15 += part.durationSeconds;
  else accumulator.doubleTime += part.durationSeconds;
  accumulator[part.source] += part.durationSeconds;
}

function addCostedPart(
  accumulator: CostAccumulator,
  part: CaliforniaClassifiedPart,
  rateUnits: bigint,
): void {
  const numerator = rateUnits * BigInt(part.durationSeconds) * multiplierNumerator(part.bucket);
  accumulator.costed += part.durationSeconds;
  accumulator.costNumerator += numerator;
  if (part.bucket === 'regular') accumulator.regularCostNumerator += numerator;
  else if (part.bucket === 'overtime_1_5') accumulator.overtimeCostNumerator += numerator;
  else accumulator.doubleTimeCostNumerator += numerator;
}

function publicMetric(accumulator: CostAccumulator): DashboardLaborMetric {
  const total = accumulator.regular + accumulator.overtime15 + accumulator.doubleTime;
  const totalCostUnits = roundedMoneyUnits(accumulator.costNumerator);
  const bucketUnits = {
    regular: roundedMoneyUnits(accumulator.regularCostNumerator),
    overtime_1_5: roundedMoneyUnits(accumulator.overtimeCostNumerator),
    double_time: roundedMoneyUnits(accumulator.doubleTimeCostNumerator),
  };
  // Independent half-up rounding can make the three displayed buckets differ
  // from the rounded exact total by one or two 1/10000-dollar units. Keep the
  // rounded exact total authoritative and assign that tiny residual in stable
  // bucket order. This gives the public accounting identity total = buckets.
  const residual = totalCostUnits
    - bucketUnits.regular
    - bucketUnits.overtime_1_5
    - bucketUnits.double_time;
  if (residual !== 0n) {
    const target = (residual < 0n ? bucketUnits.regular > 0n : accumulator.regularCostNumerator > 0n)
      ? 'regular'
      : (residual < 0n
          ? bucketUnits.overtime_1_5 > 0n
          : accumulator.overtimeCostNumerator > 0n)
        ? 'overtime_1_5'
        : 'double_time';
    bucketUnits[target] += residual;
  }
  const cost = formatMoneyUnits(totalCostUnits);
  return {
    seconds: {
      regular: accumulator.regular,
      overtime_1_5: accumulator.overtime15,
      double_time: accumulator.doubleTime,
      clock: accumulator.clock,
      manual: accumulator.manual,
      total,
      costed: accumulator.costed,
      uncosted: accumulator.uncosted,
    },
    direct_cost_by_bucket_costed: {
      regular: formatMoneyUnits(bucketUnits.regular),
      overtime_1_5: formatMoneyUnits(bucketUnits.overtime_1_5),
      double_time: formatMoneyUnits(bucketUnits.double_time),
    },
    direct_cost_costed: cost,
    direct_cost_complete: accumulator.uncosted === 0 ? cost : null,
    coverage_ratio: decimal4Ratio(accumulator.costed, total),
  };
}

function moneyUnits(value: string): bigint {
  return parseHourlyRateUnits(value);
}

function formatMoneyUnits(units: bigint): string {
  if (units < 0n) throw new Error('direct labor cost cannot be negative');
  return `${units / MONEY_SCALE}.${(units % MONEY_SCALE).toString().padStart(4, '0')}`;
}

/**
 * Each plant is rounded only at the public 4-decimal boundary. Distribute each
 * bucket residual in stable plant order, then derive every plant total from
 * its reconciled buckets. Published values therefore satisfy both accounting
 * identities exactly: organization = sum(plants) and total = sum(buckets).
 */
function reconcilePublishedPlantCosts(
  plants: DashboardPlantCost[],
  organization: DashboardLaborMetric,
): void {
  const reconcile = (
    organizationValue: string,
    read: (plant: DashboardPlantCost) => string,
    write: (plant: DashboardPlantCost, value: string) => void,
    eligible: (plant: DashboardPlantCost) => boolean,
  ): void => {
    const sum = plants.reduce((total, plant) => total + moneyUnits(read(plant)), 0n);
    const difference = moneyUnits(organizationValue) - sum;
    if (difference === 0n) return;
    const candidates = [
      ...plants.filter(eligible),
      ...plants.filter((plant) => !eligible(plant)),
    ];
    if (difference > 0n) {
      const target = candidates[0];
      if (!target) return;
      write(target, formatMoneyUnits(moneyUnits(read(target)) + difference));
      return;
    }
    let remaining = -difference;
    for (const target of candidates) {
      const current = moneyUnits(read(target));
      const take = current < remaining ? current : remaining;
      if (take > 0n) write(target, formatMoneyUnits(current - take));
      remaining -= take;
      if (remaining === 0n) return;
    }
    throw new Error('plant cost rounding reconciliation underflow');
  };
  reconcile(
    organization.direct_cost_by_bucket_costed.regular,
    (plant) => plant.metric.direct_cost_by_bucket_costed.regular,
    (plant, value) => { plant.metric.direct_cost_by_bucket_costed.regular = value; },
    (plant) => plant.metric.seconds.regular > 0,
  );
  reconcile(
    organization.direct_cost_by_bucket_costed.overtime_1_5,
    (plant) => plant.metric.direct_cost_by_bucket_costed.overtime_1_5,
    (plant, value) => { plant.metric.direct_cost_by_bucket_costed.overtime_1_5 = value; },
    (plant) => plant.metric.seconds.overtime_1_5 > 0,
  );
  reconcile(
    organization.direct_cost_by_bucket_costed.double_time,
    (plant) => plant.metric.direct_cost_by_bucket_costed.double_time,
    (plant, value) => { plant.metric.direct_cost_by_bucket_costed.double_time = value; },
    (plant) => plant.metric.seconds.double_time > 0,
  );
  for (const plant of plants) {
    const totalUnits = moneyUnits(plant.metric.direct_cost_by_bucket_costed.regular)
      + moneyUnits(plant.metric.direct_cost_by_bucket_costed.overtime_1_5)
      + moneyUnits(plant.metric.direct_cost_by_bucket_costed.double_time);
    const value = formatMoneyUnits(totalUnits);
    plant.metric.direct_cost_costed = value;
    plant.metric.direct_cost_complete = plant.metric.seconds.uncosted === 0 ? value : null;
  }
}

function thresholdRows(
  employee: EmployeeCostInput,
  classification: ReturnType<typeof classifyCaliforniaOvertime>,
): DashboardThresholdRow[] {
  const rows: DashboardThresholdRow[] = [];
  for (const day of classification.days) {
    const total = day.totalWorkedSeconds;
    if (total >= 12 * 3_600) {
      rows.push({
        employee_id: employee.employee_id,
        employee_number: employee.employee_number,
        full_name: employee.full_name,
        work_date: day.workDate,
        total_seconds: total,
        code: 'at_12h',
        next_threshold_seconds: null,
      });
    } else if (total >= 11 * 3_600) {
      rows.push({
        employee_id: employee.employee_id,
        employee_number: employee.employee_number,
        full_name: employee.full_name,
        work_date: day.workDate,
        total_seconds: total,
        code: 'near_12h',
        next_threshold_seconds: 12 * 3_600,
      });
    } else if (total >= 8 * 3_600) {
      rows.push({
        employee_id: employee.employee_id,
        employee_number: employee.employee_number,
        full_name: employee.full_name,
        work_date: day.workDate,
        total_seconds: total,
        code: 'at_8h',
        next_threshold_seconds: 12 * 3_600,
      });
    } else if (total >= 7 * 3_600) {
      rows.push({
        employee_id: employee.employee_id,
        employee_number: employee.employee_number,
        full_name: employee.full_name,
        work_date: day.workDate,
        total_seconds: total,
        code: 'near_8h',
        next_threshold_seconds: 8 * 3_600,
      });
    }
  }
  const weekly = classification.totalWorkedSeconds;
  if (weekly >= 40 * 3_600) {
    rows.push({
      employee_id: employee.employee_id,
      employee_number: employee.employee_number,
      full_name: employee.full_name,
      work_date: null,
      total_seconds: weekly,
      code: 'at_40h',
      next_threshold_seconds: null,
    });
  } else if (weekly >= 36 * 3_600) {
    rows.push({
      employee_id: employee.employee_id,
      employee_number: employee.employee_number,
      full_name: employee.full_name,
      work_date: null,
      total_seconds: weekly,
      code: 'near_40h',
      next_threshold_seconds: 40 * 3_600,
    });
  }
  return rows;
}

export function calculateWeekCost(input: {
  weekStart: string;
  employees: EmployeeCostInput[];
  plants: PlantRow[];
}): DashboardWeekCost {
  const { weekEnd } = weekBoundsForDate(input.weekStart);
  const organization = emptyAccumulator();
  const byPlant = new Map<string, CostAccumulator>();
  const missing = new Map<string, MissingRateRow & { dates: Set<string> }>();
  const rateFacts = new Map<string, DashboardRateFact & { costNumerator: bigint }>();
  const thresholds: DashboardThresholdRow[] = [];

  for (const employee of input.employees) {
    const chunks = employee.chunks.filter((chunk) => {
      const bounds = weekBoundsForDate(chunk.workDate);
      return bounds.weekStart === input.weekStart;
    });
    if (!chunks.length) continue;
    const classification = classifyCaliforniaOvertime({ weekStart: input.weekStart, chunks });
    thresholds.push(...thresholdRows(employee, classification));
    for (const part of classification.parts) {
      addSeconds(organization, part);
      const plant = byPlant.get(part.plantId) ?? emptyAccumulator();
      addSeconds(plant, part);
      byPlant.set(part.plantId, plant);
      const rate = rateForDate(employee.rates, part.workDate);
      const plantInfo = input.plants.find((plant) => plant.id === part.plantId);
      const factKey = [
        employee.employee_number,
        part.workDate,
        part.plantId,
        part.source,
        part.bucket,
        rate?.hourly_rate ?? 'missing',
      ].join('\u0000');
      const fact = rateFacts.get(factKey) ?? {
        employee_number: employee.employee_number,
        full_name: employee.full_name,
        work_date: part.workDate,
        plant_code: plantInfo?.code ?? '',
        plant_name: plantInfo?.name ?? '',
        source: part.source,
        bucket: part.bucket,
        hourly_rate: rate?.hourly_rate ?? null,
        seconds: 0,
        direct_cost_costed: null,
        costNumerator: 0n,
      };
      fact.seconds += part.durationSeconds;
      rateFacts.set(factKey, fact);
      if (!rate) {
        organization.uncosted += part.durationSeconds;
        plant.uncosted += part.durationSeconds;
        const existing = missing.get(employee.employee_id) ?? {
          employee_id: employee.employee_id,
          employee_number: employee.employee_number,
          full_name: employee.full_name,
          work_dates: [],
          uncosted_seconds: 0,
          dates: new Set<string>(),
        };
        existing.dates.add(part.workDate);
        existing.uncosted_seconds += part.durationSeconds;
        missing.set(employee.employee_id, existing);
        continue;
      }
      const rateUnits = parseHourlyRateUnits(rate.hourly_rate);
      fact.costNumerator += rateUnits * BigInt(part.durationSeconds) * multiplierNumerator(part.bucket);
      addCostedPart(organization, part, rateUnits);
      addCostedPart(plant, part, rateUnits);
    }
  }

  const plantLookup = new Map(input.plants.map((plant) => [plant.id, plant]));
  const plants = [...byPlant.entries()].map(([plantId, accumulator]) => {
    const plant = plantLookup.get(plantId);
    return {
      plant_id: plantId,
      code: plant?.code ?? '',
      name: plant?.name ?? '',
      metric: publicMetric(accumulator),
    };
  }).sort((left, right) => left.code.localeCompare(right.code) || left.plant_id.localeCompare(right.plant_id));

  const metric = publicMetric(organization);
  reconcilePublishedPlantCosts(plants, metric);
  return {
    week_start: input.weekStart,
    week_end: weekEnd,
    metric,
    plants,
    thresholds: thresholds.sort((left, right) =>
      left.employee_number - right.employee_number
      || (left.work_date ?? '').localeCompare(right.work_date ?? '')
      || left.code.localeCompare(right.code)),
    missing_rates: [...missing.values()].map((row) => ({
      employee_id: row.employee_id,
      employee_number: row.employee_number,
      full_name: row.full_name,
      work_dates: [...row.dates].sort(),
      uncosted_seconds: row.uncosted_seconds,
    })).sort((left, right) => left.employee_number - right.employee_number),
    rate_facts: [...rateFacts.values()].map((fact) => ({
      employee_number: fact.employee_number,
      full_name: fact.full_name,
      work_date: fact.work_date,
      plant_code: fact.plant_code,
      plant_name: fact.plant_name,
      source: fact.source,
      bucket: fact.bucket,
      hourly_rate: fact.hourly_rate,
      seconds: fact.seconds,
      direct_cost_costed: fact.hourly_rate === null
        ? null
        : formatMoneyNumerator(fact.costNumerator),
    })).sort((left, right) =>
      left.employee_number - right.employee_number
      || left.work_date.localeCompare(right.work_date)
      || left.plant_code.localeCompare(right.plant_code)
      || left.source.localeCompare(right.source)
      || left.bucket.localeCompare(right.bucket)),
  };
}

export function calculateCostWeeks(inputs: DashboardCostInputs): DashboardWeekCost[] {
  const weeks: string[] = [];
  let cursor = DateTime.fromISO(inputs.from_week_start, { zone: 'utc' });
  const end = DateTime.fromISO(inputs.to_week_end, { zone: 'utc' });
  while (cursor <= end) {
    weeks.push(cursor.toISODate()!);
    cursor = cursor.plus({ days: 7 });
  }
  return weeks.map((weekStart) => calculateWeekCost({
    weekStart,
    employees: inputs.employees,
    plants: inputs.plants,
  }));
}

async function scopedQuery<T extends QueryResultRow>(
  client: PoolClient | undefined,
  text: string,
  params: unknown[],
): Promise<T[]> {
  return client ? (await client.query<T>(text, params)).rows : query<T>(text, params);
}

export function buildSyntheticOpenChunks(input: {
  punches: DashboardProjectionPunch[];
  now: Date;
  timezone: string;
  fromWeekStart: string;
  toWeekEnd: string;
}): SyntheticOpenChunk[] {
  type State =
    | { name: 'out' }
    | { name: 'in'; shiftStart: Date; workStart: Date; employeeId: string; plantId: string }
    | { name: 'meal'; shiftStart: Date; employeeId: string; plantId: string };
  const states = new Map<string, State>();
  for (const punch of input.punches) {
    if (punch.punched_at > input.now) continue;
    const key = `${punch.employee_id}\u0000${punch.plant_id}`;
    const state = states.get(key) ?? { name: 'out' as const };
    if (punch.punch_type === 'shift_in') {
      if (state.name === 'out') {
        states.set(key, {
          name: 'in',
          shiftStart: punch.punched_at,
          workStart: punch.punched_at,
          employeeId: punch.employee_id,
          plantId: punch.plant_id,
        });
      }
    } else if (punch.punch_type === 'meal_out') {
      if (state.name === 'in') {
        states.set(key, {
          name: 'meal',
          shiftStart: state.shiftStart,
          employeeId: state.employeeId,
          plantId: state.plantId,
        });
      }
    } else if (punch.punch_type === 'meal_in') {
      if (state.name === 'meal') {
        states.set(key, {
          name: 'in',
          shiftStart: state.shiftStart,
          workStart: punch.punched_at,
          employeeId: state.employeeId,
          plantId: state.plantId,
        });
      }
    } else if (punch.punch_type === 'shift_out') {
      states.set(key, { name: 'out' });
    }
  }

  const chunks: SyntheticOpenChunk[] = [];
  let order = 2_000_000_000;
  for (const state of states.values()) {
    if (state.name !== 'in') continue;
    const cap = new Date(state.shiftStart.getTime() + 16 * 3_600_000);
    const end = new Date(Math.min(input.now.getTime(), cap.getTime()));
    if (end <= state.workStart) continue;
    let cursor = DateTime.fromJSDate(state.workStart).setZone(input.timezone);
    const endLocal = DateTime.fromJSDate(end).setZone(input.timezone);
    const openSequenceId = `synthetic-open:${state.employeeId}:${state.plantId}:${state.shiftStart.toISOString()}`;
    let part = 0;
    while (cursor < endLocal) {
      const nextMidnight = cursor.startOf('day').plus({ days: 1 });
      const partEnd = nextMidnight < endLocal ? nextMidnight : endLocal;
      const workDate = cursor.toISODate()!;
      const durationSeconds = Math.floor(partEnd.diff(cursor, 'seconds').seconds);
      if (
        durationSeconds > 0
        && workDate >= input.fromWeekStart
        && workDate <= input.toWeekEnd
      ) {
        chunks.push({
          id: `${openSequenceId}:${part}`,
          employee_id: state.employeeId,
          open_sequence_id: openSequenceId,
          workDate,
          durationSeconds,
          plantId: state.plantId,
          source: 'clock',
          order: order++,
          synthetic: true,
          projection_reason: 'open_shift_elapsed',
          capped_at_16_hours: input.now >= cap,
        });
      }
      cursor = partEnd;
      part += 1;
    }
  }
  return chunks;
}

/** Loads all range inputs in bounded batch queries; never one query per employee/week. */
export async function loadDashboardCostInputs(input: {
  organizationId: string;
  fromDate: string;
  toDate: string;
  timezone: string;
  now?: Date;
  client?: PoolClient;
}): Promise<DashboardCostInputs> {
  const fromBounds = weekBoundsForDate(input.fromDate, input.timezone);
  const toBounds = weekBoundsForDate(input.toDate, input.timezone);
  const params = [input.organizationId, fromBounds.weekStart, toBounds.weekEnd, input.timezone];
  const punches = await scopedQuery<DashboardProjectionPunch>(
    input.client,
    `SELECT id, employee_id, plant_id, punch_type, punched_at
     FROM punches
     WHERE organization_id = $1 AND NOT voided
       AND (punched_at AT TIME ZONE $4)::date
           BETWEEN ($2::date - 1) AND ($3::date + 1)
     ORDER BY employee_id, punched_at, created_at, id`,
    params,
  );
  const manual = await scopedQuery<RawManualRow>(
    input.client,
    `SELECT id, employee_id, plant_id, work_date, duration_seconds
     FROM manual_time_entries
     WHERE organization_id = $1 AND voided_at IS NULL
       AND work_date BETWEEN $2::date AND $3::date
     ORDER BY employee_id, work_date, created_at, id`,
    [input.organizationId, fromBounds.weekStart, toBounds.weekEnd],
  );
  const rates = await scopedQuery<RateRow>(
    input.client,
    `SELECT employee_id, hourly_rate::text, effective_from, effective_to
     FROM employee_rates
     WHERE organization_id = $1 AND effective_from <= $3::date
       AND (effective_to IS NULL OR effective_to >= $2::date)
     ORDER BY employee_id, effective_from`,
    [input.organizationId, fromBounds.weekStart, toBounds.weekEnd],
  );
  const employees = await scopedQuery<EmployeeRow>(
    input.client,
    `SELECT id, employee_number, full_name
     FROM employees WHERE organization_id = $1`,
    [input.organizationId],
  );
  const plants = await scopedQuery<PlantRow>(
    input.client,
    `SELECT id, code, name FROM plants WHERE organization_id = $1 ORDER BY code`,
    [input.organizationId],
  );

  const chunksByEmployee = new Map<string, CaliforniaWorkChunk[]>();
  const punchesByEmployee = new Map<string, DashboardProjectionPunch[]>();
  for (const punch of punches) {
    const list = punchesByEmployee.get(punch.employee_id) ?? [];
    list.push(punch);
    punchesByEmployee.set(punch.employee_id, list);
  }
  for (const [employeeId, employeePunches] of punchesByEmployee) {
    const segments = buildWorkSegments(employeePunches.map((punch) => ({
      id: punch.id,
      type: punch.punch_type,
      time: punch.punched_at,
      plantId: punch.plant_id,
    })));
    chunksByEmployee.set(
      employeeId,
      segments.chunks.filter(
        (chunk) => chunk.workDate >= fromBounds.weekStart && chunk.workDate <= toBounds.weekEnd,
      ),
    );
  }
  for (const [order, entry] of manual.entries()) {
    const list = chunksByEmployee.get(entry.employee_id) ?? [];
    list.push({
      id: `manual:${entry.id}`,
      workDate: entry.work_date,
      durationSeconds: Number(entry.duration_seconds),
      plantId: entry.plant_id,
      source: 'manual',
      order,
    });
    chunksByEmployee.set(entry.employee_id, list);
  }

  const ratesByEmployee = new Map<string, EffectiveRate[]>();
  for (const rate of rates) {
    const list = ratesByEmployee.get(rate.employee_id) ?? [];
    list.push({
      hourly_rate: rate.hourly_rate,
      effective_from: rate.effective_from,
      effective_to: rate.effective_to,
    });
    ratesByEmployee.set(rate.employee_id, list);
  }
  const employeeById = new Map(employees.map((employee) => [employee.id, employee]));
  const syntheticOpenChunks = buildSyntheticOpenChunks({
    punches,
    now: input.now ?? new Date(),
    timezone: input.timezone,
    fromWeekStart: fromBounds.weekStart,
    toWeekEnd: toBounds.weekEnd,
  });
  const relevantIds = new Set([
    ...chunksByEmployee.keys(),
    ...syntheticOpenChunks.map((chunk) => chunk.employee_id),
  ]);

  return {
    from_week_start: fromBounds.weekStart,
    to_week_end: toBounds.weekEnd,
    employees: [...relevantIds].flatMap((employeeId) => {
      const employee = employeeById.get(employeeId);
      if (!employee) return [];
      return [{
        employee_id: employee.id,
        employee_number: employee.employee_number,
        full_name: employee.full_name,
        chunks: chunksByEmployee.get(employee.id) ?? [],
        rates: ratesByEmployee.get(employee.id) ?? [],
      }];
    }),
    plants,
    synthetic_open_chunks: syntheticOpenChunks,
  };
}

export function withSyntheticOpenProjection(inputs: DashboardCostInputs): DashboardCostInputs {
  const syntheticByEmployee = new Map<string, SyntheticOpenChunk[]>();
  for (const chunk of inputs.synthetic_open_chunks) {
    const list = syntheticByEmployee.get(chunk.employee_id) ?? [];
    list.push(chunk);
    syntheticByEmployee.set(chunk.employee_id, list);
  }
  return {
    ...inputs,
    employees: inputs.employees.map((employee) => ({
      ...employee,
      chunks: [...employee.chunks, ...(syntheticByEmployee.get(employee.employee_id) ?? [])],
    })),
  };
}

export function mergeMetrics(metrics: readonly DashboardLaborMetric[]): DashboardLaborMetric {
  const accumulator = emptyAccumulator();
  for (const metric of metrics) {
    accumulator.regular += metric.seconds.regular;
    accumulator.overtime15 += metric.seconds.overtime_1_5;
    accumulator.doubleTime += metric.seconds.double_time;
    accumulator.clock += metric.seconds.clock;
    accumulator.manual += metric.seconds.manual;
    accumulator.costed += metric.seconds.costed;
    accumulator.uncosted += metric.seconds.uncosted;
    // Public metrics have already been rounded to 4 decimal dollars. This
    // helper is for trend presentation only; exact weekly costing occurs above.
    accumulator.costNumerator += parseHourlyRateUnits(metric.direct_cost_costed) * COST_DENOMINATOR;
    accumulator.regularCostNumerator +=
      parseHourlyRateUnits(metric.direct_cost_by_bucket_costed.regular) * COST_DENOMINATOR;
    accumulator.overtimeCostNumerator +=
      parseHourlyRateUnits(metric.direct_cost_by_bucket_costed.overtime_1_5) * COST_DENOMINATOR;
    accumulator.doubleTimeCostNumerator +=
      parseHourlyRateUnits(metric.direct_cost_by_bucket_costed.double_time) * COST_DENOMINATOR;
  }
  return publicMetric(accumulator);
}

/** Frozen admin-only cost view created beside every future final report. */
export async function buildAdminDirectCostSnapshot(input: {
  organizationId: string;
  weekStart: string;
  timezone: string;
  reportVersion: number;
  createdAt: Date;
  client: PoolClient;
}): Promise<AdminDirectCostSnapshotV1> {
  const bounds = weekBoundsForDate(input.weekStart, input.timezone);
  const inputs = await loadDashboardCostInputs({
    organizationId: input.organizationId,
    fromDate: bounds.weekStart,
    toDate: bounds.weekEnd,
    timezone: input.timezone,
    now: input.createdAt,
    client: input.client,
  });
  const week = calculateCostWeeks(inputs).find((candidate) => candidate.week_start === bounds.weekStart);
  if (!week) throw new Error('cost snapshot week was not calculated');
  return {
    schema_version: 1,
    contract: 'clockai-admin-direct-cost-v1',
    report_version: input.reportVersion,
    week_start: bounds.weekStart,
    week_end: bounds.weekEnd,
    timezone: input.timezone,
    created_at: input.createdAt.toISOString(),
    disclaimer: 'estimated_direct_labor_only_excludes_taxes_benefits_burden',
    week,
  };
}
