-- Up Migration

-- Commercial acceptances are isolated from attendance, payroll reports and
-- organizations. IP addresses are deliberately not collected by default.
CREATE TABLE proposal_acceptances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_slug text NOT NULL CHECK (proposal_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  proposal_version text NOT NULL,
  legal_company_name text NOT NULL,
  representative_name text NOT NULL,
  email text NOT NULL,
  phone text NOT NULL,
  stations integer NOT NULL CHECK (stations > 0),
  plants integer NOT NULL CHECK (plants > 0),
  employees integer NOT NULL CHECK (employees > 0),
  accepted_configuration jsonb NOT NULL,
  accepted_prices jsonb NOT NULL,
  signature_name text NOT NULL,
  session_id uuid NOT NULL,
  consent_shown text NOT NULL,
  kickoff_requested boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX proposal_acceptances_slug_time_idx
  ON proposal_acceptances (proposal_slug, created_at DESC);

CREATE FUNCTION prevent_proposal_acceptance_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'proposal acceptances are immutable';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER proposal_acceptances_immutable
  BEFORE UPDATE OR DELETE ON proposal_acceptances
  FOR EACH ROW EXECUTE FUNCTION prevent_proposal_acceptance_mutation();

-- Down Migration

DROP TRIGGER IF EXISTS proposal_acceptances_immutable ON proposal_acceptances;
DROP FUNCTION IF EXISTS prevent_proposal_acceptance_mutation();
DROP TABLE IF EXISTS proposal_acceptances;
