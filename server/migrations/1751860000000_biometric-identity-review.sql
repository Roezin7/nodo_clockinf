-- Up Migration

-- Biometric enrollment photos are versioned evidence.  Rows never change: the
-- employee points at the current version while prior versions remain auditable.
CREATE TABLE biometric_enrollments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  employee_id uuid NOT NULL REFERENCES employees(id),
  version integer NOT NULL CHECK (version > 0),
  photo_key text NOT NULL,
  photo_sha256 char(64),
  content_type text NOT NULL,
  byte_size integer CHECK (byte_size IS NULL OR byte_size > 0),
  provider text NOT NULL CHECK (provider IN ('review_only', 'fake', 'aws_rekognition')),
  provider_reference_ciphertext bytea,
  provider_reference_iv bytea,
  provider_reference_auth_tag bytea,
  integrity_status text NOT NULL DEFAULT 'verified'
    CHECK (integrity_status IN ('verified', 'legacy_unverified')),
  status text NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'error')),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (employee_id, version),
  UNIQUE (id, organization_id),
  UNIQUE (id, organization_id, employee_id),
  FOREIGN KEY (employee_id, organization_id) REFERENCES employees(id, organization_id),
  FOREIGN KEY (created_by, organization_id) REFERENCES users(id, organization_id),
  CHECK (
    (provider_reference_ciphertext IS NULL AND provider_reference_iv IS NULL
      AND provider_reference_auth_tag IS NULL)
    OR
    (provider_reference_ciphertext IS NOT NULL AND provider_reference_iv IS NOT NULL
      AND provider_reference_auth_tag IS NOT NULL)
  ),
  CHECK (
    (integrity_status = 'verified' AND photo_sha256 IS NOT NULL AND byte_size IS NOT NULL)
    OR
    (integrity_status = 'legacy_unverified' AND photo_sha256 IS NULL AND byte_size IS NULL)
  )
);
CREATE INDEX biometric_enrollments_employee_idx
  ON biometric_enrollments (organization_id, employee_id, version DESC);

CREATE OR REPLACE FUNCTION append_only_biometric_evidence() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER biometric_enrollments_no_update
  BEFORE UPDATE ON biometric_enrollments
  FOR EACH ROW EXECUTE FUNCTION append_only_biometric_evidence();
CREATE TRIGGER biometric_enrollments_no_delete
  BEFORE DELETE ON biometric_enrollments
  FOR EACH ROW EXECUTE FUNCTION append_only_biometric_evidence();

ALTER TABLE employees ADD COLUMN current_biometric_enrollment_id uuid;
ALTER TABLE employees ADD CONSTRAINT employees_current_biometric_enrollment_fk
  FOREIGN KEY (current_biometric_enrollment_id, organization_id, id)
  REFERENCES biometric_enrollments(id, organization_id, employee_id);

-- Existing enrollment files cannot be re-hashed inside PostgreSQL because the
-- bytes live in object storage.  Preserve them honestly as legacy_unverified;
-- the next upload creates a fully hashed version.
INSERT INTO biometric_enrollments
  (organization_id, employee_id, version, photo_key, content_type, provider,
   integrity_status, status, created_at)
SELECT organization_id, id, 1, enrollment_photo_key, 'image/jpeg', 'review_only',
       'legacy_unverified', 'ready', created_at
FROM employees
WHERE enrollment_photo_key IS NOT NULL;
UPDATE employees e
SET current_biometric_enrollment_id = b.id
FROM biometric_enrollments b
WHERE b.employee_id = e.id AND b.organization_id = e.organization_id AND b.version = 1;

