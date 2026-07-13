-- Up Migration

-- Every access token carries this version. Password/role/activation changes
-- increment it so authorization changes take effect immediately.
ALTER TABLE users
  ADD COLUMN session_version integer NOT NULL DEFAULT 1 CHECK (session_version > 0);

-- Refresh tokens form server-side session families and are single-use.
ALTER TABLE refresh_tokens
  ADD COLUMN family_id uuid,
  ADD COLUMN parent_token_id uuid,
  ADD COLUMN used_at timestamptz,
  ADD COLUMN revoked_reason text;
UPDATE refresh_tokens SET family_id = id WHERE family_id IS NULL;
ALTER TABLE refresh_tokens
  ALTER COLUMN family_id SET NOT NULL,
  ADD CONSTRAINT refresh_tokens_parent_fk
    FOREIGN KEY (parent_token_id) REFERENCES refresh_tokens(id),
  ADD CONSTRAINT refresh_tokens_reason_valid
    CHECK (revoked_reason IS NULL OR length(trim(revoked_reason)) BETWEEN 3 AND 200),
  ADD CONSTRAINT refresh_tokens_hash_unique UNIQUE (token_hash);
CREATE INDEX refresh_tokens_family_idx
  ON refresh_tokens (family_id, created_at DESC);
CREATE INDEX refresh_tokens_active_idx
  ON refresh_tokens (user_id, expires_at)
  WHERE NOT revoked;

-- Down Migration

DROP INDEX IF EXISTS refresh_tokens_active_idx;
DROP INDEX IF EXISTS refresh_tokens_family_idx;
ALTER TABLE refresh_tokens
  DROP CONSTRAINT IF EXISTS refresh_tokens_hash_unique,
  DROP CONSTRAINT IF EXISTS refresh_tokens_reason_valid,
  DROP CONSTRAINT IF EXISTS refresh_tokens_parent_fk,
  DROP COLUMN IF EXISTS revoked_reason,
  DROP COLUMN IF EXISTS used_at,
  DROP COLUMN IF EXISTS parent_token_id,
  DROP COLUMN IF EXISTS family_id;
ALTER TABLE users DROP COLUMN IF EXISTS session_version;
