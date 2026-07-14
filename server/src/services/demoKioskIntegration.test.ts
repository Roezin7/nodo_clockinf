import bcrypt from 'bcryptjs';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { pool, queryOne } from '../db.js';
import { config } from '../config.js';

const run = process.env.RUN_DB_INTEGRATION === '1' && Boolean(config.demoKioskOrganizationSlug);
let server: Server;
let baseUrl = '';
let employeeNumber = 0;

describe.skipIf(!run)('demo kiosk isolation', () => {
  beforeAll(async () => {
    const organization = await queryOne<{ id: string }>(
      `INSERT INTO organizations (name, slug, timezone) VALUES ('Demo Integration', $1, 'America/Los_Angeles') RETURNING id`,
      [config.demoKioskOrganizationSlug],
    );
    const shift = await queryOne<{ id: string }>(
      `INSERT INTO shifts (organization_id, name, start_time, end_time) VALUES ($1, 'Demo shift', '05:00', '13:30') RETURNING id`,
      [organization!.id],
    );
    const employee = await queryOne<{ employee_number: number }>(
      `INSERT INTO employees (organization_id, full_name, pin_hash, default_shift_id)
       VALUES ($1, 'Empleado de Prueba', $2, $3) RETURNING employee_number`,
      [organization!.id, await bcrypt.hash('1234', 10), shift!.id],
    );
    employeeNumber = employee!.employee_number;
    await new Promise<void>((resolve) => {
      server = createApp().listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('missing demo test port');
        baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
  });

  it('records a real employee only in the isolated demonstration ledger', async () => {
    const initial = await fetch(`${baseUrl}/api/demo-kiosk/recent`);
    expect(initial.status).toBe(200);
    expect((await initial.json() as { punches: unknown[] }).punches).toEqual([]);
    const created = await fetch(`${baseUrl}/api/demo-kiosk/punches`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ employee_number: employeeNumber, punch_type: 'shift_in' }),
    });
    expect(created.status).toBe(201);
    const body = await created.json() as { punch: { employee_name: string }; demonstration_only: boolean };
    expect(body.punch.employee_name).toBe('Empleado de Prueba');
    expect(body.demonstration_only).toBe(true);
    const operational = await queryOne<{ count: string }>(
      `SELECT count(*)::text AS count FROM punches p
       JOIN employees e ON e.id = p.employee_id
       WHERE e.employee_number = $1`,
      [employeeNumber],
    );
    expect(operational!.count).toBe('0');
    const recent = await fetch(`${baseUrl}/api/demo-kiosk/recent`);
    expect(recent.status).toBe(200);
    expect((await recent.json() as { punches: unknown[] }).punches).toHaveLength(1);
  });
});