-- One identity session is permanently bound to one device event and employee.
-- server_started_at is the authoritative online punch time, so three attempts
-- never make an employee lose payable minutes.
CREATE TABLE identity_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  plant_id uuid NOT NULL REFERENCES plants(id),
  device_id uuid NOT NULL REFERENCES devices(id),
  employee_id uuid NOT NULL REFERENCES employees(id),
  enrollment_id uuid,
  client_event_id uuid NOT NULL,
  client_installation_id uuid NOT NULL,
  client_sequence bigint NOT NULL CHECK (client_sequence > 0),
  punch_type text NOT NULL
    CHECK (punch_type IN ('shift_in', 'shift_out', 'meal_out', 'meal_in')),
  captured_at timestamptz NOT NULL,
  payload_hash char(64) NOT NULL,
  mode text NOT NULL CHECK (mode IN ('review_only', 'managed', 'offline_fallback')),
  provider text NOT NULL CHECK (provider IN ('review_only', 'fake', 'aws_rekognition')),
  provider_liveness_capable boolean NOT NULL DEFAULT false,
  liveness_status text NOT NULL DEFAULT 'not_performed'
    CHECK (liveness_status IN ('not_performed', 'passed', 'failed', 'unknown')),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'verified', 'review_required')),
  review_reason text,
  similarity numeric(6,3),
  server_started_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (device_id, client_event_id),
  UNIQUE (device_id, client_installation_id, client_sequence),
  UNIQUE (id, device_id, employee_id),
  UNIQUE (id, organization_id),
  UNIQUE (id, organization_id, plant_id, employee_id),
  UNIQUE (id, organization_id, plant_id, device_id, employee_id),
  FOREIGN KEY (device_id, organization_id, plant_id)
    REFERENCES devices(id, organization_id, plant_id),
  FOREIGN KEY (employee_id, organization_id)
    REFERENCES employees(id, organization_id),
  FOREIGN KEY (enrollment_id, organization_id, employee_id)
    REFERENCES biometric_enrollments(id, organization_id, employee_id),
  CHECK (
    (status = 'pending' AND resolved_at IS NULL)
    OR (status IN ('verified', 'review_required') AND resolved_at IS NOT NULL)
  ),
  CHECK (
    status <> 'verified'
    OR (mode = 'managed' AND provider_liveness_capable
        AND liveness_status = 'passed')
  )
);
CREATE INDEX identity_sessions_review_idx
  ON identity_sessions (organization_id, plant_id, server_started_at DESC)
  WHERE status = 'review_required';
CREATE INDEX identity_sessions_employee_idx
  ON identity_sessions (organization_id, employee_id, server_started_at DESC);

CREATE OR REPLACE FUNCTION identity_sessions_meaning_guard() RETURNS trigger AS $$
BEGIN
  IF (NEW.organization_id, NEW.plant_id, NEW.device_id, NEW.employee_id,
      NEW.enrollment_id, NEW.client_event_id, NEW.client_installation_id,
      NEW.client_sequence, NEW.punch_type, NEW.captured_at, NEW.payload_hash,
      NEW.mode, NEW.provider, NEW.provider_liveness_capable,
      NEW.server_started_at, NEW.created_at)
     IS DISTINCT FROM
     (OLD.organization_id, OLD.plant_id, OLD.device_id, OLD.employee_id,
      OLD.enrollment_id, OLD.client_event_id, OLD.client_installation_id,
      OLD.client_sequence, OLD.punch_type, OLD.captured_at, OLD.payload_hash,
      OLD.mode, OLD.provider, OLD.provider_liveness_capable,
      OLD.server_started_at, OLD.created_at)
  THEN
    RAISE EXCEPTION 'identity session binding is immutable';
  END IF;
  IF OLD.status <> 'pending' AND
     (NEW.status, NEW.review_reason, NEW.liveness_status, NEW.similarity, NEW.resolved_at)
       IS DISTINCT FROM
     (OLD.status, OLD.review_reason, OLD.liveness_status, OLD.similarity, OLD.resolved_at)
  THEN
    RAISE EXCEPTION 'resolved identity session is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER identity_sessions_no_meaning_update
  BEFORE UPDATE ON identity_sessions
  FOR EACH ROW EXECUTE FUNCTION identity_sessions_meaning_guard();
CREATE TRIGGER identity_sessions_no_delete
  BEFORE DELETE ON identity_sessions
  FOR EACH ROW EXECUTE FUNCTION append_only_biometric_evidence();

