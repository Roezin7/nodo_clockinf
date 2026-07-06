import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { z } from 'zod';
import { query, queryOne } from '../db.js';
import { badRequest, unauthorized } from '../errors.js';
import { signAccessToken, type AuthUser } from '../middleware/auth.js';
import { config } from '../config.js';

export const authRouter = Router();

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  role: 'admin' | 'supervisor';
  name: string;
  active: boolean;
  created_at: string;
}

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

async function issueRefreshToken(userId: string): Promise<string> {
  const token = crypto.randomBytes(48).toString('base64url');
  const expiresAt = new Date(Date.now() + config.refreshTokenTtlDays * 24 * 3600 * 1000);
  await query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
    [userId, sha256(token), expiresAt]
  );
  return token;
}

function publicUser(u: UserRow) {
  return { id: u.id, email: u.email, role: u.role, name: u.name, active: u.active, created_at: u.created_at };
}

const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });

authRouter.post('/login', async (req, res) => {
  const body = loginSchema.parse(req.body);
  const user = await queryOne<UserRow>(
    `SELECT * FROM users WHERE email = lower($1) AND active`,
    [body.email]
  );
  if (!user || !(await bcrypt.compare(body.password, user.password_hash))) {
    throw unauthorized('Credenciales inválidas');
  }
  const authUser: AuthUser = { id: user.id, role: user.role, name: user.name, email: user.email };
  res.json({
    access_token: signAccessToken(authUser),
    refresh_token: await issueRefreshToken(user.id),
    user: publicUser(user),
  });
});

const refreshSchema = z.object({ refresh_token: z.string().min(1) });

authRouter.post('/refresh', async (req, res) => {
  const body = refreshSchema.parse(req.body);
  const row = await queryOne<{ id: string; user_id: string }>(
    `SELECT id, user_id FROM refresh_tokens
     WHERE token_hash = $1 AND NOT revoked AND expires_at > now()`,
    [sha256(body.refresh_token)]
  );
  if (!row) throw unauthorized('Refresh token inválido');

  const user = await queryOne<UserRow>(`SELECT * FROM users WHERE id = $1 AND active`, [row.user_id]);
  if (!user) throw unauthorized('Usuario inactivo');

  // Rotación: el token usado se revoca y se emite uno nuevo
  await query(`UPDATE refresh_tokens SET revoked = true WHERE id = $1`, [row.id]);
  const authUser: AuthUser = { id: user.id, role: user.role, name: user.name, email: user.email };
  res.json({
    access_token: signAccessToken(authUser),
    refresh_token: await issueRefreshToken(user.id),
    user: publicUser(user),
  });
});

authRouter.post('/logout', async (req, res) => {
  const body = refreshSchema.safeParse(req.body);
  if (!body.success) throw badRequest('Falta refresh_token');
  await query(`UPDATE refresh_tokens SET revoked = true WHERE token_hash = $1`, [
    sha256(body.data.refresh_token),
  ]);
  res.status(204).end();
});
