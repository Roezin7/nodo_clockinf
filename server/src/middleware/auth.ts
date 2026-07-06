import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { forbidden, unauthorized } from '../errors.js';

export interface AuthUser {
  id: string;
  role: 'admin' | 'supervisor';
  name: string;
  email: string;
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
    { role: user.role, name: user.name, email: user.email },
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

/** Autenticación del kiosco: token estático de dispositivo en header. */
export function requireKiosk(req: Request, _res: Response, next: NextFunction): void {
  const token = req.headers['x-device-token'];
  if (token !== config.kioskDeviceToken) throw unauthorized('Token de dispositivo inválido');
  next();
}
