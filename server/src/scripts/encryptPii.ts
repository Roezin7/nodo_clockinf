import { pool, withTransaction } from '../db.js';
import { encryptSensitiveValue, isEncryptedSensitiveValue } from '../services/piiCrypto.js';

async function migrateBatch(): Promise<number> {
  return withTransaction(async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('clockai-pii-migration'))`);
    const rows = await client.query<{ id: string; social_security: string }>(
      `SELECT id, social_security
       FROM employees
       WHERE social_security IS NOT NULL AND social_security NOT LIKE 'enc:v1:%'
       ORDER BY id
       LIMIT 500
       FOR UPDATE`,
    );
    for (const row of rows.rows) {
      if (isEncryptedSensitiveValue(row.social_security)) continue;
      await client.query(
        `UPDATE employees SET social_security = $2 WHERE id = $1`,
        [row.id, encryptSensitiveValue(row.social_security)],
      );
    }
    return rows.rowCount ?? 0;
  });
}

async function main(): Promise<void> {
  let migrated = 0;
  for (;;) {
    const count = await migrateBatch();
    migrated += count;
    if (count < 500) break;
  }
  console.log(JSON.stringify({ level: 'info', event: 'pii_migration_complete', migrated }));
}

main()
  .catch((error) => {
    console.error(JSON.stringify({ level: 'error', event: 'pii_migration_failed', message: String(error) }));
    process.exitCode = 1;
  })
  .finally(() => pool.end());
