-- Up Migration

-- Rates remain exact decimals in PostgreSQL. The explicit named bound gives
-- API and dashboard code a stable invariant in addition to numeric(12,4).
ALTER TABLE employee_rates
  ADD COLUMN reason text,
  ADD CONSTRAINT employee_rates_hourly_rate_upper_bound
    CHECK (hourly_rate <= 99999999.9999),
  ADD CONSTRAINT employee_rates_reason_valid
    CHECK (reason IS NULL OR length(trim(reason)) BETWEEN 3 AND 2000),
  ADD CONSTRAINT employee_rates_created_by_org_fk
    FOREIGN KEY (created_by, organization_id) REFERENCES users(id, organization_id);

-- Audit facts are append-only. Corrections must be represented by a new event,
-- never by rewriting the actor, reason or before/after values of an old event.
CREATE OR REPLACE FUNCTION audit_events_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_events_no_update
  BEFORE UPDATE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_immutable();
CREATE TRIGGER audit_events_no_delete
  BEFORE DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_immutable();

-- Admin-only direct-cost snapshots are derived alongside an exact report
-- version. Legacy report versions intentionally are not backfilled.
CREATE TABLE report_cost_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  report_version_id uuid NOT NULL,
  schema_version smallint NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  contract text NOT NULL DEFAULT 'clockai-admin-direct-cost-v1'
    CHECK (contract = 'clockai-admin-direct-cost-v1'),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  snapshot_hash char(64) NOT NULL
    CHECK (snapshot_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (report_version_id),
  FOREIGN KEY (report_version_id, organization_id)
    REFERENCES report_versions(id, organization_id)
);
CREATE INDEX report_cost_snapshots_org_created_idx
  ON report_cost_snapshots (organization_id, created_at DESC);

CREATE OR REPLACE FUNCTION report_cost_snapshots_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'report_cost_snapshots is immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER report_cost_snapshots_no_update
  BEFORE UPDATE ON report_cost_snapshots
  FOR EACH ROW EXECUTE FUNCTION report_cost_snapshots_immutable();
CREATE TRIGGER report_cost_snapshots_no_delete
  BEFORE DELETE ON report_cost_snapshots
  FOR EACH ROW EXECUTE FUNCTION report_cost_snapshots_immutable();

-- Down Migration

DROP TRIGGER IF EXISTS report_cost_snapshots_no_delete ON report_cost_snapshots;
DROP TRIGGER IF EXISTS report_cost_snapshots_no_update ON report_cost_snapshots;
DROP FUNCTION IF EXISTS report_cost_snapshots_immutable();
DROP TABLE IF EXISTS report_cost_snapshots;

DROP TRIGGER IF EXISTS audit_events_no_delete ON audit_events;
DROP TRIGGER IF EXISTS audit_events_no_update ON audit_events;
DROP FUNCTION IF EXISTS audit_events_immutable();

ALTER TABLE employee_rates
  DROP CONSTRAINT IF EXISTS employee_rates_created_by_org_fk,
  DROP CONSTRAINT IF EXISTS employee_rates_reason_valid,
  DROP CONSTRAINT IF EXISTS employee_rates_hourly_rate_upper_bound,
  DROP COLUMN IF EXISTS reason;
