-- Up Migration

-- The commercial page no longer accepts or signs proposals. Remove the
-- previously isolated acceptance ledger and its mutation guard.
DROP TRIGGER IF EXISTS proposal_acceptances_immutable ON proposal_acceptances;
DROP FUNCTION IF EXISTS prevent_proposal_acceptance_mutation();
DROP TABLE IF EXISTS proposal_acceptances;

-- Down Migration

-- Intentionally irreversible: acceptance collection must not be restored by
-- a rollback without a fresh legal and product review.
