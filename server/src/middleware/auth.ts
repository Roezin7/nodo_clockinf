import type { Request, Response, NextFunction } from 'express';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { query, queryOne } from '../db.js';
import { forbidden, unauthorized } from '../errors.js';

export type UserRole = 'platform_operator' | 'admin' | 'foreman' | 'accountant';

export interface AuthUser {
  id: string;
  role: UserRole;
  name: string;
  email: string;
  organizationId: string | null;
  sessionVersion?: number;
}

export interface AuthDevice {
  id: string;
  organizationId: string;
  plantId: string;
  name: string;
  publicId: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
      device?: AuthDevice;
    }
  }
}

export function signAccessToken(user: AuthUser): string {
  return jwt.sign(
    {
      role: user.role,
      name: user.name,
      email: user.email,
      organization_id: user.organizationId,
      session_version: user.sessionVersion ?? 1,
    },
    config.jwtSecret,
    { subject: user.id, expiresIn: config.accessTokenTtl } as jwt.SignOptions
  );
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw unauthorized('Falta token');
  let payload: jwt.JwtPayload;
  try {
    payload = jwt.verify(header.slice(7), config.jwtSecret) as jwt.JwtPayload;
  } catch {
    throw unauthorized('Token inválido o expirado');
  }
  if (!payload.sub || !Number.isInteger(payload.session_version)) {
    throw unauthorized('Token de sesión inválido');
  }
  const current = await queryOne<{
    id: string;
    role: AuthUser['role'];
    name: string;
    email: string;
    organization_id: string | null;
    session_version: number;
  }>(
    `SELECT u.id, u.role, u.name, u.email, u.organization_id, u.session_version
     FROM users u
     LEFT JOIN organizations o ON o.id = u.organization_id
     WHERE u.id = $1 AND u.active
       AND (u.role = 'platform_operator' OR o.active)`,
    [payload.sub],
  );
  if (!current || current.session_version !== payload.session_version) {
    throw unauthorized('Sesión revocada');
  }
  req.user = {
    id: current.id,
    role: current.role,
    name: current.name,
    email: current.email,
    organizationId: current.organization_id,
    sessionVersion: current.session_version,
  };
  next();
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (req.user?.role !== 'admin') throw forbidden('Requiere rol admin');
  next();
}

export function requirePlatformOperator(req: Request, _res: Response, next: NextFunction): void {
  if (req.user?.role !== 'platform_operator') throw forbidden('Requiere operador de plataforma');
  next();
}

export function requireRole(...roles: UserRole[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user || !roles.includes(req.user.role)) throw forbidden('Permiso denegado');
    next();
  };
}

export function requireOrganization(req: Request): string {
  if (!req.user?.organizationId) throw forbidden('El usuario no pertenece a una organización');
  return req.user.organizationId;
}

/**
 * Device-scoped kiosk authentication. Enrollment tokens are only returned once
 * and only their SHA-256 digest is persisted. A revoked device (or one whose
 * tenant/plant was disabled) immediately loses access.
 */
export async function requireKiosk(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  const token = req.headers['x-device-token'];
  if (typeof token !== 'string' || token.length < 20) {
    throw unauthorized('Token de dispositivo inválido');
  }
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const device = await queryOne<{
    id: string;
    organization_id: string;
    plant_id: string;
    name: string;
    public_id: string;
  }>(
    `SELECT d.id, d.organization_id, d.plant_id, d.name, d.public_id
     FROM devices d
     JOIN organizations o ON o.id = d.organization_id AND o.active
     JOIN plants p ON p.id = d.plant_id AND p.organization_id = d.organization_id AND p.active
     WHERE d.token_hash = $1 AND d.active AND d.enrolled_at IS NOT NULL`,
    [tokenHash]
  );
  if (!device) throw unauthorized('Token de dispositivo inválido');
  req.device = {
    id: device.id,
    organizationId: device.organization_id,
    plantId: device.plant_id,
    name: device.name,
    publicId: device.public_id,
  };
  await query(`UPDATE devices SET last_seen_at = now() WHERE id = $1`, [device.id]);
  next();
}
