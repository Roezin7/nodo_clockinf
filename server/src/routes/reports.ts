import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, withTransaction } from '../db.js';
import { badRequest, conflict, notFound, HttpError } from '../errors.js';
import {
  requireAuth,
  requireAdmin,
  requireOrganization,
  requireRole,
} from '../middleware/auth.js';
import { computeWeek } from '../services/attendanceService.js';
import { getSettings } from '../services/settingsService.js';
import {
  canFinalizeWeek,
  lockPayPeriod,
  snapshotHash,
  weekBoundsForDate,
  type PayPeriodStatus,
} from '../services/payPeriodService.js';
import { recordAudit } from '../services/auditService.js';
import {
  deviceHealthReasons,
  periodHeartbeatBoundary,
} from '../services/deviceHealth.js';
import { deriveFinalizationBlockers } from '../services/operationalExceptions.js';
import {
  ACCOUNTANT_REPORT_CONTRACT,
  ACCOUNTANT_REPORT_SCHEMA_VERSION,
  ACCOUNTANT_REPORT_TEMPLATE_VERSION,
  adaptLegacySnapshot,
  buildAccountantSnapshot,
  renderReportArtifacts,
  sanitizeAccountantSnapshot,
  type SafeAccountantReport,
} from '../services/accountantReport.js';
import { buildAdminDirectCostSnapshot } from '../services/dashboardCosts.js';

export const reportsRouter = Router();
reportsRouter.use(requireAuth, requireRole('admin', 'accountant'));

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Normaliza cualquier fecha al inicio de su semana según settings.week_start_day. */
async function normalizeWeekStart(organizationId: string, date: string): Promise<string> {
  const settings = await getSettings(organizationId);
  return weekBoundsForDate(date, settings.timezone).weekStart;
}

interface PeriodReportRow {
  id: string;
  week_start: string;
  week_end: string;
  status: PayPeriodStatus;
  current_version: number;
  snapshot: unknown | null;
  snapshot_hash: string | null;
  snapshot_schema_version: number | null;
  snapshot_contract: string | null;
  hash_algorithm: 'md5' | 'sha256' | null;
  finalized_at: Date | null;
}

interface DeviceHealthBlocker {
  id: string;
  name: string;
  plant_name: string;
  reasons: string[];
  pending_event_count: number;
  rejected_event_count: number;
  last_heartbeat_at: Date | null;
  storage_status: 'unknown' | 'ready' | 'degraded' | 'unavailable';
}

async function finalizationDeviceHealthBlockers(
  client: import('pg').PoolClient,
  organizationId: string,
  requiredHeartbeatAfter: Date,
  now = new Date()
): Promise<DeviceHealthBlocker[]> {
  const result = await client.query<{
    id: string;
    name: string;
    plant_name: string;
    pending_event_count: number;
    rejected_event_count: number;
    last_heartbeat_at: Date | null;
    storage_status: 'unknown' | 'ready' | 'degraded' | 'unavailable';
  }>(
    `SELECT d.id, d.name, p.name AS plant_name, d.pending_event_count,
            d.rejected_event_count, d.last_heartbeat_at, d.storage_status
     FROM devices d
     JOIN plants p ON p.id = d.plant_id AND p.organization_id = d.organization_id
     WHERE d.organization_id = $1 AND d.active AND d.enrolled_at IS NOT NULL
     ORDER BY p.code, d.name`,
    [organizationId]
  );
  return result.rows.flatMap((device) => {
    const reasons = deviceHealthReasons(device, now, requiredHeartbeatAfter);
    return reasons.length ? [{ ...device, reasons }] : [];
  });
}

async function getPeriodReport(organizationId: string, weekStart: string): Promise<PeriodReportRow | null> {
  return queryOne<PeriodReportRow>(
    `SELECT p.id, p.week_start, p.week_end, p.status, p.current_version,
            rv.snapshot, rv.snapshot_hash, rv.snapshot_schema_version,
            rv.snapshot_contract, rv.hash_algorithm, rv.finalized_at
     FROM pay_periods p
     LEFT JOIN report_versions rv
       ON rv.pay_period_id = p.id AND rv.version = p.current_version
     WHERE p.organization_id = $1 AND p.week_start = $2::date`,
    [organizationId, weekStart]
  );
}

