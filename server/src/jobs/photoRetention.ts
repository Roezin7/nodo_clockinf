/**
 * Job de retención: borra del object storage las fotos de checada con más de
 * N semanas (settings.photo_retention_weeks) y limpia photo_key en el punch.
 * La checada en sí NUNCA se borra. Los enrolamientos versionados tampoco se
 * borran aquí: conservan la cadena histórica incluso si el empleado se desactiva.
 */
import { query } from '../db.js';
import { storage } from '../storage.js';
import { getSettings } from '../services/settingsService.js';

const BATCH = 200;

export async function cleanupIdentityAttemptEvidence(
  organizationId: string,
  cutoff: Date
): Promise<number> {
  let total = 0;
  for (;;) {
    const rows = await query<{
      id: string;
      evidence_key: string;
      evidence_sha256: string;
    }>(
      `SELECT a.id, a.evidence_key, a.evidence_sha256
       FROM identity_attempts a
       JOIN identity_sessions s ON s.id = a.session_id AND s.organization_id = a.organization_id
       LEFT JOIN identity_evidence_purges ep ON ep.attempt_id = a.id
       WHERE a.organization_id = $1
         AND CASE WHEN s.mode = 'offline_fallback' THEN s.captured_at ELSE s.server_started_at END < $2
         AND ep.attempt_id IS NULL
       ORDER BY CASE WHEN s.mode = 'offline_fallback' THEN s.captured_at ELSE s.server_started_at END
       LIMIT ${BATCH}`,
      [organizationId, cutoff]
    );
    if (!rows.length) break;
    let progressed = 0;
    for (const row of rows) {
      try {
        await storage.remove(row.evidence_key);
        await query(
          `INSERT INTO identity_evidence_purges
             (organization_id, attempt_id, evidence_key, evidence_sha256, reason)
           VALUES ($1, $2, $3, $4, 'photo_retention_policy')
           ON CONFLICT (attempt_id) DO NOTHING`,
          [organizationId, row.id, row.evidence_key, row.evidence_sha256]
        );
        total += 1;
        progressed += 1;
      } catch (err) {
        console.error(`retention: fallo al purgar evidencia ${row.evidence_key}`, err);
      }
    }
    if (rows.length < BATCH || progressed === 0) break;
  }
  return total;
}

/**
 * Purges one tenant against an explicit cutoff. Exported so the retention
 * boundary (capture time vs. upload time) can be integration-tested without
 * changing the tenant's production policy.
 */
export async function cleanupOrganizationPhotoEvidence(
  organizationId: string,
  cutoff: Date
): Promise<number> {
  // Identity evidence is authoritative for whether the bytes still exist.
  // Purge it first so a punch preview can never delete an object while an
  // unpurged attempt still advertises that object as available.
  let total = await cleanupIdentityAttemptEvidence(organizationId, cutoff);
  for (;;) {
    const rows = await query<{ id: string; photo_key: string }>(
      `SELECT id, photo_key FROM punches
       WHERE organization_id = $1 AND photo_key IS NOT NULL
         AND CASE WHEN offline THEN captured_at ELSE punched_at END < $2
       LIMIT ${BATCH}`,
      [organizationId, cutoff]
    );
    if (!rows.length) break;
    let progressed = 0;
    for (const row of rows) {
      try {
        const referenced = await query<{ exists: boolean }>(
          `SELECT EXISTS (
             SELECT 1
             FROM identity_attempts a
             LEFT JOIN identity_evidence_purges ep ON ep.attempt_id = a.id
             WHERE a.organization_id = $1 AND a.evidence_key = $2
               AND ep.attempt_id IS NULL
           ) AS exists`,
          [organizationId, row.photo_key]
        );
        if (!referenced[0]?.exists) await storage.remove(row.photo_key);
        await query(
          `UPDATE punches SET photo_key = NULL WHERE id = $1 AND organization_id = $2`,
          [row.id, organizationId]
        );
        total += 1;
        progressed += 1;
      } catch (err) {
        console.error(`retention: fallo al borrar ${row.photo_key}`, err);
      }
    }
    if (rows.length < BATCH || progressed === 0) break;
  }
  return total;
}

export async function cleanupOldPunchPhotos(): Promise<number> {
  let total = 0;
  const organizations = await query<{ id: string }>(`SELECT id FROM organizations WHERE active`);
  for (const organization of organizations) {
    const settings = await getSettings(organization.id);
    const cutoff = new Date(
      Date.now() - settings.photo_retention_weeks * 7 * 24 * 3600 * 1000
    );
    total += await cleanupOrganizationPhotoEvidence(organization.id, cutoff);
  }
  if (total > 0) console.log(`retention: ${total} evidencias fotográficas purgadas`);
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
