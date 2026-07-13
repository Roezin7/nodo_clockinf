import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { forbidden, unauthorized } from '../errors.js';

export type UserRole = 'platform_operator' | 'admin' | 'foreman' | 'accountant';

export interface AuthUser {
  id: string;
  role: UserRole;
  name: string;
  email: string;
  organizationId: string | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export function signAccessToken(user: AuthUser): string {
  return jwt.sign(
    { role: user.role, name: user.name, email: user.email, organization_id: user.organizationId },
    config.jwtSecret,
    { subject: user.id, expiresIn: config.accessTokenTtl } as jwt.SignOptions
  );
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw unauthorized('Falta token');
  try {
    const payload = jwt.verify(header.slice(7), config.jwtSecret) as jwt.JwtPayload;
    req.user = {
      id: payload.sub as string,
      role: payload.role as AuthUser['role'],
      name: payload.name as string,
      email: payload.email as string,
      organizationId: (payload.organization_id as string | undefined) ?? null,
    };
    next();
  } catch {
    throw unauthorized('Token inválido o expirado');
  }
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

/** Autenticación del kiosco: token estático de dispositivo en header. */
export function requireKiosk(req: Request, _res: Response, next: NextFunction): void {
  const token = req.headers['x-device-token'];
  if (token !== config.kioskDeviceToken) throw unauthorized('Token de dispositivo inválido');
  next();
}
