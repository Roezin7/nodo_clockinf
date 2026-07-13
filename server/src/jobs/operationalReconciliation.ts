import { DateTime } from 'luxon';
import { query, withTransaction } from '../db.js';
import { reconcileOperationalExceptions } from '../services/operationalExceptions.js';
import { getSettings } from '../services/settingsService.js';
import { weekBoundsForDate } from '../services/payPeriodService.js';

export function operationalReconciliationWindow(
  now: Date,
  timezone = 'America/Los_Angeles',
): { fromDate: string; toDate: string } {
  const local = DateTime.fromJSDate(now).setZone(timezone);
  if (!local.isValid) throw new Error('invalid reconciliation time');
  const toDate = local.toISODate()!;
  const currentWeek = weekBoundsForDate(toDate, timezone);
  return {
    // Keep the previous payroll week live through Sunday close/reconciliation.
    fromDate: DateTime.fromISO(currentWeek.weekStart, { zone: timezone })
      .minus({ days: 7 })
      .toISODate()!,
    toDate,
  };
}

export interface OperationalReconciliationDateWindow {
  fromDate: string;
  toDate: string;
}

/** Live window plus every explicitly reopened historical payroll week. */
export function operationalReconciliationWindows(
  now: Date,
  timezone: string,
  reopened: readonly { week_start: string; week_end: string }[],
): OperationalReconciliationDateWindow[] {
  const live = operationalReconciliationWindow(now, timezone);
  const unique = new Map<string, OperationalReconciliationDateWindow>([
    [`${live.fromDate}:${live.toDate}`, live],
  ]);
  for (const period of reopened) {
    const bounds = weekBoundsForDate(period.week_start, timezone);
    if (bounds.weekStart !== period.week_start || bounds.weekEnd !== period.week_end) {
      throw new Error('reopened pay period has invalid Sunday-Saturday bounds');
    }
    unique.set(`${period.week_start}:${period.week_end}`, {
      fromDate: period.week_start,
      toDate: period.week_end,
    });
  }
  return [...unique.values()].sort(
    (left, right) => left.fromDate.localeCompare(right.fromDate) || left.toDate.localeCompare(right.toDate),
  );
}

export async function reconcileAllOperationalExceptions(now = new Date()): Promise<number> {
  const organizations = await query<{ id: string }>(
    `SELECT id FROM organizations WHERE active ORDER BY id`,
  );
  let changed = 0;
  for (const organization of organizations) {
    const settings = await getSettings(organization.id);
    const reopened = await query<{ week_start: string; week_end: string }>(
      `SELECT week_start::text, week_end::text
       FROM pay_periods
       WHERE organization_id = $1 AND status = 'reopened'
       ORDER BY week_start`,
      [organization.id],
    );
    const windows = operationalReconciliationWindows(now, settings.timezone, reopened);
    for (const window of windows) {
      const result = await withTransaction((client) =>
        reconcileOperationalExceptions(client, {
          organizationId: organization.id,
          fromDate: window.fromDate,
          toDate: window.toDate,
          timezone: settings.timezone,
          now,
        }),
      );
      changed += result.opened + result.reopened + result.refreshed + result.resolved;
    }
  }
  return changed;
}

export function scheduleOperationalReconciliation(): void {
  let running = false;
  const run = (): void => {
    if (running) return;
    running = true;
    void reconcileAllOperationalExceptions()
      .then((changed) => {
        if (changed > 0) console.log(`operational exceptions: ${changed} lifecycle change(s)`);
      })
      .catch((error) => console.error('operational exception reconciliation:', error))
      .finally(() => {
        running = false;
      });
  };
  setTimeout(run, 15_000);
  setInterval(run, 60_000);
}