function privateNoStore(res: import('express').Response): void {
  res.header('Cache-Control', 'private, no-store, max-age=0');
  res.header('Pragma', 'no-cache');
}

function quotedEtag(hash: string): string {
  return `"${hash}"`;
}

function respondWithSnapshot(
  req: import('express').Request,
  res: import('express').Response,
  snapshot: SafeAccountantReport,
  metadata: {
    snapshotHash: string;
    hashAlgorithm: 'md5' | 'sha256';
    periodStatus: PayPeriodStatus;
    isCurrentFinal: boolean;
    detailAvailable: boolean;
  },
): void {
  privateNoStore(res);
  const etag = quotedEtag(
    `${metadata.hashAlgorithm}-${metadata.snapshotHash}-${metadata.periodStatus}-${metadata.isCurrentFinal ? 1 : 0}`,
  );
  res.header('ETag', etag);
  if (req.headers['if-none-match'] === etag) {
    res.status(304).end();
    return;
  }
  res.json({
    ...snapshot,
    period_status: metadata.periodStatus,
    is_current_final: metadata.isCurrentFinal,
    detail_available: metadata.detailAvailable,
    snapshot_hash: metadata.snapshotHash,
    hash_algorithm: metadata.hashAlgorithm,
  });
}

function safeSnapshotFromRow(input: {
  snapshot: unknown;
  schemaVersion: number;
  timezone: string;
  version: number;
  finalizedAt: Date;
}): SafeAccountantReport {
  return input.schemaVersion === 2
    ? sanitizeAccountantSnapshot(input.snapshot)
    : adaptLegacySnapshot({
      snapshot: input.snapshot,
      timezone: input.timezone,
      version: input.version,
      finalizedAt: input.finalizedAt,
    });
}

/** Admin-only live operational preview. Accountants only consume immutable versions. */
reportsRouter.get('/week/:weekStart/preview', requireAdmin, async (req, res) => {
  const param = String(req.params.weekStart);
  if (!DATE_RE.test(param)) throw badRequest('Fecha inválida');
  const organizationId = requireOrganization(req);
  const weekStart = await normalizeWeekStart(organizationId, param);
  const period = await getPeriodReport(organizationId, weekStart);
  privateNoStore(res);
  const computation = await computeWeek(organizationId, weekStart);
  res.json({
    ...computation,
    status: period?.status ?? 'open',
    version: period?.current_version ?? 0,
  });
});

/** Compatibility read: current final snapshot only, never mutable live hours. */
reportsRouter.get('/week/:weekStart', async (req, res) => {
  if (!DATE_RE.test(req.params.weekStart)) throw badRequest('Fecha inválida');
  const organizationId = requireOrganization(req);
  const weekStart = await normalizeWeekStart(organizationId, req.params.weekStart);
  const period = await getPeriodReport(organizationId, weekStart);
  if (
    !period || period.status !== 'final' || !period.snapshot || !period.snapshot_hash
    || !period.finalized_at || !period.snapshot_schema_version || !period.hash_algorithm
  ) {
    throw conflict(
      'La contadora solo puede consultar semanas con una versión final',
      'report_not_final',
    );
  }
  const timezone = (await getSettings(organizationId)).timezone;
  const snapshot = safeSnapshotFromRow({
    snapshot: period.snapshot,
    schemaVersion: period.snapshot_schema_version,
    timezone,
    version: period.current_version,
    finalizedAt: period.finalized_at,
  });
  respondWithSnapshot(req, res, snapshot, {
    snapshotHash: period.snapshot_hash,
    hashAlgorithm: period.hash_algorithm,
    periodStatus: period.status,
    isCurrentFinal: true,
    detailAvailable: period.snapshot_schema_version >= 2,
  });
});

/**
 * Cierre de semana: snapshot inmutable para el contador. No se permite cerrar
 * con anomalías sin resolver.
 */
