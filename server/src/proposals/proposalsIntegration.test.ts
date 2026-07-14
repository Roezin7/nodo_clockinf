import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { pool } from '../db.js';

let server: Server;
let baseUrl = '';

describe('public commercial proposal routing', () => {
  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server = createApp().listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('missing proposal test port');
        baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
  });

  it('serves the configured proposal without password, cookie or production data', async () => {
    const response = await fetch(`${baseUrl}/api/proposals/empacadora-jbl`);
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toBeNull();
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({ proposal: { slug: 'empacadora-jbl', provider: { name: 'Leader Solutions' } } });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toMatch(/password|token|acceptance|employee_id|organization_id/i);
  });

  it('does not expose access or acceptance mutation endpoints', async () => {
    const headers = { 'content-type': 'application/json' };
    expect((await fetch(`${baseUrl}/api/proposals/empacadora-jbl/access`, { method: 'POST', headers, body: '{}' })).status).toBe(404);
    expect((await fetch(`${baseUrl}/api/proposals/empacadora-jbl/acceptances`, { method: 'POST', headers, body: '{}' })).status).toBe(404);
  });
});
