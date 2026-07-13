-- Up Migration

-- This product instance serves the three Modesto plants and its legal
-- screening is intentionally California-specific. Prevent an API or direct DB
-- write from selecting a timezone that would make the worker fail closed.
ALTER TABLE organizations
  ADD CONSTRAINT organizations_modesto_timezone_check
  CHECK (timezone = 'America/Los_Angeles');

-- This table is a reconciled operational projection. It is deliberately not a
-- source of payable time: punches and manual_time_entries remain authoritative.
CREATE TABLE operational_exceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  dedupe_key char(64) NOT NULL,
  code text NOT NULL CHECK (code IN (
    'missing_shift_out', 'missing_meal_in', 'out_of_sequence',
    'overlap_between_plants', 'negative_duration', 'invalid_manual_time',
    'split_shift_policy_review',
    'first_meal_waiver_review', 'first_meal_missing', 'first_meal_short',
    'first_meal_late', 'second_meal_waiver_review', 'second_meal_missing',
    'second_meal_short', 'second_meal_late',
    'identity_review', 'device_unhealthy'
  )),
  severity text NOT NULL CHECK (severity IN ('blocker', 'warning')),
  source_type text NOT NULL CHECK (source_type IN (
    'punch_sequence', 'employee_workday', 'manual_time',
    'identity_session', 'device'
  )),
  source_key text NOT NULL CHECK (length(trim(source_key)) > 0),
  source_fingerprint char(64) NOT NULL,
  employee_id uuid,
  work_date date,
  occurred_at timestamptz NOT NULL,
  title text NOT NULL CHECK (length(trim(title)) > 0),
  details jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(details) = 'object'),
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'acknowledged', 'resolved')),
  first_detected_at timestamptz NOT NULL DEFAULT now(),
  last_detected_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  acknowledged_by uuid,
  resolved_at timestamptz,
  resolved_by uuid,
  resolution_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, dedupe_key),
  UNIQUE (id, organization_id),
  FOREIGN KEY (employee_id, organization_id)
    REFERENCES employees(id, organization_id),
  FOREIGN KEY (acknowledged_by, organization_id)
    REFERENCES users(id, organization_id),
  FOREIGN KEY (resolved_by, organization_id)
    REFERENCES users(id, organization_id),
  CHECK (dedupe_key ~ '^[0-9a-f]{64}$'),
  CHECK (source_fingerprint ~ '^[0-9a-f]{64}$'),
  CHECK (
    (acknowledged_at IS NULL AND acknowledged_by IS NULL)
    OR (acknowledged_at IS NOT NULL AND acknowledged_by IS NOT NULL)
  ),
  CHECK (
    (status = 'open'
      AND acknowledged_at IS NULL AND acknowledged_by IS NULL
      AND resolved_at IS NULL AND resolved_by IS NULL AND resolution_reason IS NULL)
    OR
    (status = 'acknowledged'
      AND acknowledged_at IS NOT NULL AND acknowledged_by IS NOT NULL
      AND resolved_at IS NULL AND resolved_by IS NULL AND resolution_reason IS NULL)
    OR
    (status = 'resolved'
      AND resolved_at IS NOT NULL
      AND length(trim(resolution_reason)) >= 3)
  )
);
CREATE INDEX operational_exceptions_queue_idx
  ON operational_exceptions
    (organization_id, status, severity, work_date DESC, occurred_at DESC);
CREATE INDEX operational_exceptions_employee_idx
  ON operational_exceptions (organization_id, employee_id, work_date DESC)
  WHERE employee_id IS NOT NULL;
CREATE INDEX operational_exceptions_source_idx
  ON operational_exceptions (organization_id, source_type, source_key);

