import { query } from '../db.js';
import { config } from '../config.js';

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
  weekly_ot_threshold_minutes: 48 * 60,
  week_start_day: 1,
  photo_retention_weeks: 8,
  duplicate_window_minutes: 2,
  work_days: [1, 2, 3, 4, 5, 6],
  timezone: config.plantTimezone,
};

let cache: { value: AppSettings; at: number } | null = null;
const CACHE_MS = 30_000;

export async function getSettings(): Promise<AppSettings> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const rows = await query<{ key: string; value: unknown }>(`SELECT key, value FROM settings`);
  const merged = { ...DEFAULT_SETTINGS } as Record<string, unknown>;
  for (const row of rows) {
    if (row.key in merged) merged[row.key] = row.value;
  }
  cache = { value: merged as unknown as AppSettings, at: Date.now() };
  return cache.value;
}

export function invalidateSettingsCache(): void {
  cache = null;
}

export async function updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  for (const [key, value] of Object.entries(patch)) {
    await query(
      `INSERT INTO settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`,
      [key, JSON.stringify(value)]
    );
  }
  invalidateSettingsCache();
  return getSettings();
}
