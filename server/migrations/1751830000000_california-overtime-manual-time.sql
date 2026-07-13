-- Up Migration

-- Credited hours requested by the business. They are worked-time credits, not
-- a selectable premium: the California engine decides regular/1.5x/2x.
CREATE TABLE manual_time_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  employee_id uuid NOT NULL REFERENCES employees(id),
  plant_id uuid NOT NULL REFERENCES plants(id),
  work_date date NOT NULL,
  duration_seconds bigint NOT NULL CHECK (duration_seconds > 0),
  reason text NOT NULL CHECK (length(trim(reason)) >= 3),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  voided_at timestamptz,
  voided_by uuid REFERENCES users(id),
  void_reason text,
  FOREIGN KEY (employee_id, organization_id) REFERENCES employees(id, organization_id),
  FOREIGN KEY (plant_id, organization_id) REFERENCES plants(id, organization_id),
  FOREIGN KEY (created_by, organization_id) REFERENCES users(id, organization_id),
  FOREIGN KEY (voided_by, organization_id) REFERENCES users(id, organization_id),
  CHECK (
    (voided_at IS NULL AND voided_by IS NULL AND void_reason IS NULL)
    OR
    (voided_at IS NOT NULL AND voided_by IS NOT NULL AND length(trim(void_reason)) >= 3)
  )
);
CREATE INDEX manual_time_entries_employee_week_idx
  ON manual_time_entries (organization_id, employee_id, work_date);
CREATE INDEX manual_time_entries_plant_week_idx
  ON manual_time_entries (organization_id, plant_id, work_date);

CREATE OR REPLACE FUNCTION manual_time_immutable_guard() RETURNS trigger AS $$
BEGIN
  IF (NEW.organization_id, NEW.employee_id, NEW.plant_id, NEW.work_date,
      NEW.duration_seconds, NEW.reason, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM
     (OLD.organization_id, OLD.employee_id, OLD.plant_id, OLD.work_date,
      OLD.duration_seconds, OLD.reason, OLD.created_by, OLD.created_at)
  THEN
    RAISE EXCEPTION 'manual_time_entries is immutable: void and replace it';
  END IF;
  IF OLD.voided_at IS NOT NULL AND
     (NEW.voided_at, NEW.voided_by, NEW.void_reason) IS DISTINCT FROM
     (OLD.voided_at, OLD.voided_by, OLD.void_reason)
  THEN
    RAISE EXCEPTION 'a voided manual time entry is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER manual_time_no_meaning_update
  BEFORE UPDATE ON manual_time_entries
  FOR EACH ROW EXECUTE FUNCTION manual_time_immutable_guard();

CREATE OR REPLACE FUNCTION manual_time_no_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'manual_time_entries is immutable: DELETE is forbidden';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER manual_time_no_delete_trigger
  BEFORE DELETE ON manual_time_entries
  FOR EACH ROW EXECUTE FUNCTION manual_time_no_delete();

-- The customer selected one locked policy. There is deliberately no editable
-- threshold column; changing policy requires a reviewed migration/version.
ALTER TABLE organizations ADD COLUMN overtime_policy text NOT NULL DEFAULT 'CA_STANDARD_8_40'
  CHECK (overtime_policy = 'CA_STANDARD_8_40');

-- Down Migration
ALTER TABLE organizations DROP COLUMN overtime_policy;
DROP TRIGGER IF EXISTS manual_time_no_delete_trigger ON manual_time_entries;
DROP TRIGGER IF EXISTS manual_time_no_meaning_update ON manual_time_entries;
DROP FUNCTION IF EXISTS manual_time_no_delete();
DROP FUNCTION IF EXISTS manual_time_immutable_guard();
DROP TABLE IF EXISTS manual_time_entries;