-- A multi-plant exception is visible/manageable only through this exact-tenant
-- relation. The relation is part of the projection and may be rebuilt safely.
CREATE TABLE operational_exception_plants (
  exception_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  plant_id uuid NOT NULL,
  PRIMARY KEY (exception_id, plant_id),
  FOREIGN KEY (exception_id, organization_id)
    REFERENCES operational_exceptions(id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (plant_id, organization_id)
    REFERENCES plants(id, organization_id)
);
CREATE INDEX operational_exception_plants_scope_idx
  ON operational_exception_plants (organization_id, plant_id, exception_id);

-- Lifecycle evidence is append-only even though the current projection above
-- is reconciled and mutable.
CREATE TABLE operational_exception_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  exception_id uuid NOT NULL,
  sequence bigint NOT NULL CHECK (sequence > 0),
  event_type text NOT NULL CHECK (event_type IN (
    'opened', 'refreshed', 'acknowledged', 'resolved', 'reopened'
  )),
  from_status text CHECK (from_status IN ('open', 'acknowledged', 'resolved')),
  to_status text NOT NULL CHECK (to_status IN ('open', 'acknowledged', 'resolved')),
  actor_user_id uuid,
  reason text,
  snapshot jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(snapshot) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, organization_id),
  UNIQUE (exception_id, sequence),
  FOREIGN KEY (exception_id, organization_id)
    REFERENCES operational_exceptions(id, organization_id),
  FOREIGN KEY (actor_user_id, organization_id)
    REFERENCES users(id, organization_id),
  CHECK (reason IS NULL OR length(trim(reason)) >= 3),
  CHECK (
    (event_type = 'opened' AND from_status IS NULL AND to_status = 'open')
    OR (event_type = 'refreshed' AND from_status = to_status)
    OR (event_type = 'acknowledged' AND from_status = 'open' AND to_status = 'acknowledged')
    OR (event_type = 'resolved' AND from_status IN ('open', 'acknowledged') AND to_status = 'resolved')
    OR (event_type = 'reopened' AND from_status = 'resolved' AND to_status = 'open')
  )
);
CREATE INDEX operational_exception_events_history_idx
  ON operational_exception_events (organization_id, exception_id, created_at, id);

CREATE OR REPLACE FUNCTION operational_exception_events_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'operational_exception_events is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER operational_exception_events_no_update
  BEFORE UPDATE ON operational_exception_events
  FOR EACH ROW EXECUTE FUNCTION operational_exception_events_immutable();
CREATE TRIGGER operational_exception_events_no_delete
  BEFORE DELETE ON operational_exception_events
  FOR EACH ROW EXECUTE FUNCTION operational_exception_events_immutable();

-- Transactional outbox: lifecycle writes and notification intent cannot split.
-- Delivery/channel selection is intentionally a later worker concern.
CREATE TABLE operational_notification_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  exception_event_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN (
    'opened', 'acknowledged', 'resolved', 'reopened'
  )),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  available_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  processed_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (exception_event_id),
  FOREIGN KEY (exception_event_id, organization_id)
    REFERENCES operational_exception_events(id, organization_id)
);
CREATE INDEX operational_notification_outbox_pending_idx
  ON operational_notification_outbox (available_at, created_at)
  WHERE processed_at IS NULL;

CREATE OR REPLACE FUNCTION enqueue_operational_exception_event() RETURNS trigger AS $$
BEGIN
  IF NEW.event_type IN ('opened', 'acknowledged', 'resolved', 'reopened') THEN
    INSERT INTO operational_notification_outbox
      (organization_id, exception_event_id, event_type, payload)
    VALUES (
      NEW.organization_id,
      NEW.id,
      NEW.event_type,
      jsonb_build_object(
        'exception_id', NEW.exception_id,
        'sequence', NEW.sequence,
        'event_type', NEW.event_type,
        'to_status', NEW.to_status,
        'snapshot', NEW.snapshot
      )
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER operational_exception_event_outbox
  AFTER INSERT ON operational_exception_events
  FOR EACH ROW EXECUTE FUNCTION enqueue_operational_exception_event();

-- Down Migration

DROP TRIGGER IF EXISTS operational_exception_event_outbox ON operational_exception_events;
DROP FUNCTION IF EXISTS enqueue_operational_exception_event();
DROP TABLE IF EXISTS operational_notification_outbox;
DROP TRIGGER IF EXISTS operational_exception_events_no_delete ON operational_exception_events;
DROP TRIGGER IF EXISTS operational_exception_events_no_update ON operational_exception_events;
DROP FUNCTION IF EXISTS operational_exception_events_immutable();
DROP TABLE IF EXISTS operational_exception_events;
DROP TABLE IF EXISTS operational_exception_plants;
DROP TABLE IF EXISTS operational_exceptions;
ALTER TABLE organizations
  DROP CONSTRAINT IF EXISTS organizations_modesto_timezone_check;
