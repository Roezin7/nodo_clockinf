// Tipos compartidos entre server y client — NODO CLOCK-IN

export type UserRole = 'admin' | 'supervisor';

export interface User {
  id: string;
  email: string;
  role: UserRole;
  name: string;
  active: boolean;
  created_at: string;
}

export interface AuthTokens {
  access_token: string;
  refresh_token: string;
}

export interface LoginResponse extends AuthTokens {
  user: User;
}

export interface MealWindow {
  name: string;
  start: string; // 'HH:MM' hora local de planta
  end: string;
  paid: boolean;
}

export interface Shift {
  id: string;
  name: string;
  start_time: string; // 'HH:MM:SS'
  end_time: string;
  tolerance_minutes: number;
  meal_windows: MealWindow[];
}

export interface Area {
  id: string;
  name: string;
}

export interface Employee {
  id: string;
  employee_number: number;
  full_name: string;
  social_security: string | null;
  phone: string | null;
  enrollment_photo_key: string | null;
  default_shift_id: string | null;
  active: boolean;
  hired_at: string | null;
  deactivated_at: string | null;
  created_at: string;
}

export type PunchType = 'shift_in' | 'shift_out' | 'meal_out' | 'meal_in';
export type PunchSource = 'kiosk' | 'manual';
export type FaceCheckStatus = 'pending' | 'match' | 'mismatch' | 'review_ok' | 'skipped';

export interface Punch {
  id: string;
  employee_id: string;
  punch_type: PunchType;
  punched_at: string; // ISO UTC
  area_id: string | null;
  source: PunchSource;
  photo_key: string | null;
  face_check_status: FaceCheckStatus;
  face_check_score: number | null;
  created_by: string | null;
  correction_of: string | null;
  correction_reason: string | null;
  voided: boolean;
  created_at: string;
}

export interface PunchIngestRequest {
  employee_number: number;
  pin: string;
  punch_type?: PunchType | null;
  source: 'kiosk';
}

export interface PunchIngestResponse {
  punch_id: string;
  employee_name: string;
  punch_type_inferred: PunchType;
  punched_at: string;
}

export type AnomalyType =
  | 'missing_shift_out'
  | 'missing_meal_in'
  | 'out_of_sequence'
  | 'orphan_punch';

export interface Anomaly {
  type: AnomalyType;
  employee_id: string;
  work_date: string; // YYYY-MM-DD local de planta
  punch_id: string | null;
  detail: string;
}

export type DayState = 'out' | 'in' | 'meal';

export interface DayCalc {
  employee_id: string;
  work_date: string;
  shift_in: string | null;
  shift_out: string | null;
  meal_minutes: number;
  worked_minutes: number;
  late: boolean;
  late_minutes: number;
  complete: boolean;
  /** Estado al final de las checadas procesadas: adentro, en comida o fuera. */
  state: DayState;
  anomalies: Anomaly[];
}

export interface DayDetailPunch {
  id: string;
  punch_type: PunchType;
  punched_at: string;
  source: string;
  voided: boolean;
  correction_reason: string | null;
  area_name: string | null;
}

export interface DayDetailRow {
  employee_id: string;
  employee_number: number;
  full_name: string;
  shift_name: string | null;
  area_name: string | null;
  calc: DayCalc;
  punches: DayDetailPunch[];
}

export interface AttendanceDayResponse {
  date: string;
  rows: DayDetailRow[];
}

export interface WeekEmployeeCalc {
  employee_id: string;
  employee_number: number;
  full_name: string;
  social_security: string | null;
  days_worked: number;
  regular_minutes: number;
  overtime_minutes: number;
  lates: number;
  absences: number;
  total_minutes: number;
  days: DayCalc[];
}

export interface WeekReport {
  week_start: string;
  week_end: string;
  employees: WeekEmployeeCalc[];
  anomaly_count: number;
  status: 'draft' | 'final';
  finalized_at?: string;
  finalized_by?: string;
}

export interface Settings {
  daily_ot_threshold_minutes: number;
  weekly_ot_threshold_minutes: number;
  week_start_day: number; // 0=domingo … 6=sábado
  photo_retention_weeks: number;
  timezone: string;
}
