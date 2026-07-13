/**
 * Seed idempotente para la operación acordada en Modesto:
 * tres plantas, semana domingo-sábado y turno 05:00–13:30 con meal 09:00–09:30.
 */
import bcrypt from 'bcryptjs';
import { pool, query, queryOne } from './db.js';

function requiredBootstrapVariable(name: 'SEED_ADMIN_EMAIL' | 'SEED_ADMIN_PASSWORD'): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} es obligatorio`);
  return value;
}

const ADMIN_EMAIL = requiredBootstrapVariable('SEED_ADMIN_EMAIL');
const ADMIN_PASSWORD = requiredBootstrapVariable('SEED_ADMIN_PASSWORD');

if (ADMIN_PASSWORD.length < 12) {
  throw new Error('SEED_ADMIN_EMAIL y SEED_ADMIN_PASSWORD (mínimo 12 caracteres) son obligatorios');
}
if (process.env.NODE_ENV === 'production' && process.env.ALLOW_PRODUCTION_BOOTSTRAP !== 'yes') {
  throw new Error('En producción define ALLOW_PRODUCTION_BOOTSTRAP=yes solo para el bootstrap único');
}

async function seed(): Promise<void> {
  const organization = await queryOne<{ id: string }>(
    `INSERT INTO organizations (name, slug, timezone)
     VALUES ('Modesto Packing Operations', 'modesto-packing', 'America/Los_Angeles')
     ON CONFLICT (slug) DO NOTHING
     RETURNING id`
  );
  const organizationId = organization!.id;

  for (const [code, name] of [
    ['P1', 'Plant 1'],
    ['P2', 'Plant 2'],
    ['P3', 'Plant 3'],
  ]) {
    await query(
      `INSERT INTO plants (organization_id, code, name)
       VALUES ($1, $2, $3)
       ON CONFLICT (organization_id, code) DO NOTHING`,
      [organizationId, code, name]
    );
  }

  const shift = await queryOne<{ id: string }>(
    `SELECT id FROM shifts WHERE organization_id = $1 AND name = 'Turno estándar'`,
    [organizationId]
  );
  if (!shift) {
    await query(
      `INSERT INTO shifts
         (organization_id, name, start_time, end_time, tolerance_minutes, meal_windows)
       VALUES ($1, 'Turno estándar', '05:00', '13:30', 0, $2)`,
      [
        organizationId,
        JSON.stringify([{ name: 'Meal', start: '09:00', end: '09:30', paid: false }]),
      ]
    );
  }

  const admin = await queryOne(`SELECT id FROM users WHERE lower(email) = lower($1)`, [ADMIN_EMAIL]);
  if (!admin) {
    await query(
      `INSERT INTO users (email, password_hash, role, name, organization_id)
       VALUES (lower($1), $2, 'admin', 'Administrador', $3)`,
      [ADMIN_EMAIL, await bcrypt.hash(ADMIN_PASSWORD, 12), organizationId]
    );
    console.log(`Admin creado: ${ADMIN_EMAIL} (cambiar contraseña en producción)`);
  }

  const defaults: Record<string, unknown> = {
    daily_ot_threshold_minutes: 8 * 60,
    weekly_ot_threshold_minutes: 40 * 60,
    week_start_day: 7,
    photo_retention_weeks: 13,
    duplicate_window_minutes: 2,
    work_days: [1, 2, 3, 4, 5, 6, 7],
  };
  for (const [key, value] of Object.entries(defaults)) {
    await query(
      `INSERT INTO settings (organization_id, key, value)
       VALUES ($1, $2, $3)
       ON CONFLICT (organization_id, key) DO NOTHING`,
      [organizationId, key, JSON.stringify(value)]
    );
  }

  console.log('Seed de Modesto completo.');
}

seed()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
