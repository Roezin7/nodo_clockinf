/**
 * Job de retención: borra del object storage las fotos de checada con más de
 * N semanas (settings.photo_retention_weeks) y limpia photo_key en el punch.
 * La checada en sí NUNCA se borra; la foto de enrolamiento tampoco (se
 * conserva mientras el empleado esté activo).
 */
import { query } from '../db.js';
import { storage } from '../storage.js';
import { getSettings } from '../services/settingsService.js';

const BATCH = 200;

export async function cleanupOldPunchPhotos(): Promise<number> {
  let total = 0;
  const organizations = await query<{ id: string }>(`SELECT id FROM organizations WHERE active`);
  for (const organization of organizations) {
    const settings = await getSettings(organization.id);
    const cutoff = new Date(
      Date.now() - settings.photo_retention_weeks * 7 * 24 * 3600 * 1000
    );
    for (;;) {
      const rows = await query<{ id: string; photo_key: string }>(
        `SELECT id, photo_key FROM punches
         WHERE organization_id = $1 AND photo_key IS NOT NULL AND punched_at < $2
         LIMIT ${BATCH}`,
        [organization.id, cutoff]
      );
      if (!rows.length) break;
      for (const row of rows) {
        try {
          await storage.remove(row.photo_key);
          await query(
            `UPDATE punches SET photo_key = NULL WHERE id = $1 AND organization_id = $2`,
            [row.id, organization.id]
          );
          total += 1;
        } catch (err) {
          console.error(`retention: fallo al borrar ${row.photo_key}`, err);
        }
      }
      if (rows.length < BATCH) break;
    }
  }
  if (total > 0) console.log(`retention: ${total} fotos de checada borradas`);
  return total;
}

/** Corre al arrancar y luego cada 12 horas. */
export function schedulePhotoRetention(): void {
  const run = (): void => {
    void cleanupOldPunchPhotos().catch((err) => console.error('retention job:', err));
  };
  setTimeout(run, 30_000); // al arrancar, con margen para que todo suba
  setInterval(run, 12 * 3600 * 1000);
}