CREATE TABLE identity_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  session_id uuid NOT NULL REFERENCES identity_sessions(id),
  plant_id uuid NOT NULL REFERENCES plants(id),
  device_id uuid NOT NULL REFERENCES devices(id),
  employee_id uuid NOT NULL REFERENCES employees(id),
  client_attempt_id uuid NOT NULL,
  attempt_number integer,
  consumes_attempt boolean NOT NULL,
  result text NOT NULL CHECK (result IN (
    'match', 'no_match', 'no_face', 'multiple_faces', 'liveness_failed',
    'quality_failed', 'provider_error', 'provider_unavailable', 'no_enrollment',
    'review_only'
  )),
  provider text NOT NULL CHECK (provider IN ('review_only', 'fake', 'aws_rekognition')),
  liveness_status text NOT NULL DEFAULT 'not_performed'
    CHECK (liveness_status IN ('not_performed', 'passed', 'failed', 'unknown')),
  similarity numeric(6,3),
  evidence_key text NOT NULL,
  evidence_sha256 char(64) NOT NULL,
  evidence_content_type text NOT NULL,
  evidence_byte_size integer NOT NULL CHECK (evidence_byte_size > 0),
  captured_at timestamptz NOT NULL,
  provider_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, client_attempt_id),
  UNIQUE (session_id, attempt_number),
  UNIQUE (id, organization_id),
  FOREIGN KEY (session_id, organization_id, plant_id, device_id, employee_id)
    REFERENCES identity_sessions(id, organization_id, plant_id, device_id, employee_id),
  FOREIGN KEY (employee_id, organization_id)
    REFERENCES employees(id, organization_id),
  CHECK (
    (consumes_attempt AND attempt_number BETWEEN 1 AND 3)
    OR (NOT consumes_attempt AND attempt_number IS NULL)
  ),
  CHECK (consumes_attempt = (result IN (
    'no_match', 'no_face', 'multiple_faces', 'quality_failed', 'liveness_failed'
  )))
);
CREATE INDEX identity_attempts_session_idx ON identity_attempts (session_id, created_at);
CREATE TRIGGER identity_attempts_no_update
  BEFORE UPDATE ON identity_attempts
  FOR EACH ROW EXECUTE FUNCTION append_only_biometric_evidence();
CREATE TRIGGER identity_attempts_no_delete
  BEFORE DELETE ON identity_attempts
  FOR EACH ROW EXECUTE FUNCTION append_only_biometric_evidence();

ALTER TABLE punches
  ADD COLUMN identity_session_id uuid,
  ADD COLUMN identity_bypass_reason text
    CHECK (identity_bypass_reason IN (
      'camera_unavailable', 'provider_unavailable', 'offline', 'incomplete_session',
      'legacy_pin'
    ));
ALTER TABLE punches ADD CONSTRAINT punches_identity_session_fk
  FOREIGN KEY (identity_session_id, organization_id, plant_id, device_id, employee_id)
  REFERENCES identity_sessions(id, organization_id, plant_id, device_id, employee_id);
CREATE UNIQUE INDEX punches_identity_session_unique
  ON punches (identity_session_id) WHERE identity_session_id IS NOT NULL;
ALTER TABLE punches ADD CONSTRAINT punches_id_org_plant_employee_unique
  UNIQUE (id, organization_id, plant_id, employee_id);
ALTER TABLE punches ADD CONSTRAINT punches_id_identity_session_unique
  UNIQUE (id, identity_session_id);

ALTER TABLE device_event_receipts
  ADD COLUMN identity_session_id uuid,
  ADD COLUMN submitted_identity_session_id uuid,
  ADD COLUMN identity_bypass_reason text
    CHECK (identity_bypass_reason IN (
      'camera_unavailable', 'provider_unavailable', 'offline', 'incomplete_session',
      'legacy_pin'
    )),
  ADD COLUMN submitted_identity_bypass_reason text
    CHECK (submitted_identity_bypass_reason IN (
      'camera_unavailable', 'provider_unavailable', 'offline', 'incomplete_session',
      'legacy_pin'
    ));
ALTER TABLE device_event_receipts ADD CONSTRAINT receipts_identity_session_fk
  FOREIGN KEY (identity_session_id, organization_id, plant_id, device_id, employee_id)
  REFERENCES identity_sessions(id, organization_id, plant_id, device_id, employee_id);
ALTER TABLE device_event_receipts ADD CONSTRAINT receipts_punch_identity_session_fk
  FOREIGN KEY (punch_id, identity_session_id)
  REFERENCES punches(id, identity_session_id);

