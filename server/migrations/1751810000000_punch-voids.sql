-- Up Migration

-- Auditoría de anulaciones: quién, cuándo y por qué se anuló cada checada.
-- La checada anulada permanece en el log (voided=true), nunca se borra.
CREATE TABLE punch_voids (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  punch_id uuid NOT NULL UNIQUE REFERENCES punches(id),
  voided_by uuid NOT NULL REFERENCES users(id),
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Down Migration
DROP TABLE IF EXISTS punch_voids;
