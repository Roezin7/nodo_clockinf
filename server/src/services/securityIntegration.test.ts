import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { pool, queryOne } from '../db.js';

const run = process.env.RUN_DB_INTEGRATION === '1';

let server: Server;
let baseUrl = '';
let organizationId = '';
let userId = '';
let email = '';
const password = 'Correct-horse-battery-77';

function cookieFrom(response: Response): string {
  const raw = response.headers.get('set-cookie');
  if (!raw) throw new Error('missing refresh cookie');
  return raw.split(';')[0]!;
}

async function login(): Promise<{ response: Response; body: Record<string, any>; cookie: string }> {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  return { response, body: await response.json(), cookie: cookieFrom(response) };
}

describe.skipIf(!run)('Phase 9 session and privacy security integration', () => {
  beforeAll(async () => {
    const suffix = crypto.randomUUID();
    const org = await queryOne<{ id: string }>(
      `INSERT INTO organizations (name, slug, timezone)
       VALUES ('Security Integration', $1, 'America/Los_Angeles') RETURNING id`,
      [`security-${suffix}`],
    );
    organizationId = org!.id;
    email = `security-${suffix}@test.invalid`;
    const user = await queryOne<{ id: string }>(
      `INSERT INTO users (organization_id, email, password_hash, role, name)
       VALUES ($1, $2, $3, 'admin', 'Security Admin') RETURNING id`,
      [organizationId, email, await bcrypt.hash(password, 12)],
    );
    userId = user!.id;
    await new Promise<void>((resolve) => {
      server = createApp().listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('missing test port');
        baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
  });

  it('uses an HttpOnly rotating refresh cookie and immediately rejects a stale access token', async () => {
    const first = await login();
    expect(first.response.status).toBe(200);
    expect(first.response.headers.get('set-cookie')).toMatch(/HttpOnly/i);
    expect(first.response.headers.get('set-cookie')).toMatch(/SameSite=Strict/i);
    expect(first.body).toHaveProperty('access_token');
    expect(first.body).not.toHaveProperty('refresh_token');

    const access = await fetch(`${baseUrl}/api/organization`, {
      headers: { authorization: `Bearer ${first.body.access_token}` },
    });
    expect(access.status).toBe(200);

    const concurrent = await Promise.all([
      fetch(`${baseUrl}/api/auth/refresh`, { method: 'POST', headers: { cookie: first.cookie } }),
      fetch(`${baseUrl}/api/auth/refresh`, { method: 'POST', headers: { cookie: first.cookie } }),
    ]);
    expect(concurrent.map((response) => response.status).sort()).toEqual([200, 401]);

    await queryOne(
      `UPDATE users SET session_version = session_version + 1 WHERE id = $1 RETURNING id`,
      [userId],
    );
    const stale = await fetch(`${baseUrl}/api/organization`, {
      headers: { authorization: `Bearer ${first.body.access_token}` },
    });
    expect(stale.status).toBe(401);
  });

  it('changes a password transactionally and revokes every active session', async () => {
    const current = await login();
    const changed = await fetch(`${baseUrl}/api/auth/change-password`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${current.body.access_token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ current_password: password, new_password: 'Changed-password-88' }),
    });
    expect(changed.status).toBe(204);
    expect(changed.headers.get('set-cookie')).toMatch(/Expires=Thu, 01 Jan 1970/i);
    const oldAccess = await fetch(`${baseUrl}/api/organization`, {
      headers: { authorization: `Bearer ${current.body.access_token}` },
    });
    expect(oldAccess.status).toBe(401);

    const oldLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    expect(oldLogin.status).toBe(401);
    const newLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'Changed-password-88' }),
    });
    expect(newLogin.status).toBe(200);
  });
});
