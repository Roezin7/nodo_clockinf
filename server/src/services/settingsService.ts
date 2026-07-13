import { query } from '../db.js';

/** Zonas horarias permitidas (debe coincidir con ALLOWED_TIMEZONES de @clockai/shared). */
export const ALLOWED_TIMEZONE_IDS = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Phoenix',
  'America/Los_Angeles',
  'America/Anchorage',
  'Pacific/Honolulu',
  'America/Mexico_City',
] as const;

export interface AppSettings {
  daily_ot_threshold_minutes: number;
  weekly_ot_threshold_minutes: number;
  /** Día de inicio de semana, ISO: 1=lunes … 7=domingo */
  week_start_day: number;
  photo_retention_weeks: number;
  duplicate_window_minutes: number;
  /** Días laborables (ISO 1=lunes … 7=domingo) para contar faltas */
  work_days: number[];
  /** Zona horaria de la planta: única fuente de verdad para cortes de día y presentación. */
  timezone: string;
}

export const DEFAULT_SETTINGS: AppSettings = {
  daily_ot_threshold_minutes: 8 * 60,
  weekly_ot_threshold_minutes: 40 * 60,
  week_start_day: 7,
  photo_retention_weeks: 13,
  duplicate_window_minutes: 2,
  work_days: [1, 2, 3, 4, 5, 6, 7],
  timezone: 'America/Los_Angeles',
};

const cache = new Map<string, { value: AppSettings; at: number }>();
const CACHE_MS = 30_000;

async function resolveOrganizationId(organizationId?: string): Promise<string> {
  if (organizationId) return organizationId;
  const rows = await query<{ id: string }>(
    `SELECT id FROM organizations WHERE active ORDER BY created_at LIMIT 1`
  );
  if (!rows[0]) throw new Error('No hay organización activa');
  return rows[0].id;
}

export async function getSettings(organizationId?: string): Promise<AppSettings> {
  const resolvedId = await resolveOrganizationId(organizationId);
  const cached = cache.get(resolvedId);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  const rows = await query<{ key: string; value: unknown; timezone: string }>(
    `SELECT s.key, s.value, o.timezone
     FROM organizations o
     LEFT JOIN settings s ON s.organization_id = o.id
     WHERE o.id = $1`,
    [resolvedId]
  );
  const merged = { ...DEFAULT_SETTINGS } as Record<string, unknown>;
  for (const row of rows) {
    if (row.key && row.key in merged) merged[row.key] = row.value;
  }
  if (rows[0]?.timezone) merged.timezone = rows[0].timezone;
  const value = merged as unknown as AppSettings;
  cache.set(resolvedId, { value, at: Date.now() });
  return value;
}

export function invalidateSettingsCache(organizationId?: string): void {
  if (organizationId) cache.delete(organizationId);
  else cache.clear();
}

export async function updateSettings(
  organizationId: string,
  patch: Partial<AppSettings>
): Promise<AppSettings> {
  const { timezone, ...storedPatch } = patch;
  if (timezone !== undefined) {
    await query(`UPDATE organizations SET timezone = $2 WHERE id = $1`, [organizationId, timezone]);
  }
  for (const [key, value] of Object.entries(storedPatch)) {
    await query(
      `INSERT INTO settings (organization_id, key, value) VALUES ($1, $2, $3)
       ON CONFLICT (organization_id, key)
       DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [organizationId, key, JSON.stringify(value)]
    );
  }
  invalidateSettingsCache(organizationId);
  return getSettings(organizationId);
}