reportsRouter.post('/week/:weekStart/finalize', requireAdmin, async (req, res) => {
  const param = String(req.params.weekStart);
  if (!DATE_RE.test(param)) throw badRequest('Fecha inválida');
  const organizationId = requireOrganization(req);
  const weekStart = await normalizeWeekStart(organizationId, param);

  const body = z
    .object({
      reason: z.string().trim().min(3).optional(),
      override_device_health: z.boolean().default(false),
      override_operational_blockers: z.boolean().default(false),
    })
    .strict()
    .superRefine((value, context) => {
      if ((value.override_device_health || value.override_operational_blockers) && !value.reason) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['reason'],
          message: 'La razón es obligatoria para ignorar bloqueos de cierre',
        });
      }
    })
    .parse(req.body ?? {});
  const settings = await getSettings(organizationId);
  let closed: { version: number; snapshot_hash: string };
  try {
    closed = await withTransaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      const period = await lockPayPeriod(client, organizationId, weekStart, settings.timezone);
      if (period.status === 'final') throw conflict('Esta semana ya está cerrada');
      if (period.status !== 'ready_for_review') {
        throw conflict(
          'La semana debe enviarse a revisión antes de cerrarse',
          'period_not_ready_for_review',
        );
      }
      if (!canFinalizeWeek(period.week_end, new Date(), settings.timezone)) {
        throw conflict('La semana todavía no termina en California', 'week_not_ended');
      }

      const deviceHealthBlockers = await finalizationDeviceHealthBlockers(
        client,
        organizationId,
        periodHeartbeatBoundary(period.week_end, settings.timezone)
      );
      if (deviceHealthBlockers.length && !body.override_device_health) {
        throw conflict(
          `No se puede cerrar: ${deviceHealthBlockers.length} checador(es) requieren atención`,
          'device_health_blockers',
          { devices: deviceHealthBlockers, pay_period_id: period.id }
        );
      }
      if (deviceHealthBlockers.length) {
        await recordAudit(
          {
            organizationId,
            actorUserId: req.user!.id,
            action: 'pay_period.device_health_overridden',
            entityType: 'pay_period',
            entityId: period.id,
            reason: body.reason!,
            metadata: { week_start: weekStart, devices: deviceHealthBlockers },
          },
          client
        );
      }

      // Re-derive from punches/manual entries while holding the same weekly
      // lock. The reconciled inbox is a convenience projection and can lag;
      // it is never trusted as the payroll-close gate.
      const operationalBlockers = await deriveFinalizationBlockers(client, {
        organizationId,
        fromDate: period.week_start,
        toDate: period.week_end,
        timezone: settings.timezone,
      });
      if (operationalBlockers.length && !body.override_operational_blockers) {
        throw conflict(
          `No se puede cerrar: hay ${operationalBlockers.length} incidencia(s) operativa(s) bloqueante(s).`,
          'operational_exception_blockers',
          {
            pay_period_id: period.id,
            blockers: operationalBlockers.map((blocker) => ({
              code: blocker.code,
              title: blocker.title,
              employee_id: blocker.employeeId,
              work_date: blocker.workDate,
              plant_ids: blocker.plantIds,
              source_key: blocker.sourceKey,
            })),
          },
        );
      }
      if (operationalBlockers.length) {
        await recordAudit(
          {
            organizationId,
            actorUserId: req.user!.id,
            action: 'pay_period.operational_blockers_overridden',
            entityType: 'pay_period',
            entityId: period.id,
            reason: body.reason!,
            metadata: {
              week_start: weekStart,
              blockers: operationalBlockers.map((blocker) => ({
                dedupe_key: blocker.dedupeKey,
                code: blocker.code,
                employee_id: blocker.employeeId,
                work_date: blocker.workDate,
                plant_ids: blocker.plantIds,
              })),
            },
          },
          client,
        );
      }

      // Every mutation obtains the same advisory lock, so this calculation and
      // snapshot cannot race a foreman correction.
      const computation = await computeWeek(organizationId, weekStart, undefined, client);
      if (computation.anomaly_count > 0 && !body.override_operational_blockers) {
        throw conflict(
          `No se puede cerrar: hay ${computation.anomaly_count} incidencia(s) bloqueante(s).`,
          'anomalies_pending'
        );
      }
      const version = period.current_version + 1;
      const finalizedAt = new Date();
      const snapshot = await buildAccountantSnapshot({
        organizationId,
        timezone: settings.timezone,
        version,
        finalizedAt,
        computation,
        client,
      });
      const hash = snapshotHash(snapshot);
      const artifacts = await renderReportArtifacts(snapshot);
      const costSnapshot = await buildAdminDirectCostSnapshot({
        organizationId,
        weekStart,
        timezone: settings.timezone,
        reportVersion: version,
        createdAt: finalizedAt,
        client,
      });
      const costSnapshotHash = snapshotHash(costSnapshot);
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO report_versions
           (organization_id, pay_period_id, version, snapshot, snapshot_hash,
            snapshot_schema_version, snapshot_contract, hash_algorithm,
            finalized_by, finalized_at, finalization_reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'sha256', $8, $9, $10)
         RETURNING id`,
        [
          organizationId,
          period.id,
          version,
          JSON.stringify(snapshot),
          hash,
          ACCOUNTANT_REPORT_SCHEMA_VERSION,
          ACCOUNTANT_REPORT_CONTRACT,
          req.user!.id,
          finalizedAt,
          body.reason ?? null,
        ]
      );
      await client.query(
        `INSERT INTO report_cost_snapshots
           (organization_id, report_version_id, schema_version, contract,
            snapshot, snapshot_hash, created_at)
         VALUES ($1, $2, 1, 'clockai-admin-direct-cost-v1', $3, $4, $5)`,
        [
          organizationId,
          inserted.rows[0]!.id,
          JSON.stringify(costSnapshot),
          costSnapshotHash,
          finalizedAt,
        ],
      );
      for (const artifact of artifacts) {
        await client.query(
          `INSERT INTO report_export_artifacts
             (organization_id, report_version_id, kind, template_version,
              content, content_sha256, byte_length, content_type, filename,
              created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            organizationId,
            inserted.rows[0]!.id,
            artifact.kind,
            ACCOUNTANT_REPORT_TEMPLATE_VERSION,
            artifact.content,
            artifact.contentSha256,
            artifact.content.length,
            artifact.contentType,
            artifact.filename,
            finalizedAt,
          ],
        );
      }
      await client.query(
        `UPDATE pay_periods
         SET status = 'final', current_version = $3,
             finalized_at = $4, finalized_by = $5,
             updated_at = now()
         WHERE id = $1 AND organization_id = $2`,
        [period.id, organizationId, version, finalizedAt, req.user!.id]
      );
      await recordAudit(
        {
          organizationId,
          actorUserId: req.user!.id,
          action: 'pay_period.finalized',
          entityType: 'pay_period',
          entityId: period.id,
          reason: body.reason ?? null,
          metadata: {
            week_start: weekStart,
            version,
            snapshot_hash: hash,
            snapshot_schema_version: ACCOUNTANT_REPORT_SCHEMA_VERSION,
            snapshot_contract: ACCOUNTANT_REPORT_CONTRACT,
            hash_algorithm: 'sha256',
            admin_cost_snapshot_hash: costSnapshotHash,
            admin_cost_coverage_ratio: costSnapshot.week.metric.coverage_ratio,
            export_artifacts: Object.fromEntries(
              artifacts.map((artifact) => [artifact.kind, artifact.contentSha256]),
            ),
            override_device_health: body.override_device_health,
            override_operational_blockers: body.override_operational_blockers,
            device_health_blockers: deviceHealthBlockers,
            operational_blockers: operationalBlockers.map((blocker) => blocker.dedupeKey),
          },
        },
        client
      );
      return { version, snapshot_hash: hash };
    });
  } catch (error) {
    if (
      error instanceof HttpError &&
      error.code === 'device_health_blockers'
    ) {
      const details = error.details as {
        pay_period_id: string;
        devices: DeviceHealthBlocker[];
      };
      await recordAudit({
        organizationId,
        actorUserId: req.user!.id,
        action: 'pay_period.finalization_blocked_device_health',
        entityType: 'pay_period',
        entityId: details.pay_period_id,
        metadata: { week_start: weekStart, devices: details.devices },
      });
    }
    if (error instanceof HttpError && error.code === 'operational_exception_blockers') {
      const details = error.details as {
        pay_period_id: string;
        blockers: Array<Record<string, unknown>>;
      };
      await recordAudit({
        organizationId,
        actorUserId: req.user!.id,
        action: 'pay_period.finalization_blocked_operational_exceptions',
        entityType: 'pay_period',
        entityId: details.pay_period_id,
        metadata: { week_start: weekStart, blockers: details.blockers },
      });
    }
    throw error;
  }
  res.status(201).json({ ok: true, ...closed, week_start: weekStart });
});