-- Two separately photographed events inside the semantic de-duplication window
-- may map to one payable punch. Preserve the second session and all of its
-- attempts as an explicit alias instead of orphaning or overwriting evidence.
CREATE TABLE identity_session_punch_aliases (
  alias_session_id uuid PRIMARY KEY,
  canonical_punch_id uuid NOT NULL,
  canonical_session_id uuid NOT NULL,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  plant_id uuid NOT NULL REFERENCES plants(id),
  device_id uuid NOT NULL REFERENCES devices(id),
  employee_id uuid NOT NULL REFERENCES employees(id),
  reason text NOT NULL DEFAULT 'semantic_duplicate'
    CHECK (reason = 'semantic_duplicate'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (alias_session_id, organization_id, plant_id, device_id, employee_id)
    REFERENCES identity_sessions(id, organization_id, plant_id, device_id, employee_id),
  FOREIGN KEY (canonical_session_id, organization_id, plant_id, device_id, employee_id)
    REFERENCES identity_sessions(id, organization_id, plant_id, device_id, employee_id),
  FOREIGN KEY (canonical_punch_id, canonical_session_id)
    REFERENCES punches(id, identity_session_id),
  CHECK (alias_session_id <> canonical_session_id)
);
CREATE INDEX identity_session_aliases_punch_idx
  ON identity_session_punch_aliases (canonical_punch_id, created_at);
CREATE TRIGGER identity_session_aliases_no_update
  BEFORE UPDATE ON identity_session_punch_aliases
  FOR EACH ROW EXECUTE FUNCTION append_only_biometric_evidence();
CREATE TRIGGER identity_session_aliases_no_delete
  BEFORE DELETE ON identity_session_punch_aliases
  FOR EACH ROW EXECUTE FUNCTION append_only_biometric_evidence();

CREATE TABLE identity_review_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  plant_id uuid NOT NULL REFERENCES plants(id),
  session_id uuid NOT NULL,
  punch_id uuid NOT NULL,
  employee_id uuid NOT NULL REFERENCES employees(id),
  decision text NOT NULL CHECK (decision IN ('approve', 'reject')),
  reason text NOT NULL CHECK (length(trim(reason)) >= 3),
  decided_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (employee_id, organization_id) REFERENCES employees(id, organization_id),
  FOREIGN KEY (decided_by, organization_id) REFERENCES users(id, organization_id),
  FOREIGN KEY (session_id, organization_id, plant_id, employee_id)
    REFERENCES identity_sessions(id, organization_id, plant_id, employee_id),
  FOREIGN KEY (punch_id, organization_id, plant_id, employee_id)
    REFERENCES punches(id, organization_id, plant_id, employee_id),
  FOREIGN KEY (punch_id, session_id)
    REFERENCES punches(id, identity_session_id),
  UNIQUE (session_id, punch_id)
);
CREATE INDEX identity_review_decisions_session_idx
  ON identity_review_decisions (session_id, created_at DESC);
CREATE TRIGGER identity_review_decisions_no_update
  BEFORE UPDATE ON identity_review_decisions
  FOR EACH ROW EXECUTE FUNCTION append_only_biometric_evidence();
CREATE TRIGGER identity_review_decisions_no_delete
  BEFORE DELETE ON identity_review_decisions
  FOR EACH ROW EXECUTE FUNCTION append_only_biometric_evidence();

-- Object deletion is also append-only evidence. Attempt rows and their hashes
-- remain; only the expired object bytes are removed by policy.
CREATE TABLE identity_evidence_purges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  attempt_id uuid NOT NULL,
  evidence_key text NOT NULL,
  evidence_sha256 char(64) NOT NULL,
  reason text NOT NULL CHECK (length(trim(reason)) >= 3),
  purged_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (attempt_id),
  FOREIGN KEY (attempt_id, organization_id)
    REFERENCES identity_attempts(id, organization_id)
);
CREATE INDEX identity_evidence_purges_org_time_idx
  ON identity_evidence_purges (organization_id, purged_at DESC);
CREATE TRIGGER identity_evidence_purges_no_update
  BEFORE UPDATE ON identity_evidence_purges
  FOR EACH ROW EXECUTE FUNCTION append_only_biometric_evidence();
CREATE TRIGGER identity_evidence_purges_no_delete
  BEFORE DELETE ON identity_evidence_purges
  FOR EACH ROW EXECUTE FUNCTION append_only_biometric_evidence();

-- identity_session_id and bypass reason explain the identity projection and are
-- therefore part of the immutable punch evidence. identity_status itself may
-- only be projected by a later append-only review decision.
CREATE OR REPLACE FUNCTION punches_immutable_guard() RETURNS trigger AS $$
BEGIN
  IF (NEW.organization_id, NEW.employee_id, NEW.punch_type, NEW.punched_at,
      NEW.captured_at, NEW.received_at, NEW.plant_id, NEW.device_id,
      NEW.client_event_id, NEW.client_installation_id, NEW.client_sequence,
      NEW.client_clock_skew_seconds, NEW.identity_session_id,
      NEW.identity_bypass_reason,
      NEW.evidence_status, NEW.offline, NEW.area_id, NEW.source,
      NEW.created_by, NEW.correction_of, NEW.correction_reason, NEW.created_at)
     IS DISTINCT FROM
     (OLD.organization_id, OLD.employee_id, OLD.punch_type, OLD.punched_at,
      OLD.captured_at, OLD.received_at, OLD.plant_id, OLD.device_id,
      OLD.client_event_id, OLD.client_installation_id, OLD.client_sequence,
      OLD.client_clock_skew_seconds, OLD.identity_session_id,
      OLD.identity_bypass_reason,
      OLD.evidence_status, OLD.offline, OLD.area_id, OLD.source,
      OLD.created_by, OLD.correction_of, OLD.correction_reason, OLD.created_at)
  THEN
    RAISE EXCEPTION 'punches is immutable: create an audited correction instead';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Down Migration

