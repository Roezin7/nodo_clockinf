-- Up Migration

-- Usuarios del sistema (administrativos, NO empleados de piso)
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'supervisor')),
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Refresh tokens (hasheados, revocables)
CREATE TABLE refresh_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id);

-- Áreas de trabajo
CREATE TABLE areas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text UNIQUE NOT NULL
);

-- Turnos
CREATE TABLE shifts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  start_time time NOT NULL,
  end_time time NOT NULL,
  tolerance_minutes int NOT NULL DEFAULT 5,
  meal_windows jsonb NOT NULL DEFAULT '[]'::jsonb
);

-- Empleados de piso
CREATE TABLE employees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_number serial UNIQUE,
  full_name text NOT NULL,
  social_security text,
  phone text,
  pin_hash text NOT NULL,
  enrollment_photo_key text,
  default_shift_id uuid REFERENCES shifts(id),
  active boolean NOT NULL DEFAULT true,
  hired_at date,
  deactivated_at date,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Log inmutable de checadas
CREATE TABLE punches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL REFERENCES employees(id),
  punch_type text NOT NULL CHECK (punch_type IN ('shift_in','shift_out','meal_out','meal_in')),
  punched_at timestamptz NOT NULL,
  area_id uuid REFERENCES areas(id),
  source text NOT NULL CHECK (source IN ('kiosk','manual')),
  photo_key text,
  face_check_status text NOT NULL DEFAULT 'skipped'
    CHECK (face_check_status IN ('pending','match','mismatch','review_ok','skipped')),
  face_check_score numeric,
  created_by uuid REFERENCES users(id),
  correction_of uuid REFERENCES punches(id),
  correction_reason text,
  voided boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- una corrección manual siempre lleva razón y autor
  CONSTRAINT manual_requires_author CHECK (source <> 'manual' OR created_by IS NOT NULL),
  CONSTRAINT correction_requires_reason CHECK (correction_of IS NULL OR correction_reason IS NOT NULL)
);
CREATE INDEX punches_employee_time_idx ON punches (employee_id, punched_at);
CREATE INDEX punches_time_idx ON punches (punched_at);
CREATE INDEX punches_face_pending_idx ON punches (face_check_status) WHERE face_check_status = 'pending';

-- El log es inmutable: solo se permite marcar voided y actualizar el resultado
-- de la verificación facial / photo_key (que se asigna después de la checada).
CREATE OR REPLACE FUNCTION punches_immutable_guard() RETURNS trigger AS $$
BEGIN
  IF (NEW.employee_id, NEW.punch_type, NEW.punched_at, NEW.area_id, NEW.source,
      NEW.created_by, NEW.correction_of, NEW.correction_reason, NEW.created_at)
     IS DISTINCT FROM
     (OLD.employee_id, OLD.punch_type, OLD.punched_at, OLD.area_id, OLD.source,
      OLD.created_by, OLD.correction_of, OLD.correction_reason, OLD.created_at)
  THEN
    RAISE EXCEPTION 'punches es un log inmutable: solo voided, photo_key y face_check_* son actualizables';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER punches_no_update
  BEFORE UPDATE ON punches
  FOR EACH ROW EXECUTE FUNCTION punches_immutable_guard();

CREATE OR REPLACE FUNCTION punches_no_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'punches es un log inmutable: no se permite DELETE';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER punches_no_delete
  BEFORE DELETE ON punches
  FOR EACH ROW EXECUTE FUNCTION punches_no_delete();

-- Asignación diaria de área (los trabajadores rotan entre áreas)
CREATE TABLE daily_area_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL REFERENCES employees(id),
  work_date date NOT NULL,
  area_id uuid NOT NULL REFERENCES areas(id),
  UNIQUE (employee_id, work_date, area_id)
);
CREATE INDEX daily_area_assignments_date_idx ON daily_area_assignments (work_date);

-- Cierre semanal (snapshot para el contador)
CREATE TABLE weekly_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  week_start date NOT NULL,
  week_end date NOT NULL,
  generated_by uuid NOT NULL REFERENCES users(id),
  generated_at timestamptz NOT NULL DEFAULT now(),
  data jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('draft','final'))
);
CREATE UNIQUE INDEX weekly_reports_final_unique ON weekly_reports (week_start) WHERE status = 'final';

-- Configuración editable por el admin (umbrales OT, inicio de semana, retención)
CREATE TABLE settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Down Migration
DROP TABLE IF EXISTS settings;
DROP TABLE IF EXISTS weekly_reports;
DROP TABLE IF EXISTS daily_area_assignments;
DROP TRIGGER IF EXISTS punches_no_delete ON punches;
DROP TRIGGER IF EXISTS punches_no_update ON punches;
DROP FUNCTION IF EXISTS punches_no_delete();
DROP FUNCTION IF EXISTS punches_immutable_guard();
DROP TABLE IF EXISTS punches;
DROP TABLE IF EXISTS employees;
DROP TABLE IF EXISTS shifts;
DROP TABLE IF EXISTS areas;
DROP TABLE IF EXISTS refresh_tokens;
DROP TABLE IF EXISTS users;