reportsRouter.post('/week/:weekStart/reopen', requireAdmin, async (req, res) => {
  const param = String(req.params.weekStart);
  if (!DATE_RE.test(param)) throw badRequest('Fecha inválida');
  const organizationId = requireOrganization(req);
  const weekStart = await normalizeWeekStart(organizationId, param);
  const body = z.object({ reason: z.string().trim().min(3, 'La razón es obligatoria') }).parse(req.body);
  const settings = await getSettings(organizationId);

  const period = await withTransaction(async (client) => {
    const locked = await lockPayPeriod(client, organizationId, weekStart, settings.timezone);
    if (locked.status !== 'final') throw conflict('Solo una semana final puede reabrirse');
    await client.query(
      `UPDATE pay_periods
       SET status = 'reopened', reopened_at = now(), reopened_by = $3,
           reopen_reason = $4, updated_at = now()
       WHERE id = $1 AND organization_id = $2`,
      [locked.id, organizationId, req.user!.id, body.reason]
    );
    await recordAudit(
      {
        organizationId,
        actorUserId: req.user!.id,
        action: 'pay_period.reopened',
        entityType: 'pay_period',
        entityId: locked.id,
        reason: body.reason,
        metadata: { week_start: weekStart, prior_version: locked.current_version },
      },
      client
    );
    return locked;
  });
  res.json({ ok: true, id: period.id, week_start: weekStart, status: 'reopened' });
});

