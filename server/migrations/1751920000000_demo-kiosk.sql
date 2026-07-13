-- Up Migration

-- Test punches are intentionally outside punches, weekly reports, dashboards
-- and biometric evidence. They may use a real active employee number only to
-- make an owner demo recognizable without contaminating payable time.
CREATE TABLE demo_kiosk_punches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  employee_id uuid NOT NULL REFERENCES employees(id),
  employee_number integer NOT NULL,
  employee_name text NOT NULL,
  punch_type text NOT NULL CHECK (punch_type IN ('shift_in', 'shift_out', 'meal_out', 'meal_in')),
  punched_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX demo_kiosk_punches_org_time_idx
  ON demo_kiosk_punches (organization_id, punched_at DESC);

-- Down Migration

DROP TABLE IF EXISTS demo_kiosk_punches;
