import { Router, type Request } from 'express';
import { z } from 'zod';
import { query, queryOne, withTransaction } from '../db.js';
import { conflict, notFound } from '../errors.js';
import {
  requireAdmin,
  requireAuth,
  requireOrganization,
  requireRole,
} from '../middleware/auth.js';
import { recordAudit } from '../services/auditService.js';
import {
  OPERATIONAL_EXCEPTION_CODES,
  canAccessOperationalException,
  reconcileOperationalExceptions,
  transitionOperationalException,
} from '../services/operationalExceptions.js';
import { getSettings } from '../services/settingsService.js';
import { assertPlantAccess } from '../services/tenantService.js';

export const operationalExceptionsRouter = Router();
operationalExceptionsRouter.use(requireAuth, requireRole('admin', 'foreman'));

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const exceptionCode = z.enum(OPERATIONAL_EXCEPTION_CODES);

const listSchema = z
  .object({
    status: z.enum(['active', 'open', 'acknowledged', 'resolved', 'all']).default('active'),
    severity: z.enum(['blocker', 'warning']).optional(),
    code: exceptionCode.optional(),
    plant_id: z.string().uuid().optional(),
    employee_id: z.string().uuid().optional(),
    from_date: z.string().regex(DATE_RE).optional(),
    to_date: z.string().regex(DATE_RE).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).max(100_000).default(0),
  })
  .superRefine((value, context) => {
    if (value.from_date && value.to_date && value.from_date > value.to_date) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['to_date'],
        message: 'to_date must not precede from_date',
      });
    }
  });

const summarySchema = z
  .object({
    plant_id: z.string().uuid().optional(),
    from_date: z.string().regex(DATE_RE).optional(),
    to_date: z.string().regex(DATE_RE).optional(),
  })
  .superRefine((value, context) => {
    if (value.from_date && value.to_date && value.from_date > value.to_date) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['to_date'],
        message: 'to_date must not precede from_date',
      });
    }
  });

function roleScopeSql(exceptionAlias = 'e'): string {
  // A foreman must have every plant linked to a multi-plant exception. This
  // prevents one assigned plant from leaking details about another plant.
  return `(
    $3::text = 'admin'
    OR (
      EXISTS (
        SELECT 1 FROM operational_exception_plants scoped_ep
        WHERE scoped_ep.exception_id = ${exceptionAlias}.id
          AND scoped_ep.organization_id = ${exceptionAlias}.organization_id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM operational_exception_plants denied_ep
        WHERE denied_ep.exception_id = ${exceptionAlias}.id
          AND denied_ep.organization_id = ${exceptionAlias}.organization_id
          AND NOT EXISTS (
            SELECT 1 FROM user_plant_access scoped_access
            WHERE scoped_access.organization_id = denied_ep.organization_id
              AND scoped_access.plant_id = denied_ep.plant_id
              AND scoped_access.user_id = $2
          )
      )
    )
  )`;
}

function appendCommonFilters(
  where: string[],
  params: unknown[],
  filters: {
    plant_id?: string;
    from_date?: string;
    to_date?: string;
  },
): void {
  if (filters.plant_id) {
    params.push(filters.plant_id);
    where.push(
      `EXISTS (
         SELECT 1 FROM operational_exception_plants filter_ep
         WHERE filter_ep.exception_id = e.id
           AND filter_ep.organization_id = e.organization_id
           AND filter_ep.plant_id = $${params.length}
       )`,
    );
  }
  if (filters.from_date) {
    params.push(filters.from_date);
    where.push(`(e.work_date IS NULL OR e.work_date >= $${params.length}::date)`);
  }
  if (filters.to_date) {
    params.push(filters.to_date);
    where.push(`(e.work_date IS NULL OR e.work_date <= $${params.length}::date)`);
  }
}

