-- Up Migration

-- Tenancy boundary. Platform operators may have no organization; every
-- customer user and every operational record is scoped to one organization.
CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text UNIQUE NOT NULL,
  timezone text NOT NULL DEFAULT 'America/Los_Angeles',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO organizations (name, slug, timezone)
VALUES ('Modesto Packing Operations', 'modesto-packing', 'America/Los_Angeles');

CREATE TABLE plants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  code text NOT NULL,
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code),
  UNIQUE (organization_id, name),
  UNIQUE (id, organization_id)
);

INSERT INTO plants (organization_id, code, name)
SELECT id, v.code, v.name
FROM organizations
CROSS JOIN (VALUES ('P1', 'Plant 1'), ('P2', 'Plant 2'), ('P3', 'Plant 3')) AS v(code, name)
WHERE slug = 'modesto-packing';

-- Replace the legacy two-role model. Existing supervisors become foremen.
ALTER TABLE users DROP CONSTRAINT users_role_check;
UPDATE users SET role = 'foreman' WHERE role = 'supervisor';
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('platform_operator', 'admin', 'foreman', 'accountant'));
ALTER TABLE users ADD COLUMN organization_id uuid REFERENCES organizations(id);
UPDATE users
SET organization_id = (SELECT id FROM organizations WHERE slug = 'modesto-packing')
WHERE role <> 'platform_operator';
ALTER TABLE users ADD CONSTRAINT customer_user_requires_organization
  CHECK (role = 'platform_operator' OR organization_id IS NOT NULL);
ALTER TABLE users ADD CONSTRAINT users_id_org_unique UNIQUE (id, organization_id);

CREATE TABLE user_plant_access (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plant_id uuid NOT NULL REFERENCES plants(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, plant_id),
  FOREIGN KEY (user_id, organization_id) REFERENCES users(id, organization_id),
  FOREIGN KEY (plant_id, organization_id) REFERENCES plants(id, organization_id)
);

CREATE TABLE devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  plant_id uuid NOT NULL REFERENCES plants(id),
  name text NOT NULL,
  public_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,
  active boolean NOT NULL DEFAULT true,
  last_seen_at timestamptz,
  last_sync_at timestamptz,
  app_version text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plant_id, name),
  UNIQUE (id, organization_id, plant_id),
  FOREIGN KEY (plant_id, organization_id) REFERENCES plants(id, organization_id)
);
CREATE INDEX devices_org_plant_idx ON devices (organization_id, plant_id);

-- Scope existing catalogs and employees. The serial sequence may remain global,
-- while uniqueness is enforced inside each customer organization.
ALTER TABLE areas ADD COLUMN organization_id uuid REFERENCES organizations(id);
UPDATE areas SET organization_id = (SELECT id FROM organizations WHERE slug = 'modesto-packing');
ALTER TABLE areas ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE areas DROP CONSTRAINT areas_name_key;
ALTER TABLE areas ADD CONSTRAINT areas_org_name_unique UNIQUE (organization_id, name);
ALTER TABLE areas ADD CONSTRAINT areas_id_org_unique UNIQUE (id, organization_id);

ALTER TABLE shifts ADD COLUMN organization_id uuid REFERENCES organizations(id);
UPDATE shifts SET organization_id = (SELECT id FROM organizations WHERE slug = 'modesto-packing');
ALTER TABLE shifts ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE shifts ADD CONSTRAINT shifts_id_org_unique UNIQUE (id, organization_id);

ALTER TABLE employees ADD COLUMN organization_id uuid REFERENCES organizations(id);
UPDATE employees SET organization_id = (SELECT id FROM organizations WHERE slug = 'modesto-packing');
ALTER TABLE employees ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE employees DROP CONSTRAINT employees_employee_number_key;
ALTER TABLE employees ADD CONSTRAINT employees_org_number_unique UNIQUE (organization_id, employee_number);
ALTER TABLE employees ADD CONSTRAINT employees_id_org_unique UNIQUE (id, organization_id);
ALTER TABLE employees DROP CONSTRAINT employees_default_shift_id_fkey;
ALTER TABLE employees ADD CONSTRAINT employees_org_shift_fk
  FOREIGN KEY (default_shift_id, organization_id) REFERENCES shifts(id, organization_id);

CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE TABLE employee_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  hourly_rate numeric(12, 4) NOT NULL CHECK (hourly_rate >= 0),
  effective_from date NOT NULL,
  effective_to date,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  UNIQUE (employee_id, effective_from),
  FOREIGN KEY (employee_id, organization_id) REFERENCES employees(id, organization_id),
  EXCLUDE USING gist (
    employee_id WITH =,
    daterange(effective_from, COALESCE(effective_to + 1, 'infinity'::date), '[)') WITH &&
  )
);
CREATE INDEX employee_rates_effective_idx
  ON employee_rates (employee_id, effective_from DESC);

