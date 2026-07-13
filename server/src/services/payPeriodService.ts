import crypto from 'node:crypto';
import { DateTime } from 'luxon';
import type { PoolClient } from 'pg';
import { conflict } from '../errors.js';

export type PayPeriodStatus = 'open' | 'ready_for_review' | 'final' | 'reopened';

export interface PayPeriodRow {
  id: string;
  organization_id: string;
  week_start: string;
  week_end: string;
  status: PayPeriodStatus;
  current_version: number;
  finalized_at: Date | null;
  finalized_by: string | null;
  reopened_at: Date | null;
  reopened_by: string | null;
  reopen_reason: string | null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function weekBoundsForDate(
  date: string,
  timezone = 'America/Los_Angeles'
): { weekStart: string; weekEnd: string } {
  if (!DATE_RE.test(date)) throw new Error('date must use YYYY-MM-DD');
  const local = DateTime.fromISO(date, { zone: timezone });
  if (!local.isValid || local.toISODate() !== date) throw new Error('date is invalid');
  const daysSinceSunday = local.weekday % 7;
  const weekStart = local.minus({ days: daysSinceSunday }).toISODate()!;
  const weekEnd = local.plus({ days: 6 - daysSinceSunday }).toISODate()!;
  return { weekStart, weekEnd };
}

/** Serializes finalization and every mutation for the same tenant/week. */
export async function lockPayPeriod(
  client: PoolClient,
  organizationId: string,
  workDate: string,
  timezone = 'America/Los_Angeles'
): Promise<PayPeriodRow> {
  const { weekStart, weekEnd } = weekBoundsForDate(workDate, timezone);
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`, [
    organizationId,
    weekStart,
  ]);
  await client.query(
    `INSERT INTO pay_periods (organization_id, week_start, week_end)
     VALUES ($1, $2::date, $3::date)
     ON CONFLICT (organization_id, week_start) DO NOTHING`,
    [organizationId, weekStart, weekEnd]
  );
  const result = await client.query<PayPeriodRow>(
    `SELECT * FROM pay_periods
     WHERE organization_id = $1 AND week_start = $2::date
     FOR UPDATE`,
    [organizationId, weekStart]
  );
  if (!result.rows[0]) throw new Error('could not lock pay period');
  return result.rows[0];
}

export async function ensurePeriodOpen(
  client: PoolClient,
  organizationId: string,
  workDate: string,
  timezone = 'America/Los_Angeles'
): Promise<PayPeriodRow> {
  const period = await lockPayPeriod(client, organizationId, workDate, timezone);
  if (period.status === 'final') {
    throw conflict('La semana está cerrada; el admin debe reabrirla antes de corregir', 'period_final');
  }
  if (period.status === 'ready_for_review') {
    throw conflict(
      'La semana está en revisión; el admin debe devolverla a edición antes de corregir',
      'period_ready_for_review',
    );
  }
  return period;
}

export function canFinalizeWeek(
  weekEnd: string,
  now = new Date(),
  timezone = 'America/Los_Angeles'
): boolean {
  const today = DateTime.fromJSDate(now).setZone(timezone).toISODate();
  return Boolean(today && today > weekEnd);
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalValue(item));
  if (value && typeof value === 'object') {
    if (value instanceof Date) return value.toISOString();
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalValue(item)])
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function snapshotHash(value: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}