reportsRouter.post('/week/:weekStart/ready-for-review', requireAdmin, async (req, res) => {
  const param = String(req.params.weekStart);
  if (!DATE_RE.test(param)) throw badRequest('Fecha inválida');
  const body = z.object({
    override_device_health: z.boolean().default(false),
    override_operational_blockers: z.boolean().default(false),
    reason: z.string().trim().min(3).optional(),
  }).strict().superRefine((value, context) => {
    if ((value.override_device_health || value.override_operational_blockers) && !value.reason) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reason'],
        message: 'La razón es obligatoria para ignorar bloqueos de revisión',
      });
    }
  }).parse(req.body ?? {});
  const organizationId = requireOrganization(req);
  const settings = await getSettings(organizationId);
  const weekStart = await normalizeWeekStart(organizationId, param);
  const result = await withTransaction(async (client) => {
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    const period = await lockPayPeriod(client, organizationId, weekStart, settings.timezone);
    if (period.status !== 'open' && period.status !== 'reopened') {
      throw conflict(
        'Solo una semana editable puede enviarse a revisión',
        'period_not_editable',
      );
    }
    if (!canFinalizeWeek(period.week_end, new Date(), settings.timezone)) {
      throw conflict(
        'La semana todavía no termina en California',
        'week_not_ended',
      );
    }
    const deviceHealthBlockers = await finalizationDeviceHealthBlockers(
      client,
      organizationId,
      periodHeartbeatBoundary(period.week_end, settings.timezone),
    );
    if (deviceHealthBlockers.length > 0 && !body.override_device_health) {
      throw conflict(
        `La semana tiene ${deviceHealthBlockers.length} checador(es) que requieren atención`,
        'device_health_blockers',
        { devices: deviceHealthBlockers, pay_period_id: period.id },
      );
    }
    if (deviceHealthBlockers.length > 0) {
      await recordAudit(
        {
          organizationId,
          actorUserId: req.user!.id,
          action: 'pay_period.review_device_health_overridden',
          entityType: 'pay_period',
          entityId: period.id,
          reason: body.reason!,
          metadata: { week_start: weekStart, devices: deviceHealthBlockers },
        },
        client,
      );
    }
    const blockers = await deriveFinalizationBlockers(client, {
      organizationId,
      fromDate: period.week_start,
      toDate: period.week_end,
      timezone: settings.timezone,
    });
    const computation = await computeWeek(organizationId, weekStart, undefined, client);
    if ((blockers.length > 0 || computation.anomaly_count > 0) && !body.override_operational_blockers) {
      throw conflict(
        `La semana tiene ${Math.max(blockers.length, computation.anomaly_count)} incidencia(s) bloqueante(s)`,
        'review_operational_blockers',
        {
          blockers: blockers.map((blocker) => ({
            code: blocker.code,
            employee_id: blocker.employeeId,
            work_date: blocker.workDate,
            plant_ids: blocker.plantIds,
          })),
          anomaly_count: computation.anomaly_count,
        },
      );
    }
    if (blockers.length > 0 || computation.anomaly_count > 0) {
      await recordAudit(
        {
          organizationId,
          actorUserId: req.user!.id,
          action: 'pay_period.review_blockers_overridden',
          entityType: 'pay_period',
          entityId: period.id,
          reason: body.reason!,
          metadata: {
            week_start: weekStart,
            blocker_keys: blockers.map((blocker) => blocker.dedupeKey),
            anomaly_count: computation.anomaly_count,
          },
        },
        client,
      );
    }
    await client.query(
      `UPDATE pay_periods
       SET status = 'ready_for_review', updated_at = now()
       WHERE id = $1 AND organization_id = $2`,
      [period.id, organizationId],
    );
    await recordAudit(
      {
        organizationId,
        actorUserId: req.user!.id,
        action: 'pay_period.ready_for_review',
        entityType: 'pay_period',
        entityId: period.id,
        reason: body.reason ?? null,
        metadata: {
          week_start: weekStart,
          prior_status: period.status,
          override_device_health: body.override_device_health,
          override_operational_blockers: body.override_operational_blockers,
        },
      },
      client,
    );
    return { id: period.id, priorStatus: period.status };
  });
  res.json({
    ok: true,
    id: result.id,
    week_start: weekStart,
    status: 'ready_for_review',
    prior_status: result.priorStatus,
  });
});

