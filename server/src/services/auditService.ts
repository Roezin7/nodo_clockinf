import type { PoolClient } from 'pg';
import { query } from '../db.js';

export interface AuditInput {
  organizationId: string | null;
  actorUserId?: string;
  actorDeviceId?: string;
  action: string;
  entityType: string;
  entityId?: string | null;
  reason?: string | null;
  metadata?: Record<string, unknown>;
}

export async function recordAudit(input: AuditInput, client?: PoolClient): Promise<void> {
  const sql = `INSERT INTO audit_events
    (organization_id, actor_user_id, actor_device_id, action, entity_type, entity_id, reason, metadata)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`;
  const params = [
    input.organizationId,
    input.actorUserId ?? null,
    input.actorDeviceId ?? null,
    input.action,
    input.entityType,
    input.entityId ?? null,
    input.reason ?? null,
    JSON.stringify(input.metadata ?? {}),
  ];
  if (client) await client.query(sql, params);
  else await query(sql, params);
}