interface ExceptionListRow {
  id: string;
  code: string;
  severity: string;
  source_type: string;
  employee_id: string | null;
  employee_number: number | null;
  employee_name: string | null;
  work_date: string | null;
  occurred_at: Date;
  title: string;
  status: string;
  first_detected_at: Date;
  last_detected_at: Date;
  acknowledged_at: Date | null;
  resolved_at: Date | null;
  resolution_reason: string | null;
  plants: Array<{ id: string; code: string; name: string }>;
  total_count: number;
}

operationalExceptionsRouter.get('/', async (req, res) => {
  const organizationId = requireOrganization(req);
  const filters = listSchema.parse(req.query);
  if (filters.plant_id) await assertPlantAccess(req, filters.plant_id);

  const params: unknown[] = [organizationId, req.user!.id, req.user!.role];
  const where = [`e.organization_id = $1`, roleScopeSql()];
  if (filters.status === 'active') where.push(`e.status IN ('open', 'acknowledged')`);
  else if (filters.status !== 'all') {
    params.push(filters.status);
    where.push(`e.status = $${params.length}`);
  }
  if (filters.severity) {
    params.push(filters.severity);
    where.push(`e.severity = $${params.length}`);
  }
  if (filters.code) {
    params.push(filters.code);
    where.push(`e.code = $${params.length}`);
  }
  if (filters.employee_id) {
    params.push(filters.employee_id);
    where.push(`e.employee_id = $${params.length}`);
  }
  appendCommonFilters(where, params, filters);
  params.push(filters.limit, filters.offset);

  const rows = await query<ExceptionListRow>(
    `SELECT e.id, e.code, e.severity, e.source_type, e.employee_id,
            emp.employee_number, emp.full_name AS employee_name,
            e.work_date::text, e.occurred_at, e.title, e.status,
            e.first_detected_at, e.last_detected_at, e.acknowledged_at,
            e.resolved_at, e.resolution_reason,
            COALESCE(
              jsonb_agg(
                DISTINCT jsonb_build_object('id', p.id, 'code', p.code, 'name', p.name)
              ) FILTER (WHERE p.id IS NOT NULL),
              '[]'::jsonb
            ) AS plants,
            count(*) OVER()::integer AS total_count
     FROM operational_exceptions e
     LEFT JOIN employees emp
       ON emp.id = e.employee_id AND emp.organization_id = e.organization_id
     LEFT JOIN operational_exception_plants ep
       ON ep.exception_id = e.id AND ep.organization_id = e.organization_id
     LEFT JOIN plants p
       ON p.id = ep.plant_id AND p.organization_id = ep.organization_id
     WHERE ${where.join(' AND ')}
     GROUP BY e.id, emp.id
     ORDER BY
       CASE e.status WHEN 'open' THEN 0 WHEN 'acknowledged' THEN 1 ELSE 2 END,
       CASE e.severity WHEN 'blocker' THEN 0 ELSE 1 END,
       e.work_date DESC NULLS LAST, e.occurred_at DESC, e.id
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  const total = rows[0]?.total_count ?? 0;
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.json({
    items: rows.map(({ total_count: _total, ...row }) => row),
    total,
    next_offset: filters.offset + rows.length < total ? filters.offset + rows.length : null,
  });
});

interface SummaryRow {
  status: 'open' | 'acknowledged' | 'resolved';
  severity: 'blocker' | 'warning';
  code: string;
  count: number;
}

operationalExceptionsRouter.get('/summary', async (req, res) => {
  const organizationId = requireOrganization(req);
  const filters = summarySchema.parse(req.query);
  if (filters.plant_id) await assertPlantAccess(req, filters.plant_id);
  const params: unknown[] = [organizationId, req.user!.id, req.user!.role];
  const where = [`e.organization_id = $1`, roleScopeSql()];
  appendCommonFilters(where, params, filters);
  const rows = await query<SummaryRow>(
    `SELECT e.status, e.severity, e.code, count(*)::integer AS count
     FROM operational_exceptions e
     WHERE ${where.join(' AND ')}
     GROUP BY e.status, e.severity, e.code
     ORDER BY e.status, e.severity, e.code`,
    params,
  );
  const active = rows.filter((row) => row.status !== 'resolved');
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.json({
    totals: {
      all: rows.reduce((sum, row) => sum + row.count, 0),
      active: active.reduce((sum, row) => sum + row.count, 0),
      blockers: active
        .filter((row) => row.severity === 'blocker')
        .reduce((sum, row) => sum + row.count, 0),
      warnings: active
        .filter((row) => row.severity === 'warning')
        .reduce((sum, row) => sum + row.count, 0),
    },
    by_status: Object.fromEntries(
      ['open', 'acknowledged', 'resolved'].map((status) => [
        status,
        rows.filter((row) => row.status === status).reduce((sum, row) => sum + row.count, 0),
      ]),
    ),
    by_code: Object.fromEntries(
      OPERATIONAL_EXCEPTION_CODES.map((code) => [
        code,
        active.filter((row) => row.code === code).reduce((sum, row) => sum + row.count, 0),
      ]),
    ),
  });
});

interface ExceptionDetailRow extends Omit<ExceptionListRow, 'total_count'> {
  details: Record<string, unknown>;
  acknowledged_by_name: string | null;
  resolved_by_name: string | null;
}

interface ExceptionEventRow {
  id: string;
  sequence: number;
  event_type: string;
  from_status: string | null;
  to_status: string;
  actor_user_id: string | null;
  actor_name: string | null;
  reason: string | null;
  snapshot: Record<string, unknown>;
  created_at: Date;
}

const detailEventsSchema = z.object({
  event_limit: z.coerce.number().int().min(1).max(200).default(100),
  event_before_sequence: z.coerce.number().int().positive().optional(),
});

operationalExceptionsRouter.get('/:id', async (req, res) => {
  const organizationId = requireOrganization(req);
  const exceptionId = z.string().uuid().parse(req.params.id);
  const eventPage = detailEventsSchema.parse(req.query);
  const params = [organizationId, req.user!.id, req.user!.role, exceptionId];
  const row = await queryOne<ExceptionDetailRow>(
    `SELECT e.id, e.code, e.severity, e.source_type, e.employee_id,
            emp.employee_number, emp.full_name AS employee_name,
            e.work_date::text, e.occurred_at, e.title, e.details, e.status,
            e.first_detected_at, e.last_detected_at, e.acknowledged_at,
            e.resolved_at, e.resolution_reason,
            acknowledged.name AS acknowledged_by_name,
            resolved.name AS resolved_by_name,
            COALESCE(
              jsonb_agg(
                DISTINCT jsonb_build_object('id', p.id, 'code', p.code, 'name', p.name)
              ) FILTER (WHERE p.id IS NOT NULL),
              '[]'::jsonb
            ) AS plants
     FROM operational_exceptions e
     LEFT JOIN employees emp
       ON emp.id = e.employee_id AND emp.organization_id = e.organization_id
     LEFT JOIN users acknowledged
       ON acknowledged.id = e.acknowledged_by AND acknowledged.organization_id = e.organization_id
     LEFT JOIN users resolved
       ON resolved.id = e.resolved_by AND resolved.organization_id = e.organization_id
     LEFT JOIN operational_exception_plants ep
       ON ep.exception_id = e.id AND ep.organization_id = e.organization_id
     LEFT JOIN plants p
       ON p.id = ep.plant_id AND p.organization_id = ep.organization_id
     WHERE e.organization_id = $1 AND e.id = $4 AND ${roleScopeSql()}
     GROUP BY e.id, emp.id, acknowledged.id, resolved.id`,
    params,
  );
  if (!row) throw notFound('Incidencia no encontrada');
  const eventRows = await query<ExceptionEventRow>(
    `SELECT ev.id, ev.sequence::integer AS sequence, ev.event_type, ev.from_status, ev.to_status,
            ev.actor_user_id, actor.name AS actor_name, ev.reason,
            ev.snapshot, ev.created_at
     FROM operational_exception_events ev
     LEFT JOIN users actor
       ON actor.id = ev.actor_user_id AND actor.organization_id = ev.organization_id
     WHERE ev.organization_id = $1 AND ev.exception_id = $2
       AND ($3::bigint IS NULL OR ev.sequence < $3)
     ORDER BY ev.sequence DESC
     LIMIT $4`,
    [
      organizationId,
      exceptionId,
      eventPage.event_before_sequence ?? null,
      eventPage.event_limit + 1,
    ],
  );
  const hasOlder = eventRows.length > eventPage.event_limit;
  const events = eventRows.slice(0, eventPage.event_limit).reverse();
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.json({
    ...row,
    events,
    events_next_before_sequence: hasOlder ? events[0]!.sequence : null,
  });
});

const transitionSchema = z.object({ reason: z.string().trim().min(3).max(2_000) }).strict();

async function performTransition(
  req: Request,
  action: 'acknowledge' | 'resolve',
): Promise<{ id: string; status: string }> {
  const organizationId = requireOrganization(req);
  const exceptionId = z.string().uuid().parse(req.params.id);
  const body = transitionSchema.parse(req.body);
  try {
    return await withTransaction(async (client) => {
      const allowed = await canAccessOperationalException(client, {
        organizationId,
        exceptionId,
        userId: req.user!.id,
        role: req.user!.role as 'admin' | 'foreman',
        lock: true,
      });
      if (!allowed) throw notFound('Incidencia no encontrada');
      const result = await transitionOperationalException(client, {
        organizationId,
        exceptionId,
        actorUserId: req.user!.id,
        action,
        reason: body.reason,
      });
      await recordAudit(
        {
          organizationId,
          actorUserId: req.user!.id,
          action: `operational_exception.${action === 'acknowledge' ? 'acknowledged' : 'resolved'}`,
          entityType: 'operational_exception',
          entityId: exceptionId,
          reason: body.reason,
        },
        client,
      );
      return result;
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'operational_exception_not_found') {
      throw notFound('Incidencia no encontrada');
    }
    if (error instanceof Error && error.message === 'operational_exception_transition_conflict') {
      throw conflict('La incidencia ya cambió de estado', 'exception_transition_conflict');
    }
    throw error;
  }
}

operationalExceptionsRouter.post('/:id/acknowledge', async (req, res) => {
  res.json(await performTransition(req, 'acknowledge'));
});

operationalExceptionsRouter.post('/:id/resolve', async (req, res) => {
  res.json(await performTransition(req, 'resolve'));
});

const reconcileSchema = z
  .object({
    from_date: z.string().regex(DATE_RE),
    to_date: z.string().regex(DATE_RE),
  })
  .strict()
  .refine((value) => value.from_date <= value.to_date, {
    path: ['to_date'],
    message: 'to_date must not precede from_date',
  });

operationalExceptionsRouter.post('/reconcile/run', requireAdmin, async (req, res) => {
  const organizationId = requireOrganization(req);
  const body = reconcileSchema.parse(req.body);
  const settings = await getSettings(organizationId);
  const result = await withTransaction(async (client) => {
    const reconciled = await reconcileOperationalExceptions(client, {
      organizationId,
      fromDate: body.from_date,
      toDate: body.to_date,
      timezone: settings.timezone,
    });
    await recordAudit(
      {
        organizationId,
        actorUserId: req.user!.id,
        action: 'operational_exceptions.reconciled',
        entityType: 'operational_exception_projection',
        entityId: null,
        metadata: {
          from_date: body.from_date,
          to_date: body.to_date,
          ...reconciled,
        },
      },
      client,
    );
    return reconciled;
  });
  res.json(result);
});