reportsRouter.post('/week/:weekStart/resume', requireAdmin, async (req, res) => {
  const param = String(req.params.weekStart);
  if (!DATE_RE.test(param)) throw badRequest('Fecha inválida');
  z.object({}).strict().parse(req.body ?? {});
  const organizationId = requireOrganization(req);
  const settings = await getSettings(organizationId);
  const weekStart = await normalizeWeekStart(organizationId, param);
  const resumed = await withTransaction(async (client) => {
    const period = await lockPayPeriod(client, organizationId, weekStart, settings.timezone);
    if (period.status !== 'ready_for_review') {
      throw conflict('La semana no está en revisión', 'period_not_ready_for_review');
    }
    const status: 'open' | 'reopened' = period.current_version > 0 ? 'reopened' : 'open';
    await client.query(
      `UPDATE pay_periods SET status = $3, updated_at = now()
       WHERE id = $1 AND organization_id = $2`,
      [period.id, organizationId, status],
    );
    await recordAudit(
      {
        organizationId,
        actorUserId: req.user!.id,
        action: 'pay_period.review_resumed',
        entityType: 'pay_period',
        entityId: period.id,
        metadata: { week_start: weekStart, status },
      },
      client,
    );
    return { id: period.id, status };
  });
  res.json({ ok: true, id: resumed.id, week_start: weekStart, status: resumed.status });
});

reportsRouter.get('/week/:weekStart/versions', async (req, res) => {
  if (!DATE_RE.test(req.params.weekStart)) throw badRequest('Fecha inválida');
  const organizationId = requireOrganization(req);
  const weekStart = await normalizeWeekStart(organizationId, req.params.weekStart);
  const parsed = z.object({
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.coerce.number().int().positive().optional(),
  }).parse(req.query);
  const rows = await query<{
    version: number;
    snapshot_hash: string;
    hash_algorithm: 'md5' | 'sha256';
    snapshot_schema_version: number;
    snapshot_contract: string;
    finalized_at: Date;
    period_status: PayPeriodStatus;
    current_version: number;
    artifact_kinds: string[];
  }>(
    `SELECT rv.version, rv.snapshot_hash, rv.hash_algorithm,
            rv.snapshot_schema_version, rv.snapshot_contract, rv.finalized_at,
            p.status AS period_status, p.current_version,
            COALESCE(array_agg(a.kind ORDER BY a.kind)
              FILTER (WHERE a.kind IS NOT NULL), ARRAY[]::text[]) AS artifact_kinds
     FROM report_versions rv
     JOIN pay_periods p
       ON p.id = rv.pay_period_id AND p.organization_id = rv.organization_id
     LEFT JOIN report_export_artifacts a
       ON a.report_version_id = rv.id AND a.organization_id = rv.organization_id
     WHERE rv.organization_id = $1 AND p.week_start = $2::date
       AND ($3::integer IS NULL OR rv.version < $3)
     GROUP BY rv.id, rv.version, rv.snapshot_hash, rv.hash_algorithm,
              rv.snapshot_schema_version, rv.snapshot_contract, rv.finalized_at,
              p.status, p.current_version
     ORDER BY rv.version DESC
     LIMIT $4`,
    [organizationId, weekStart, parsed.cursor ?? null, parsed.limit + 1],
  );
  const hasNext = rows.length > parsed.limit;
  const page = rows.slice(0, parsed.limit);
  privateNoStore(res);
  res.json({
    items: page.map((row) => ({
      version: row.version,
      snapshot_hash: row.snapshot_hash,
      hash_algorithm: row.hash_algorithm,
      schema_version: row.snapshot_schema_version,
      contract: row.snapshot_contract,
      finalized_at: row.finalized_at,
      period_status: row.period_status,
      is_current_final: row.period_status === 'final' && row.current_version === row.version,
      detail_available: row.snapshot_schema_version >= 2,
      export_formats: row.artifact_kinds,
    })),
    next_cursor: hasNext ? page.at(-1)?.version : undefined,
  });
});

