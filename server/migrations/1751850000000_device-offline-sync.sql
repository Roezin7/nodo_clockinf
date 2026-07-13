-- Up Migration

-- Device health is intentionally small and operational: the admin needs to
-- know whether the kiosk is alive, whether its durable queue is draining, and
-- whether camera/local storage require attention. No biometric template or PIN
-- is persisted here.
ALTER TABLE devices
  ADD COLUMN enrolled_at timestamptz,
  ADD COLUMN last_heartbeat_at timestamptz,
  ADD COLUMN pending_event_count integer NOT NULL DEFAULT 0
    CHECK (pending_event_count >= 0),
  ADD COLUMN rejected_event_count integer NOT NULL DEFAULT 0
    CHECK (rejected_event_count >= 0),
  ADD COLUMN camera_status text NOT NULL DEFAULT 'unknown'
    CHECK (camera_status IN ('unknown', 'ready', 'degraded', 'unavailable')),
  ADD COLUMN storage_status text NOT NULL DEFAULT 'unknown'
    CHECK (storage_status IN ('unknown', 'ready', 'degraded', 'unavailable')),
  ADD COLUMN clock_skew_seconds integer,
  ADD COLUMN last_error text,
  ADD COLUMN last_ip inet;

-- Tokens issued before this migration were already permanent credentials.
UPDATE devices SET enrolled_at = created_at;

ALTER TABLE punches
  ADD COLUMN client_sequence bigint,
  ADD COLUMN client_installation_id uuid,
  ADD COLUMN client_clock_skew_seconds integer,
  ADD COLUMN evidence_status text NOT NULL DEFAULT 'pending'
    CHECK (evidence_status IN ('pending', 'captured', 'camera_unavailable'));
-- Legacy device rows predate durable client metadata. Backfill all three
-- identity fields deterministically before the completeness/unique guards.
ALTER TABLE punches DISABLE TRIGGER punches_no_update;
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY device_id ORDER BY captured_at, created_at, id
         ) AS sequence
  FROM punches
  WHERE device_id IS NOT NULL
)
UPDATE punches p
SET client_installation_id = p.device_id,
    client_event_id = COALESCE(p.client_event_id, gen_random_uuid()),
    client_sequence = ranked.sequence
FROM ranked
WHERE ranked.id = p.id;
ALTER TABLE punches ENABLE TRIGGER punches_no_update;

ALTER TABLE punches ADD CONSTRAINT punches_client_sequence_positive
  CHECK (client_sequence IS NULL OR client_sequence > 0);
ALTER TABLE punches ADD CONSTRAINT punches_device_event_complete
  CHECK (
    device_id IS NULL OR
    (client_event_id IS NOT NULL AND client_installation_id IS NOT NULL AND client_sequence IS NOT NULL)
  );
CREATE UNIQUE INDEX punches_device_sequence_idx
  ON punches (device_id, client_installation_id, client_sequence)
  WHERE device_id IS NOT NULL;
ALTER TABLE punches ADD CONSTRAINT punches_id_device_employee_unique
  UNIQUE (id, device_id, employee_id);

-- Every submitted UUID receives an immutable receipt, including a semantic
-- double-submit that maps to an already-created punch. This makes response-loss
-- retries permanent and consumes each client sequence exactly once.
CREATE TABLE device_event_receipts (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  plant_id uuid NOT NULL REFERENCES plants(id),
  device_id uuid NOT NULL REFERENCES devices(id),
  client_event_id uuid NOT NULL,
  client_installation_id uuid NOT NULL,
  client_sequence bigint NOT NULL CHECK (client_sequence > 0),
  client_clock_skew_seconds integer,
  punch_id uuid NOT NULL,
  employee_id uuid NOT NULL REFERENCES employees(id),
  punch_type text NOT NULL
    CHECK (punch_type IN ('shift_in', 'shift_out', 'meal_out', 'meal_in')),
  captured_at timestamptz NOT NULL,
  evidence_status text NOT NULL
    CHECK (evidence_status IN ('captured', 'camera_unavailable')),
  disposition text NOT NULL
    CHECK (disposition IN ('new_punch', 'semantic_duplicate')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, client_event_id),
  CONSTRAINT receipts_device_install_sequence_unique
    UNIQUE (device_id, client_installation_id, client_sequence),
  FOREIGN KEY (device_id, organization_id, plant_id)
    REFERENCES devices(id, organization_id, plant_id),
  FOREIGN KEY (punch_id, device_id, employee_id)
    REFERENCES punches(id, device_id, employee_id),
  FOREIGN KEY (employee_id, organization_id)
    REFERENCES employees(id, organization_id)
);
CREATE INDEX device_event_receipts_punch_idx ON device_event_receipts (punch_id);

INSERT INTO device_event_receipts
  (organization_id, plant_id, device_id, client_event_id, client_installation_id, client_sequence,
   client_clock_skew_seconds, punch_id, employee_id, punch_type, captured_at,
   evidence_status, disposition, created_at)
SELECT organization_id, plant_id, device_id, client_event_id, client_installation_id, client_sequence,
       client_clock_skew_seconds, id, employee_id, punch_type, captured_at,
       CASE WHEN evidence_status = 'pending' THEN 'captured' ELSE evidence_status END,
       'new_punch', created_at
FROM punches
WHERE device_id IS NOT NULL AND client_event_id IS NOT NULL AND client_sequence IS NOT NULL;

CREATE OR REPLACE FUNCTION device_event_receipts_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'device_event_receipts is immutable';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER device_event_receipts_no_update
  BEFORE UPDATE ON device_event_receipts
  FOR EACH ROW EXECUTE FUNCTION device_event_receipts_immutable();
CREATE TRIGGER device_event_receipts_no_delete
  BEFORE DELETE ON device_event_receipts
  FOR EACH ROW EXECUTE FUNCTION device_event_receipts_immutable();

-- client_sequence is part of the immutable evidence written by a kiosk.
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

-- Down Migration

DROP TRIGGER IF EXISTS device_event_receipts_no_delete ON device_event_receipts;
DROP TRIGGER IF EXISTS device_event_receipts_no_update ON device_event_receipts;
DROP FUNCTION IF EXISTS device_event_receipts_immutable();
DROP TABLE IF EXISTS device_event_receipts;
ALTER TABLE punches DROP CONSTRAINT punches_id_device_employee_unique;

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

DROP INDEX IF EXISTS punches_device_sequence_idx;
ALTER TABLE punches DROP CONSTRAINT punches_device_event_complete;
ALTER TABLE punches DROP CONSTRAINT punches_client_sequence_positive;
ALTER TABLE punches
  DROP COLUMN client_sequence,
  DROP COLUMN client_installation_id,
  DROP COLUMN client_clock_skew_seconds,
  DROP COLUMN evidence_status;

-- An unused one-time activation code must never become a usable credential if
-- application code and schema are rolled back together.
UPDATE devices SET active = false WHERE enrolled_at IS NULL;

ALTER TABLE devices
  DROP COLUMN last_ip,
  DROP COLUMN last_error,
  DROP COLUMN storage_status,
  DROP COLUMN camera_status,
  DROP COLUMN clock_skew_seconds,
  DROP COLUMN rejected_event_count,
  DROP COLUMN pending_event_count,
  DROP COLUMN last_heartbeat_at,
  DROP COLUMN enrolled_at;
