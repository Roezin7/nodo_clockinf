-- Up Migration

-- A report version states its exact read contract and hash algorithm. Legacy
-- rows are classified without rewriting their immutable JSON payload.
ALTER TABLE report_versions
  ADD COLUMN snapshot_schema_version smallint,
  ADD COLUMN snapshot_contract text,
  ADD COLUMN hash_algorithm text;

ALTER TABLE report_versions DISABLE TRIGGER report_versions_no_update;
UPDATE report_versions
SET snapshot_schema_version = CASE
      WHEN snapshot ->> 'schema_version' = '2'
       AND snapshot ->> 'contract' = 'clockai-accountant-v1'
      THEN 2 ELSE 1
    END,
    snapshot_contract = CASE
      WHEN snapshot ->> 'schema_version' = '2'
       AND snapshot ->> 'contract' = 'clockai-accountant-v1'
      THEN 'clockai-accountant-v1' ELSE 'legacy-week-computation-v1'
    END,
    hash_algorithm = CASE
      WHEN snapshot_hash ~ '^[0-9a-f]{32}$' THEN 'md5'
      ELSE 'sha256'
    END;
ALTER TABLE report_versions ENABLE TRIGGER report_versions_no_update;

ALTER TABLE report_versions
  ALTER COLUMN snapshot_schema_version SET DEFAULT 2,
  ALTER COLUMN snapshot_schema_version SET NOT NULL,
  ALTER COLUMN snapshot_contract SET DEFAULT 'clockai-accountant-v1',
  ALTER COLUMN snapshot_contract SET NOT NULL,
  ALTER COLUMN hash_algorithm SET DEFAULT 'sha256',
  ALTER COLUMN hash_algorithm SET NOT NULL,
  ADD CONSTRAINT report_versions_schema_version_positive
    CHECK (snapshot_schema_version > 0),
  ADD CONSTRAINT report_versions_hash_algorithm_known
    CHECK (hash_algorithm IN ('md5', 'sha256')),
  ADD CONSTRAINT report_versions_hash_matches_algorithm
    CHECK (
      (hash_algorithm = 'md5' AND snapshot_hash ~ '^[0-9a-f]{32}$')
      OR (hash_algorithm = 'sha256' AND snapshot_hash ~ '^[0-9a-f]{64}$')
    ),
  ADD CONSTRAINT report_versions_schema_contract_known
    CHECK (
      (snapshot_schema_version = 1 AND snapshot_contract = 'legacy-week-computation-v1')
      OR (snapshot_schema_version = 2 AND snapshot_contract = 'clockai-accountant-v1')
    ),
  ADD CONSTRAINT report_versions_id_org_unique UNIQUE (id, organization_id);

-- The exact bytes delivered to accounting are created once at finalization.
-- Regeneration cannot silently change a workbook or its digest later.
CREATE TABLE report_export_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  report_version_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('xlsx', 'csv_summary', 'csv_detail')),
  template_version text NOT NULL CHECK (length(trim(template_version)) > 0),
  content bytea NOT NULL CHECK (octet_length(content) > 0),
  content_sha256 char(64) NOT NULL
    CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  byte_length integer NOT NULL CHECK (
    byte_length > 0 AND byte_length = octet_length(content)
  ),
  content_type text NOT NULL CHECK (length(trim(content_type)) > 0),
  filename text NOT NULL CHECK (
    length(trim(filename)) > 0
    AND filename !~ '[\\/\r\n"]'
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (report_version_id, kind),
  FOREIGN KEY (report_version_id, organization_id)
    REFERENCES report_versions(id, organization_id)
);
CREATE INDEX report_export_artifacts_org_version_idx
  ON report_export_artifacts (organization_id, report_version_id, kind);

CREATE OR REPLACE FUNCTION report_export_artifacts_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'report_export_artifacts is immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER report_export_artifacts_no_update
  BEFORE UPDATE ON report_export_artifacts
  FOR EACH ROW EXECUTE FUNCTION report_export_artifacts_immutable();
CREATE TRIGGER report_export_artifacts_no_delete
  BEFORE DELETE ON report_export_artifacts
  FOR EACH ROW EXECUTE FUNCTION report_export_artifacts_immutable();

-- Ready-for-review freezes ordinary corrections before the final snapshot.
ALTER TABLE pay_periods DROP CONSTRAINT pay_periods_status_check;
ALTER TABLE pay_periods
  ADD CONSTRAINT pay_periods_status_check
  CHECK (status IN ('open', 'ready_for_review', 'final', 'reopened'));

-- Down Migration

ALTER TABLE pay_periods DROP CONSTRAINT IF EXISTS pay_periods_status_check;
UPDATE pay_periods
SET status = CASE WHEN current_version > 0 THEN 'reopened' ELSE 'open' END,
    reopened_at = CASE
      WHEN current_version > 0 THEN COALESCE(reopened_at, now())
      ELSE reopened_at
    END,
    reopened_by = CASE
      WHEN current_version > 0 THEN COALESCE(reopened_by, finalized_by)
      ELSE reopened_by
    END,
    reopen_reason = CASE
      WHEN current_version > 0 THEN COALESCE(reopen_reason, 'Rollback from ready for review')
      ELSE reopen_reason
    END
WHERE status = 'ready_for_review';
ALTER TABLE pay_periods
  ADD CONSTRAINT pay_periods_status_check
  CHECK (status IN ('open', 'final', 'reopened'));

DROP TRIGGER IF EXISTS report_export_artifacts_no_delete ON report_export_artifacts;
DROP TRIGGER IF EXISTS report_export_artifacts_no_update ON report_export_artifacts;
DROP FUNCTION IF EXISTS report_export_artifacts_immutable();
DROP TABLE IF EXISTS report_export_artifacts;

ALTER TABLE report_versions
  DROP CONSTRAINT IF EXISTS report_versions_id_org_unique,
  DROP CONSTRAINT IF EXISTS report_versions_schema_contract_known,
  DROP CONSTRAINT IF EXISTS report_versions_hash_matches_algorithm,
  DROP CONSTRAINT IF EXISTS report_versions_hash_algorithm_known,
  DROP CONSTRAINT IF EXISTS report_versions_schema_version_positive,
  DROP COLUMN IF EXISTS hash_algorithm,
  DROP COLUMN IF EXISTS snapshot_contract,
  DROP COLUMN IF EXISTS snapshot_schema_version;
