import { Router, type Request, type Response } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { query, withTransaction } from '../db.js';
import { badRequest, conflict, forbidden, unauthorized } from '../errors.js';
import {
  requireAuth,
  signAccessToken,
  type AuthUser,
} from '../middleware/auth.js';
import { config } from '../config.js';
import { recordAudit } from '../services/auditService.js';

export const authRouter = Router();
const REFRESH_COOKIE = 'clockai_refresh';

authRouter.use((req, _res, next) => {
  if (!['POST', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const origin = req.headers.origin;
  if (!origin) return next(); // CLI/tests/non-browser same-origin clients
  const host = req.headers.host;
  const sameHost = host && (origin === `https://${host}` || origin === `http://${host}`);
  if (sameHost || config.corsOrigins.includes(origin)) return next();
  throw forbidden('Origen no autorizado');
});

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  role: AuthUser['role'];
  name: string;
  organization_id: string | null;
  active: boolean;
  session_version: number;
  created_at: string;
}

const sha256 = (value: string): string => crypto.createHash('sha256').update(value).digest('hex');

function cookieValue(req: Request, name: string): string | null {
  for (const item of (req.headers.cookie ?? '').split(';')) {
    const [key, ...parts] = item.trim().split('=');
    if (key === name) return decodeURIComponent(parts.join('='));
  }
  return null;
}

function setRefreshCookie(res: Response, token: string): void {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: config.nodeEnv === 'production',
    sameSite: 'strict',
    path: '/api/auth',
    maxAge: config.refreshTokenTtlDays * 24 * 3_600_000,
  });
}

function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, {
    httpOnly: true,
    secure: config.nodeEnv === 'production',
    sameSite: 'strict',
    path: '/api/auth',
  });
}

async function issueRefreshToken(
  client: PoolClient,
  userId: string,
  familyId?: string,
  parentTokenId?: string,
): Promise<string> {
  const token = crypto.randomBytes(48).toString('base64url');
  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + config.refreshTokenTtlDays * 24 * 3_600_000);
  await client.query(
    `INSERT INTO refresh_tokens
       (id, user_id, token_hash, expires_at, family_id, parent_token_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, userId, sha256(token), expiresAt, familyId ?? id, parentTokenId ?? null],
  );
  return token;
}

function publicUser(user: UserRow) {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    name: user.name,
    organization_id: user.organization_id,
    active: user.active,
    created_at: user.created_at,
  };
}

function authUser(user: UserRow): AuthUser {
  return {
    id: user.id,
    role: user.role,
    name: user.name,
    email: user.email,
    organizationId: user.organization_id,
    sessionVersion: user.session_version,
  };
}

function authResponse(user: UserRow) {
  return { access_token: signAccessToken(authUser(user)), user: publicUser(user) };
}

const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) }).strict();

authRouter.post('/login', async (req, res) => {
  const body = loginSchema.parse(req.body);
  const result = await withTransaction(async (client) => {
    const selected = await client.query<UserRow>(
      `SELECT u.* FROM users u
       LEFT JOIN organizations o ON o.id = u.organization_id
       WHERE u.email = lower($1) AND u.active
         AND (u.role = 'platform_operator' OR o.active)
       FOR UPDATE OF u`,
      [body.email],
    );
    const user = selected.rows[0];
    if (!user || !(await bcrypt.compare(body.password, user.password_hash))) {
      throw unauthorized('Credenciales inválidas');
    }
    await client.query(
      `UPDATE refresh_tokens
       SET revoked = true, revoked_reason = 'expired_cleanup'
       WHERE user_id = $1 AND NOT revoked AND expires_at <= now()`,
      [user.id],
    );
    return { user, refreshToken: await issueRefreshToken(client, user.id) };
  });
  setRefreshCookie(res, result.refreshToken);
  res.setHeader('Cache-Control', 'private, no-store');
  res.json(authResponse(result.user));
});

authRouter.post('/refresh', async (req, res) => {
  const presented = cookieValue(req, REFRESH_COOKIE);
  if (!presented) throw unauthorized('Falta sesión renovable');
  const result = await withTransaction(async (client) => {
    const selected = await client.query<{
      id: string;
      user_id: string;
      family_id: string;
      revoked: boolean;
      expires_at: Date;
    }>(
      `SELECT id, user_id, family_id, revoked, expires_at
       FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE`,
      [sha256(presented)],
    );
    const token = selected.rows[0];
    if (!token || token.revoked || token.expires_at <= new Date()) {
      throw unauthorized('Refresh token inválido o ya utilizado');
    }
    const users = await client.query<UserRow>(
      `SELECT u.* FROM users u
       LEFT JOIN organizations o ON o.id = u.organization_id
       WHERE u.id = $1 AND u.active
         AND (u.role = 'platform_operator' OR o.active)
       FOR UPDATE OF u`,
      [token.user_id],
    );
    const user = users.rows[0];
    if (!user) throw unauthorized('Usuario inactivo');
    const consumed = await client.query(
      `UPDATE refresh_tokens
       SET revoked = true, used_at = now(), revoked_reason = 'rotated'
       WHERE id = $1 AND NOT revoked
       RETURNING id`,
      [token.id],
    );
    if (!consumed.rowCount) throw conflict('La sesión ya fue renovada', 'REFRESH_RACE');
    return {
      user,
      refreshToken: await issueRefreshToken(client, user.id, token.family_id, token.id),
    };
  });
  setRefreshCookie(res, result.refreshToken);
  res.setHeader('Cache-Control', 'private, no-store');
  res.json(authResponse(result.user));
});

authRouter.post('/logout', async (req, res) => {
  const presented = cookieValue(req, REFRESH_COOKIE);
  if (presented) {
    await query(
      `UPDATE refresh_tokens
       SET revoked = true, revoked_reason = COALESCE(revoked_reason, 'user_logout')
       WHERE token_hash = $1`,
      [sha256(presented)],
    );
  }
  clearRefreshCookie(res);
  res.status(204).end();
});

const changePasswordSchema = z.object({
  current_password: z.string().min(1),
  new_password: z.string().min(12, 'Mínimo 12 caracteres').max(200),
}).strict();

authRouter.post('/change-password', requireAuth, async (req, res) => {
  const body = changePasswordSchema.parse(req.body);
  if (body.current_password === body.new_password) {
    throw badRequest('La contraseña nueva debe ser diferente');
  }
  await withTransaction(async (client) => {
    const selected = await client.query<UserRow>(
      `SELECT * FROM users WHERE id = $1 AND active FOR UPDATE`,
      [req.user!.id],
    );
    const user = selected.rows[0];
    if (!user || !(await bcrypt.compare(body.current_password, user.password_hash))) {
      throw unauthorized('La contraseña actual no es correcta');
    }
    await client.query(
      `UPDATE users
       SET password_hash = $2, session_version = session_version + 1
       WHERE id = $1`,
      [user.id, await bcrypt.hash(body.new_password, 12)],
    );
    await client.query(
      `UPDATE refresh_tokens
       SET revoked = true, revoked_reason = COALESCE(revoked_reason, 'password_changed')
       WHERE user_id = $1 AND NOT revoked`,
      [user.id],
    );
    await recordAudit({
      organizationId: user.organization_id,
      actorUserId: user.id,
      action: 'auth.password_changed',
      entityType: 'user',
      entityId: user.id,
    }, client);
  });
  clearRefreshCookie(res);
  res.status(204).end();
});
