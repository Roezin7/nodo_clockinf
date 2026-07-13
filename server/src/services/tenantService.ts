import type { Request } from 'express';
import { query, queryOne } from '../db.js';
import { forbidden, notFound } from '../errors.js';
import { requireOrganization, type AuthUser } from '../middleware/auth.js';

export function canAccessAllPlants(role: AuthUser['role']): boolean {
  return role === 'admin' || role === 'accountant';
}

export function canManageCustomerData(role: AuthUser['role']): boolean {
  return role === 'admin';
}

export function canViewRates(role: AuthUser['role']): boolean {
  return role === 'admin';
}

export function canViewIdentityEvidence(role: AuthUser['role']): boolean {
  return role === 'admin' || role === 'foreman';
}

export async function getDefaultOrganizationId(): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `SELECT id FROM organizations WHERE active ORDER BY created_at LIMIT 1`
  );
  if (!row) throw notFound('No hay organización activa');
  return row.id;
}

export async function getDefaultPlantId(organizationId: string): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `SELECT id FROM plants
     WHERE organization_id = $1 AND active
     ORDER BY code LIMIT 1`,
    [organizationId]
  );
  if (!row) throw notFound('No hay planta activa');
  return row.id;
}

export async function accessiblePlantIds(user: AuthUser): Promise<string[]> {
  if (!user.organizationId) return [];
  if (canAccessAllPlants(user.role)) {
    const rows = await query<{ id: string }>(
      `SELECT id FROM plants WHERE organization_id = $1 AND active ORDER BY code`,
      [user.organizationId]
    );
    return rows.map((row) => row.id);
  }
  if (user.role === 'foreman') {
    const rows = await query<{ id: string }>(
      `SELECT p.id
       FROM plants p
       JOIN user_plant_access a ON a.plant_id = p.id
       WHERE a.user_id = $1 AND p.organization_id = $2 AND p.active
       ORDER BY p.code`,
      [user.id, user.organizationId]
    );
    return rows.map((row) => row.id);
  }
  return [];
}

export async function assertPlantAccess(req: Request, plantId: string): Promise<void> {
  const organizationId = requireOrganization(req);
  const plant = await queryOne<{ id: string }>(
    `SELECT id FROM plants WHERE id = $1 AND organization_id = $2 AND active`,
    [plantId, organizationId]
  );
  if (!plant) throw notFound('Planta no encontrada');
  const allowed = await accessiblePlantIds(req.user!);
  if (!allowed.includes(plantId)) throw forbidden('Sin acceso a esta planta');
}