CREATE OR REPLACE FUNCTION punches_immutable_guard() RETURNS trigger AS $$
BEGIN
  IF (NEW.organization_id, NEW.employee_id, NEW.punch_type, NEW.punched_at,
      NEW.captured_at, NEW.received_at, NEW.plant_id, NEW.device_id,
      NEW.client_event_id, NEW.client_installation_id, NEW.client_sequence,
      NEW.client_clock_skew_seconds,
      NEW.evidence_status, NEW.offline, NEW.area_id, NEW.source,
      NEW.created_by, NEW.correction_of, NEW.correction_reason, NEW.created_at)
     IS DISTINCT FROM
     (OLD.organization_id, OLD.employee_id, OLD.punch_type, OLD.punched_at,
      OLD.captured_at, OLD.received_at, OLD.plant_id, OLD.device_id,
      OLD.client_event_id, OLD.client_installation_id, OLD.client_sequence,
      OLD.client_clock_skew_seconds,
      OLD.evidence_status, OLD.offline, OLD.area_id, OLD.source,
      OLD.created_by, OLD.correction_of, OLD.correction_reason, OLD.created_at)
  THEN
    RAISE EXCEPTION 'punches is immutable: create an audited correction instead';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS identity_review_decisions_no_delete ON identity_review_decisions;
DROP TRIGGER IF EXISTS identity_review_decisions_no_update ON identity_review_decisions;
DROP TRIGGER IF EXISTS identity_evidence_purges_no_delete ON identity_evidence_purges;
DROP TRIGGER IF EXISTS identity_evidence_purges_no_update ON identity_evidence_purges;
DROP TABLE IF EXISTS identity_evidence_purges;
DROP TABLE IF EXISTS identity_review_decisions;

DROP TRIGGER IF EXISTS identity_session_aliases_no_delete ON identity_session_punch_aliases;
DROP TRIGGER IF EXISTS identity_session_aliases_no_update ON identity_session_punch_aliases;
DROP TABLE IF EXISTS identity_session_punch_aliases;

ALTER TABLE device_event_receipts
  DROP CONSTRAINT receipts_punch_identity_session_fk,
  DROP CONSTRAINT receipts_identity_session_fk,
  DROP COLUMN submitted_identity_bypass_reason,
  DROP COLUMN identity_bypass_reason,
  DROP COLUMN submitted_identity_session_id,
  DROP COLUMN identity_session_id;

DROP INDEX IF EXISTS punches_identity_session_unique;
ALTER TABLE punches DROP CONSTRAINT punches_identity_session_fk;
ALTER TABLE punches DROP CONSTRAINT punches_id_identity_session_unique;
ALTER TABLE punches DROP CONSTRAINT punches_id_org_plant_employee_unique;
ALTER TABLE punches
  DROP COLUMN identity_bypass_reason,
  DROP COLUMN identity_session_id;

DROP TRIGGER IF EXISTS identity_attempts_no_delete ON identity_attempts;
DROP TRIGGER IF EXISTS identity_attempts_no_update ON identity_attempts;
DROP TABLE IF EXISTS identity_attempts;
DROP TRIGGER IF EXISTS identity_sessions_no_delete ON identity_sessions;
DROP TRIGGER IF EXISTS identity_sessions_no_meaning_update ON identity_sessions;
DROP FUNCTION IF EXISTS identity_sessions_meaning_guard();
DROP TABLE IF EXISTS identity_sessions;

ALTER TABLE employees DROP CONSTRAINT employees_current_biometric_enrollment_fk;
ALTER TABLE employees DROP COLUMN current_biometric_enrollment_id;
DROP TRIGGER IF EXISTS biometric_enrollments_no_delete ON biometric_enrollments;
DROP TRIGGER IF EXISTS biometric_enrollments_no_update ON biometric_enrollments;
DROP TABLE IF EXISTS biometric_enrollments;
DROP FUNCTION IF EXISTS append_only_biometric_evidence();
