-- Up Migration

-- Exact-tenant foreign keys below must bind the outbox row and tenant as one
-- identity. A primary key on id alone does not prove that relationship.
ALTER TABLE operational_notification_outbox
  ADD CONSTRAINT operational_notification_outbox_id_org_unique
  UNIQUE (id, organization_id);

-- One durable inbox item per lifecycle event and recipient. The event/outbox
-- uniqueness is the idempotency boundary when several workers race or retry.
CREATE TABLE user_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  user_id uuid NOT NULL,
  outbox_id uuid NOT NULL,
  exception_id uuid NOT NULL,
  exception_event_id uuid NOT NULL,
  notification_type text NOT NULL DEFAULT 'operational_exception'
    CHECK (notification_type = 'operational_exception'),
  event_type text NOT NULL CHECK (event_type IN (
    'opened', 'acknowledged', 'resolved', 'reopened'
  )),
  severity text NOT NULL CHECK (severity IN ('blocker', 'warning')),
  exception_code text NOT NULL CHECK (length(trim(exception_code)) > 0),
  title text NOT NULL CHECK (length(trim(title)) > 0),
  body text NOT NULL CHECK (length(trim(body)) > 0),
  action_url text NOT NULL CHECK (action_url ~ '^/[^/]'),
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (outbox_id, user_id),
  UNIQUE (id, organization_id, user_id),
  FOREIGN KEY (user_id, organization_id)
    REFERENCES users(id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (outbox_id, organization_id)
    REFERENCES operational_notification_outbox(id, organization_id),
  FOREIGN KEY (exception_id, organization_id)
    REFERENCES operational_exceptions(id, organization_id),
  FOREIGN KEY (exception_event_id, organization_id)
    REFERENCES operational_exception_events(id, organization_id)
);
CREATE INDEX user_notifications_inbox_idx
  ON user_notifications (organization_id, user_id, created_at DESC, id DESC);
CREATE INDEX user_notifications_unread_idx
  ON user_notifications (organization_id, user_id, created_at DESC)
  WHERE read_at IS NULL;

-- Browser endpoints are capabilities and globally unique. They are never
-- returned by inbox APIs and are always bound back to the exact tenant/user.
CREATE TABLE push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  user_id uuid NOT NULL,
  endpoint text NOT NULL CHECK (endpoint ~ '^https://'),
  endpoint_hash char(64) NOT NULL UNIQUE
    CHECK (endpoint_hash ~ '^[0-9a-f]{64}$'),
  p256dh text NOT NULL CHECK (length(p256dh) BETWEEN 40 AND 512),
  auth_secret text NOT NULL CHECK (length(auth_secret) BETWEEN 8 AND 256),
  user_agent text,
  active boolean NOT NULL DEFAULT true,
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  last_success_at timestamptz,
  last_failure_at timestamptz,
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, organization_id, user_id),
  FOREIGN KEY (user_id, organization_id)
    REFERENCES users(id, organization_id) ON DELETE CASCADE,
  CHECK (
    (active AND disabled_at IS NULL)
    OR (NOT active AND disabled_at IS NOT NULL)
  )
);
CREATE INDEX push_subscriptions_user_idx
  ON push_subscriptions (organization_id, user_id, active, created_at DESC);

-- A row represents the at-least-once delivery state for one inbox item and
-- one browser subscription. Provider failure never mutates the exception.
CREATE TABLE notification_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  user_id uuid NOT NULL,
  notification_id uuid NOT NULL,
  push_subscription_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'delivered', 'abandoned', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  last_attempt_at timestamptz,
  delivered_at timestamptz,
  last_response_status integer,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (notification_id, push_subscription_id),
  UNIQUE (id, organization_id, user_id),
  FOREIGN KEY (notification_id, organization_id, user_id)
    REFERENCES user_notifications(id, organization_id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (push_subscription_id, organization_id, user_id)
    REFERENCES push_subscriptions(id, organization_id, user_id) ON DELETE CASCADE,
  CHECK (
    (status = 'delivered' AND delivered_at IS NOT NULL)
    OR (status <> 'delivered' AND delivered_at IS NULL)
  )
);
CREATE INDEX notification_deliveries_pending_idx
  ON notification_deliveries (available_at, created_at, id)
  WHERE status = 'pending';
CREATE INDEX notification_deliveries_user_idx
  ON notification_deliveries (organization_id, user_id, created_at DESC);

-- Down Migration

DROP TABLE IF EXISTS notification_deliveries;
DROP TABLE IF EXISTS push_subscriptions;
DROP TABLE IF EXISTS user_notifications;
ALTER TABLE operational_notification_outbox
  DROP CONSTRAINT IF EXISTS operational_notification_outbox_id_org_unique;
