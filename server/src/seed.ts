/**
 * Seed idempotente: áreas, turnos, usuario admin y settings default.
 *
 * ⚠️ PLACEHOLDER: los horarios de los turnos (Mañana 07:00–17:00, Cleaning
 * 17:00–23:00) son provisionales. Confirmar los horarios reales con la planta
 * y ajustarlos desde el panel de Configuración antes de usar en producción.
 */
import bcrypt from 'bcryptjs';
import { pool, query, queryOne } from './db.js';

const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? 'admin@nodo.local';
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? 'admin1234';

async function seed(): Promise<void> {
  for (const name of ['Empaque Elote', 'Empaque Espárrago', 'Cleaning', 'Shipping']) {
    await query(`INSERT INTO areas (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`, [name]);
  }

  const shiftCount = await queryOne<{ n: string }>(`SELECT count(*) AS n FROM shifts`);
  if (shiftCount?.n === '0') {
    await query(
      `INSERT INTO shifts (name, start_time, end_time, tolerance_minutes, meal_windows)
       VALUES
        ('Mañana', '07:00', '17:00', 5, $1),
        ('Cleaning', '17:00', '23:00', 5, '[]')`,
      [JSON.stringify([{ name: 'Comida', start: '13:00', end: '13:30', paid: false }])]
    );
    console.log('Turnos sembrados (HORARIOS PLACEHOLDER — ajustar en Configuración)');
  }

  const admin = await queryOne(`SELECT id FROM users WHERE email = $1`, [ADMIN_EMAIL]);
  if (!admin) {
    await query(
      `INSERT INTO users (email, password_hash, role, name) VALUES ($1, $2, 'admin', 'Administrador')`,
      [ADMIN_EMAIL, await bcrypt.hash(ADMIN_PASSWORD, 10)]
    );
    console.log(`Admin creado: ${ADMIN_EMAIL} / ${ADMIN_PASSWORD} (cambiar en producción)`);
  }

  const defaults: Record<string, unknown> = {
    daily_ot_threshold_minutes: 8 * 60,
    weekly_ot_threshold_minutes: 48 * 60,
    week_start_day: 1, // lunes
    photo_retention_weeks: 8,
    duplicate_window_minutes: 2,
  };
  for (const [key, value] of Object.entries(defaults)) {
    await query(
      `INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`,
      [key, JSON.stringify(value)]
    );
  }

  console.log('Seed completo.');
}

seed()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
