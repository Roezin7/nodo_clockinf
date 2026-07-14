import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { pool, queryOne } from '../db.js';

const run = process.env.RUN_DB_INTEGRATION === '1' && Boolean(process.env.PROPOSAL_ACCESS_CODES);
let server: Server;
let baseUrl = '';
let cookie = '';

describe.skipIf(!run)('private proposal and acceptance isolation', () => {
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

  it('requires the per-proposal code and issues an HttpOnly scoped session', async () => {
    expect((await fetch(`${baseUrl}/api/proposals/empacadora-demo`)).status).toBe(403);
    const wrong = await fetch(`${baseUrl}/api/proposals/empacadora-demo/access`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'wrong-code' }),
    });
    expect(wrong.status).toBe(403);
    const access = await fetch(`${baseUrl}/api/proposals/empacadora-demo/access`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'proposal-ci-access' }),
    });
    expect(access.status).toBe(200);
    const setCookie = access.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    cookie = setCookie.split(';')[0]!;
    const proposal = await fetch(`${baseUrl}/api/proposals/empacadora-demo`, { headers: { cookie } });
    expect(proposal.status).toBe(200);
    expect((await proposal.json() as { proposal: { initialStations: number } }).proposal.initialStations).toBe(2);
  });

  it('recomputes prices and stores an immutable commercial record only', async () => {
    const beforePunches = await queryOne<{ count: string }>('SELECT count(*)::text AS count FROM punches');
    const response = await fetch(`${baseUrl}/api/proposals/empacadora-demo/acceptances`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        legalCompanyName: 'Integration Packing LLC', representativeName: 'María López',
        email: 'maria@example.com', phone: '+1 209 555 0181', stations: 3, plants: 1,
        employees: 80, pricingConfirmed: true, termsAccepted: true,
        signature: 'María López', requestKickoff: true,
      }),
    });
    expect(response.status).toBe(201);
    const body = await response.json() as { acceptance_id: string; prices: { firstYearCents: number } };
    expect(body.prices.firstYearCents).toBe(1_689_500);
    const stored = await queryOne<{ accepted_prices: { secondYearCents: number }; proposal_version: string }>(
      'SELECT accepted_prices, proposal_version FROM proposal_acceptances WHERE id = $1', [body.acceptance_id],
    );
    expect(stored).toMatchObject({ proposal_version: '2026.07.1', accepted_prices: { secondYearCents: 1_423_200 } });
    await expect(pool.query('UPDATE proposal_acceptances SET phone = phone WHERE id = $1', [body.acceptance_id])).rejects.toThrow(/immutable/);
    const afterPunches = await queryOne<{ count: string }>('SELECT count(*)::text AS count FROM punches');
    expect(afterPunches).toEqual(beforePunches);
    const ipColumn = await queryOne<{ count: string }>("SELECT count(*)::text AS count FROM information_schema.columns WHERE table_name = 'proposal_acceptances' AND column_name IN ('ip', 'ip_address')");
    expect(ipColumn!.count).toBe('0');
  });
});
