-- Up Migration

CREATE TABLE pay_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  week_start date NOT NULL,
  week_end date NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'final', 'reopened')),
  current_version integer NOT NULL DEFAULT 0 CHECK (current_version >= 0),
  finalized_at timestamptz,
  finalized_by uuid REFERENCES users(id),
  reopened_at timestamptz,
  reopened_by uuid REFERENCES users(id),
  reopen_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, week_start),
  UNIQUE (id, organization_id),
  CHECK (week_end = week_start + 6),
  CHECK (
    (status <> 'final') OR
    (current_version > 0 AND finalized_at IS NOT NULL AND finalized_by IS NOT NULL)
  ),
  CHECK (
    (status <> 'reopened') OR
    (reopened_at IS NOT NULL AND reopened_by IS NOT NULL AND length(trim(reopen_reason)) >= 3)
  ),
  FOREIGN KEY (finalized_by, organization_id) REFERENCES users(id, organization_id),
  FOREIGN KEY (reopened_by, organization_id) REFERENCES users(id, organization_id)
);
CREATE INDEX pay_periods_org_status_idx ON pay_periods (organization_id, status, week_start DESC);

CREATE TABLE report_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  pay_period_id uuid NOT NULL REFERENCES pay_periods(id),
  version integer NOT NULL CHECK (version > 0),
  snapshot jsonb NOT NULL,
  snapshot_hash text NOT NULL,
  finalized_by uuid NOT NULL REFERENCES users(id),
  finalized_at timestamptz NOT NULL DEFAULT now(),
  finalization_reason text,
  UNIQUE (pay_period_id, version),
  FOREIGN KEY (pay_period_id, organization_id) REFERENCES pay_periods(id, organization_id),
  FOREIGN KEY (finalized_by, organization_id) REFERENCES users(id, organization_id)
);
CREATE INDEX report_versions_org_period_idx
  ON report_versions (organization_id, pay_period_id, version DESC);

CREATE OR REPLACE FUNCTION report_versions_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'report_versions is immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER report_versions_no_update
  BEFORE UPDATE ON report_versions
  FOR EACH ROW EXECUTE FUNCTION report_versions_immutable();
CREATE TRIGGER report_versions_no_delete
  BEFORE DELETE ON report_versions
  FOR EACH ROW EXECUTE FUNCTION report_versions_immutable();

-- Preserve every existing final weekly snapshot as version 1.
INSERT INTO pay_periods
  (organization_id, week_start, week_end, status, current_version,
   finalized_at, finalized_by, created_at, updated_at)
SELECT organization_id, week_start, week_end, 'final', 1,
       generated_at, generated_by, generated_at, generated_at
FROM weekly_reports
WHERE status = 'final'
ON CONFLICT (organization_id, week_start) DO NOTHING;

INSERT INTO report_versions
  (organization_id, pay_period_id, version, snapshot, snapshot_hash,
   finalized_by, finalized_at, finalization_reason)
SELECT w.organization_id, p.id, 1, w.data, md5(w.data::text),
       w.generated_by, w.generated_at, 'Migrated from legacy weekly report'
FROM weekly_reports w
JOIN pay_periods p
  ON p.organization_id = w.organization_id AND p.week_start = w.week_start
WHERE w.status = 'final'
ON CONFLICT (pay_period_id, version) DO NOTHING;

-- Down Migration
DROP TRIGGER IF EXISTS report_versions_no_delete ON report_versions;
DROP TRIGGER IF EXISTS report_versions_no_update ON report_versions;
DROP FUNCTION IF EXISTS report_versions_immutable();
DROP TABLE IF EXISTS report_versions;
DROP TABLE IF EXISTS pay_periods;