-- Operational records carry their own tenant/device/plant identity so audit
-- history cannot change meaning if an employee later moves to another plant.
ALTER TABLE punches ADD COLUMN organization_id uuid REFERENCES organizations(id);
UPDATE punches p SET organization_id = e.organization_id
FROM employees e WHERE e.id = p.employee_id;
ALTER TABLE punches ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE punches ADD COLUMN plant_id uuid REFERENCES plants(id);
UPDATE punches
SET plant_id = (
  SELECT p.id FROM plants p
  WHERE p.organization_id = punches.organization_id
  ORDER BY p.code LIMIT 1
);
ALTER TABLE punches ALTER COLUMN plant_id SET NOT NULL;
ALTER TABLE punches ADD COLUMN device_id uuid REFERENCES devices(id);
ALTER TABLE punches ADD COLUMN client_event_id uuid;
ALTER TABLE punches ADD COLUMN captured_at timestamptz;
UPDATE punches SET captured_at = punched_at;
ALTER TABLE punches ALTER COLUMN captured_at SET NOT NULL;
ALTER TABLE punches ADD COLUMN received_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE punches ADD COLUMN offline boolean NOT NULL DEFAULT false;
ALTER TABLE punches ADD COLUMN identity_status text NOT NULL DEFAULT 'not_required'
  CHECK (identity_status IN ('verified','identity_review','review_approved','review_rejected','not_required'));
CREATE UNIQUE INDEX punches_device_client_event_unique
  ON punches (device_id, client_event_id)
  WHERE device_id IS NOT NULL AND client_event_id IS NOT NULL;
CREATE INDEX punches_org_time_idx ON punches (organization_id, punched_at);
CREATE INDEX punches_plant_time_idx ON punches (plant_id, punched_at);
ALTER TABLE punches ADD CONSTRAINT punches_org_employee_fk
  FOREIGN KEY (employee_id, organization_id) REFERENCES employees(id, organization_id);
ALTER TABLE punches ADD CONSTRAINT punches_org_plant_fk
  FOREIGN KEY (plant_id, organization_id) REFERENCES plants(id, organization_id);
ALTER TABLE punches ADD CONSTRAINT punches_org_device_plant_fk
  FOREIGN KEY (device_id, organization_id, plant_id) REFERENCES devices(id, organization_id, plant_id);

ALTER TABLE daily_area_assignments ADD COLUMN organization_id uuid REFERENCES organizations(id);
UPDATE daily_area_assignments d SET organization_id = e.organization_id
FROM employees e WHERE e.id = d.employee_id;
ALTER TABLE daily_area_assignments ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE daily_area_assignments ADD COLUMN plant_id uuid REFERENCES plants(id);
UPDATE daily_area_assignments
SET plant_id = (
  SELECT p.id FROM plants p
  WHERE p.organization_id = daily_area_assignments.organization_id
  ORDER BY p.code LIMIT 1
);
ALTER TABLE daily_area_assignments ALTER COLUMN plant_id SET NOT NULL;
ALTER TABLE daily_area_assignments ADD CONSTRAINT assignments_org_employee_fk
  FOREIGN KEY (employee_id, organization_id) REFERENCES employees(id, organization_id);
ALTER TABLE daily_area_assignments ADD CONSTRAINT assignments_org_plant_fk
  FOREIGN KEY (plant_id, organization_id) REFERENCES plants(id, organization_id);

ALTER TABLE punch_voids ADD COLUMN organization_id uuid REFERENCES organizations(id);
UPDATE punch_voids v SET organization_id = p.organization_id
FROM punches p WHERE p.id = v.punch_id;
ALTER TABLE punch_voids ALTER COLUMN organization_id SET NOT NULL;

ALTER TABLE weekly_reports ADD COLUMN organization_id uuid REFERENCES organizations(id);
UPDATE weekly_reports SET organization_id = (SELECT id FROM organizations WHERE slug = 'modesto-packing');
ALTER TABLE weekly_reports ALTER COLUMN organization_id SET NOT NULL;
DROP INDEX weekly_reports_final_unique;
CREATE UNIQUE INDEX weekly_reports_final_unique
  ON weekly_reports (organization_id, week_start) WHERE status = 'final';

ALTER TABLE settings ADD COLUMN organization_id uuid REFERENCES organizations(id);
UPDATE settings SET organization_id = (SELECT id FROM organizations WHERE slug = 'modesto-packing');
ALTER TABLE settings ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE settings DROP CONSTRAINT settings_pkey;
ALTER TABLE settings ADD PRIMARY KEY (organization_id, key);
-- Organization is the single source of truth for timezone.
DELETE FROM settings WHERE key = 'timezone';

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id),
  actor_user_id uuid REFERENCES users(id),
  actor_device_id uuid REFERENCES devices(id),
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid,
  reason text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (actor_user_id IS NOT NULL OR actor_device_id IS NOT NULL)
);
CREATE INDEX audit_events_org_time_idx ON audit_events (organization_id, created_at DESC);
CREATE INDEX audit_events_entity_idx ON audit_events (entity_type, entity_id);

