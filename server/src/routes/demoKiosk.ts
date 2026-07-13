import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne } from '../db.js';
import { notFound } from '../errors.js';
import { requireDemoKiosk } from '../middleware/auth.js';
import { config } from '../config.js';

export const demoKioskRouter = Router();

const bodySchema = z.object({
  employee_number: z.number().int().positive(),
  punch_type: z.enum(['shift_in', 'shift_out', 'meal_out', 'meal_in']),
}).strict();

interface DemoOrganization { id: string; name: string; timezone: string }

async function demoOrganization(): Promise<DemoOrganization> {
  const organization = await queryOne<DemoOrganization>(
    `SELECT id, name, timezone FROM organizations
     WHERE slug = $1 AND active`,
    [config.demoKioskOrganizationSlug],
  );
  if (!organization) throw notFound('La organización del kiosco de pruebas no está disponible');
  return organization;
}

demoKioskRouter.use(requireDemoKiosk);

demoKioskRouter.get('/recent', async (_req, res) => {
  const organization = await demoOrganization();
  const punches = await query<{
    id: string; employee_number: number; employee_name: string; punch_type: string; punched_at: Date;
  }>(
    `SELECT id, employee_number, employee_name, punch_type, punched_at
     FROM demo_kiosk_punches
     WHERE organization_id = $1
     ORDER BY punched_at DESC, created_at DESC
     LIMIT 30`,
    [organization.id],
  );
  res.setHeader('Cache-Control', 'no-store');
  res.json({ organization_name: organization.name, timezone: organization.timezone, punches });
});

demoKioskRouter.post('/punches', async (req, res) => {
  const input = bodySchema.parse(req.body);
  const organization = await demoOrganization();
  const employee = await queryOne<{ id: string; employee_number: number; full_name: string }>(
    `SELECT id, employee_number, full_name FROM employees
     WHERE organization_id = $1 AND employee_number = $2 AND active`,
    [organization.id, input.employee_number],
  );
  if (!employee) throw notFound('Empleado activo no encontrado para la demostración');
  const punch = await queryOne<{
    id: string; employee_number: number; employee_name: string; punch_type: string; punched_at: Date;
  }>(
    `INSERT INTO demo_kiosk_punches
      (organization_id, employee_id, employee_number, employee_name, punch_type)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, employee_number, employee_name, punch_type, punched_at`,
    [organization.id, employee.id, employee.employee_number, employee.full_name, input.punch_type],
  );
  res.status(201).setHeader('Cache-Control', 'no-store').json({
    punch,
    timezone: organization.timezone,
    demonstration_only: true,
  });
});