/** Recupera exactamente el snapshot histórico que vio la contadora. */
reportsRouter.get('/week/:weekStart/versions/:version', async (req, res) => {
  if (!DATE_RE.test(req.params.weekStart)) throw badRequest('Fecha inválida');
  const version = z.coerce.number().int().positive().parse(req.params.version);
  const organizationId = requireOrganization(req);
  const weekStart = await normalizeWeekStart(organizationId, req.params.weekStart);
  const historical = await queryOne<{
    snapshot: unknown;
    snapshot_hash: string;
    snapshot_schema_version: number;
    snapshot_contract: string;
    hash_algorithm: 'md5' | 'sha256';
    finalized_at: Date;
    period_status: PayPeriodStatus;
    current_version: number;
  }>(
    `SELECT rv.snapshot, rv.snapshot_hash, rv.snapshot_schema_version,
            rv.snapshot_contract, rv.hash_algorithm, rv.finalized_at,
            p.status AS period_status, p.current_version
     FROM report_versions rv
     JOIN pay_periods p
       ON p.id = rv.pay_period_id AND p.organization_id = rv.organization_id
     WHERE rv.organization_id = $1
       AND p.week_start = $2::date
       AND rv.version = $3`,
    [organizationId, weekStart, version]
  );
  if (!historical) throw notFound('La versión solicitada no existe');
  const timezone = (await getSettings(organizationId)).timezone;
  const snapshot = safeSnapshotFromRow({
    snapshot: historical.snapshot,
    schemaVersion: historical.snapshot_schema_version,
    timezone,
    version,
    finalizedAt: historical.finalized_at,
  });
  respondWithSnapshot(req, res, snapshot, {
    snapshotHash: historical.snapshot_hash,
    hashAlgorithm: historical.hash_algorithm,
    periodStatus: historical.period_status,
    isCurrentFinal:
      historical.period_status === 'final' && historical.current_version === version,
    detailAvailable: historical.snapshot_schema_version >= 2,
  });
});

reportsRouter.get('/weeks', async (req, res) => {
  const parsed = z.object({
    limit: z.coerce.number().int().min(1).max(100).default(52),
    cursor: z.string().regex(DATE_RE).optional(),
  }).parse(req.query);
  const organizationId = requireOrganization(req);
  const isAdmin = req.user!.role === 'admin';
  const rows = await query<{
    week_start: string;
    week_end: string;
    status: PayPeriodStatus;
    current_version: number;
    finalized_at: Date | null;
    snapshot_hash: string | null;
    hash_algorithm: 'md5' | 'sha256' | null;
    snapshot_schema_version: number | null;
  }>(
    `SELECT p.week_start, p.week_end, p.status, p.current_version,
            rv.finalized_at, rv.snapshot_hash, rv.hash_algorithm,
            rv.snapshot_schema_version
     FROM pay_periods p
     LEFT JOIN report_versions rv
       ON rv.pay_period_id = p.id AND rv.organization_id = p.organization_id
      AND rv.version = p.current_version
     WHERE p.organization_id = $1
       AND ($2::boolean OR EXISTS (
         SELECT 1 FROM report_versions visible
         WHERE visible.pay_period_id = p.id
           AND visible.organization_id = p.organization_id
       ))
       AND ($3::date IS NULL OR p.week_start < $3::date)
     ORDER BY p.week_start DESC
     LIMIT $4`,
    [organizationId, isAdmin, parsed.cursor ?? null, parsed.limit + 1],
  );
  const hasNext = rows.length > parsed.limit;
  const page = rows.slice(0, parsed.limit);
  privateNoStore(res);
  res.json({
    items: page.map((row) => ({
      week_start: row.week_start,
      week_end: row.week_end,
      status: row.status,
      current_version: row.current_version,
      finalized_at: row.finalized_at,
      snapshot_hash: row.snapshot_hash,
      hash_algorithm: row.hash_algorithm,
      detail_available: (row.snapshot_schema_version ?? 0) >= 2,
      report_available: row.current_version > 0,
    })),
    next_cursor: hasNext ? page.at(-1)?.week_start : undefined,
  });
});