-- Extend the immutable guard to the new meaning-bearing columns.
CREATE OR REPLACE FUNCTION punches_immutable_guard() RETURNS trigger AS $$
BEGIN
  IF (NEW.organization_id, NEW.employee_id, NEW.punch_type, NEW.punched_at,
      NEW.captured_at, NEW.received_at, NEW.plant_id, NEW.device_id,
      NEW.client_event_id, NEW.offline, NEW.area_id, NEW.source,
      NEW.created_by, NEW.correction_of, NEW.correction_reason, NEW.created_at)
     IS DISTINCT FROM
     (OLD.organization_id, OLD.employee_id, OLD.punch_type, OLD.punched_at,
      OLD.captured_at, OLD.received_at, OLD.plant_id, OLD.device_id,
      OLD.client_event_id, OLD.offline, OLD.area_id, OLD.source,
      OLD.created_by, OLD.correction_of, OLD.correction_reason, OLD.created_at)
  THEN
    RAISE EXCEPTION 'punches is immutable: create an audited correction instead';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Down Migration
DROP TABLE IF EXISTS audit_events;

ALTER TABLE settings DROP CONSTRAINT settings_pkey;
ALTER TABLE settings ADD PRIMARY KEY (key);
ALTER TABLE settings DROP COLUMN organization_id;

DROP INDEX IF EXISTS weekly_reports_final_unique;
CREATE UNIQUE INDEX weekly_reports_final_unique ON weekly_reports (week_start) WHERE status = 'final';
ALTER TABLE weekly_reports DROP COLUMN organization_id;

ALTER TABLE punch_voids DROP COLUMN organization_id;
ALTER TABLE daily_area_assignments DROP COLUMN plant_id;
ALTER TABLE daily_area_assignments DROP COLUMN organization_id;

DROP INDEX IF EXISTS punches_plant_time_idx;
DROP INDEX IF EXISTS punches_org_time_idx;
DROP INDEX IF EXISTS punches_device_client_event_unique;
ALTER TABLE punches DROP COLUMN identity_status;
ALTER TABLE punches DROP COLUMN offline;
ALTER TABLE punches DROP COLUMN received_at;
ALTER TABLE punches DROP COLUMN captured_at;
ALTER TABLE punches DROP COLUMN client_event_id;
ALTER TABLE punches DROP COLUMN device_id;
ALTER TABLE punches DROP COLUMN plant_id;
ALTER TABLE punches DROP COLUMN organization_id;

DROP TABLE IF EXISTS employee_rates;
ALTER TABLE employees DROP CONSTRAINT employees_org_number_unique;
ALTER TABLE employees DROP CONSTRAINT employees_org_shift_fk;
ALTER TABLE employees ADD CONSTRAINT employees_default_shift_id_fkey
  FOREIGN KEY (default_shift_id) REFERENCES shifts(id);
ALTER TABLE employees DROP CONSTRAINT employees_id_org_unique;
ALTER TABLE employees ADD CONSTRAINT employees_employee_number_key UNIQUE (employee_number);
ALTER TABLE employees DROP COLUMN organization_id;
ALTER TABLE shifts DROP CONSTRAINT shifts_id_org_unique;
ALTER TABLE shifts DROP COLUMN organization_id;
ALTER TABLE areas DROP CONSTRAINT areas_id_org_unique;
ALTER TABLE areas DROP CONSTRAINT areas_org_name_unique;
ALTER TABLE areas ADD CONSTRAINT areas_name_key UNIQUE (name);
ALTER TABLE areas DROP COLUMN organization_id;

DROP TABLE IF EXISTS devices;
DROP TABLE IF EXISTS user_plant_access;
ALTER TABLE users DROP CONSTRAINT customer_user_requires_organization;
ALTER TABLE users DROP CONSTRAINT users_id_org_unique;
ALTER TABLE users DROP COLUMN organization_id;
ALTER TABLE users DROP CONSTRAINT users_role_check;
UPDATE users SET role = 'supervisor' WHERE role = 'foreman';
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin', 'supervisor'));
DROP TABLE IF EXISTS plants;
DROP TABLE IF EXISTS organizations;

CREATE OR REPLACE FUNCTION punches_immutable_guard() RETURNS trigger AS $$
BEGIN
  IF (NEW.employee_id, NEW.punch_type, NEW.punched_at, NEW.area_id, NEW.source,
      NEW.created_by, NEW.correction_of, NEW.correction_reason, NEW.created_at)
     IS DISTINCT FROM
     (OLD.employee_id, OLD.punch_type, OLD.punched_at, OLD.area_id, OLD.source,
      OLD.created_by, OLD.correction_of, OLD.correction_reason, OLD.created_at)
  THEN
    RAISE EXCEPTION 'punches is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