const exportSchema = z.object({
  format: z.enum(['xlsx', 'csv']).default('xlsx'),
  sheet: z.enum(['summary', 'detail']).default('summary'),
});

reportsRouter.get('/week/:weekStart/versions/:version/export', async (req, res) => {
  if (!DATE_RE.test(req.params.weekStart)) throw badRequest('Fecha inválida');
  const version = z.coerce.number().int().positive().parse(req.params.version);
  const organizationId = requireOrganization(req);
  const weekStart = await normalizeWeekStart(organizationId, req.params.weekStart);
  const { format, sheet } = exportSchema.parse(req.query);
  const kind = format === 'xlsx' ? 'xlsx' : sheet === 'detail' ? 'csv_detail' : 'csv_summary';
  const artifact = await queryOne<{
    report_version_id: string;
    snapshot_schema_version: number;
    content: Buffer;
    content_sha256: string;
    byte_length: number;
    content_type: string;
    filename: string;
    template_version: string;
  }>(
    `SELECT rv.id AS report_version_id, rv.snapshot_schema_version,
            a.content, a.content_sha256, a.byte_length, a.content_type,
            a.filename, a.template_version
     FROM report_versions rv
     JOIN pay_periods p
       ON p.id = rv.pay_period_id AND p.organization_id = rv.organization_id
     LEFT JOIN report_export_artifacts a
       ON a.report_version_id = rv.id AND a.organization_id = rv.organization_id
      AND a.kind = $4
     WHERE rv.organization_id = $1 AND p.week_start = $2::date
       AND rv.version = $3`,
    [organizationId, weekStart, version, kind],
  );
  if (!artifact) throw notFound('La versión solicitada no existe');
  if (!artifact.content) {
    throw conflict(
      artifact.snapshot_schema_version < 2
        ? 'La versión heredada solo está disponible para consulta en pantalla'
        : 'El artefacto inmutable de esta versión no está disponible',
      artifact.snapshot_schema_version < 2
        ? 'legacy_export_unavailable'
        : 'report_artifact_unavailable',
    );
  }
  await recordAudit({
    organizationId,
    actorUserId: req.user!.id,
    action: 'report.export_requested',
    entityType: 'report_version',
    entityId: artifact.report_version_id,
    metadata: {
      week_start: weekStart,
      version,
      kind,
      template_version: artifact.template_version,
      content_sha256: artifact.content_sha256,
      byte_length: artifact.byte_length,
    },
  });
  privateNoStore(res);
  const etag = quotedEtag(`sha256-${artifact.content_sha256}`);
  res.header('ETag', etag);
  res.header('X-Content-SHA256', artifact.content_sha256);
  if (req.headers['if-none-match'] === etag) {
    res.status(304).end();
    return;
  }
  res
    .header('Content-Type', artifact.content_type)
    .header('Content-Length', String(artifact.byte_length))
    .header('Content-Disposition', `attachment; filename="${artifact.filename}"`)
    .send(artifact.content);
});

/** Live/draft exports are deliberately impossible; callers must select a version. */
reportsRouter.get('/week/:weekStart/export', async (req, _res) => {
  if (!DATE_RE.test(req.params.weekStart)) throw badRequest('Fecha inválida');
  throw badRequest(
    'Selecciona una versión final explícita para exportar',
    'report_version_required',
  );
});
