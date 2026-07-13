// Tipos compartidos entre server y client — NODO CLOCK-IN

export type UserRole = 'platform_operator' | 'admin' | 'foreman' | 'accountant';

export interface User {
  id: string;
  email: string;
  role: UserRole;
  name: string;
  organization_id: string | null;
  active: boolean;
  created_at: string;
  plant_ids?: string[];
}

export interface Organization {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  active: boolean;
  created_at: string;
}

export interface Plant {
  id: string;
  organization_id: string;
  code: string;
  name: string;
  active: boolean;
  created_at: string;
}

export interface Device {
  id: string;
  organization_id: string;
  plant_id: string;
  plant_name: string;
  name: string;
  public_id: string;
  active: boolean;
  enrolled_at: string | null;
  last_seen_at: string | null;
  last_sync_at: string | null;
  last_heartbeat_at: string | null;
  pending_event_count: number;
  rejected_event_count: number;
  app_version: string | null;
  camera_status: DeviceComponentStatus;
  storage_status: DeviceComponentStatus;
  clock_skew_seconds: number | null;
  last_error: string | null;
  created_at: string;
}

export type DeviceComponentStatus = 'unknown' | 'ready' | 'degraded' | 'unavailable';

export interface EmployeeRate {
  id: string;
  employee_id: string;
  hourly_rate: string;
  effective_from: string;
  effective_to: string | null;
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
  organization_id: string;
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
export type PunchEvidenceStatus = 'pending' | 'captured' | 'camera_unavailable';
export type DeviceEvidenceStatus = Exclude<PunchEvidenceStatus, 'pending'>;

export interface Punch {
  id: string;
  organization_id: string;
  plant_id: string | null;
  device_id: string | null;
  client_event_id: string | null;
  client_installation_id: string | null;
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
  captured_at: string;
  client_clock_skew_seconds: number | null;
  evidence_status: PunchEvidenceStatus;
  received_at: string;
  offline: boolean;
  identity_status: 'verified' | 'identity_review' | 'review_approved' | 'review_rejected' | 'not_required';
  created_at: string;
}

export interface PunchIngestRequest {
  employee_number: number;
  pin: string;
  punch_type: PunchType;
  source: 'kiosk';
  client_event_id: string;
  client_installation_id: string;
  captured_at: string;
  client_sequence: number;
  client_clock_skew_seconds: number | null;
  evidence_status: DeviceEvidenceStatus;
}

export interface PunchIngestResponse {
  punch_id: string;
  employee_name: string;
  punch_type: PunchType;
  punch_type_inferred: PunchType;
  punched_at: string;
  /** Hora local de planta ya formateada por el SERVIDOR (única fuente de verdad). */
  punched_at_local: string;
  timezone: string;
  evidence_status: DeviceEvidenceStatus;
  duplicate?: boolean;
}

export interface OfflinePunchEvent {
  employee_number: number;
  punch_type: PunchType;
  client_event_id: string;
  client_installation_id: string;
  captured_at: string;
  client_sequence: number;
  client_clock_skew_seconds: number | null;
  evidence_status: DeviceEvidenceStatus;
}

export type OfflinePunchSyncResult =
  | {
      client_event_id: string;
      client_sequence: number;
      status: 'accepted' | 'duplicate';
      punch_id: string;
      employee_name: string;
      punch_type: PunchType;
      punched_at: string;
      punched_at_local: string;
      timezone: string;
      evidence_status: DeviceEvidenceStatus;
    }
  | {
      client_event_id: string | null;
      client_sequence: number | null;
      status: 'rejected';
      code: string;
      error: string;
    };

export interface OfflinePunchSyncResponse {
  results: OfflinePunchSyncResult[];
  accepted: number;
  duplicates: number;
  rejected: number;
  synced_at: string;
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
  meal_seconds: number;
  worked_seconds: number;
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
  plant_id: string;
  plant_name: string;
  created_by_name: string | null;
  created_at: string;
  correction_of: string | null;
  voided_by_name: string | null;
  void_reason: string | null;
}

export interface ManualTimeEntry {
  id: string;
  employee_id: string;
  plant_id: string;
  plant_name: string;
  work_date: string;
  duration_seconds: number;
  reason: string;
  created_by: string;
  created_by_name: string;
  created_at: string;
  voided_at: string | null;
  voided_by: string | null;
  void_reason: string | null;
}

export interface DayDetailRow {
  employee_id: string;
  employee_number: number;
  full_name: string;
  shift_name: string | null;
  area_name: string | null;
  calc: DayCalc;
  punches: DayDetailPunch[];
  manual_time: ManualTimeEntry[];
  manual_seconds: number;
  total_seconds: number;
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
  double_time_minutes: number;
  clocked_minutes: number;
  manual_minutes: number;
  regular_seconds: number;
  overtime_seconds: number;
  double_time_seconds: number;
  clocked_seconds: number;
  manual_seconds: number;
  total_seconds: number;
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
  status: 'draft' | 'open' | 'final' | 'reopened';
  policy: 'CA_STANDARD_8_40';
  version?: number;
  snapshot_hash?: string;
  issues?: TimecardIssue[];
  finalized_at?: string;
  finalized_by?: string;
}

export interface TimecardIssue {
  employee_id: string;
  employee_number: number;
  full_name: string;
  type: 'missing_shift_out' | 'missing_meal_in' | 'out_of_sequence' | 'overlap_between_plants';
  detail: string;
  punch_ids: string[];
  plant_ids: string[];
  start: string | null;
  end: string | null;
  blocking: true;
}

export interface ReportVersionSummary {
  id: string;
  version: number;
  snapshot_hash: string;
  finalized_at: string;
  finalized_by: string;
  finalized_by_name: string;
  finalization_reason: string | null;
}

export interface Settings {
  daily_ot_threshold_minutes: number;
  weekly_ot_threshold_minutes: number;
  week_start_day: number; // ISO: 1=lunes … 7=domingo
  photo_retention_weeks: number;
  duplicate_window_minutes: number;
  work_days: number[]; // ISO 1=lunes … 7=domingo
  /** Zona horaria de la planta: gobierna cortes de día, retardos y TODA la presentación. */
  timezone: string;
}

/** Zonas horarias permitidas (EE.UU. + México DF). */
export const ALLOWED_TIMEZONES = [
  { id: 'America/New_York', label: 'Este (New York)' },
  { id: 'America/Chicago', label: 'Central (Chicago)' },
  { id: 'America/Denver', label: 'Montaña (Denver)' },
  { id: 'America/Phoenix', label: 'Arizona (Phoenix, sin DST)' },
  { id: 'America/Los_Angeles', label: 'Pacífico (Los Angeles)' },
  { id: 'America/Anchorage', label: 'Alaska (Anchorage)' },
  { id: 'Pacific/Honolulu', label: 'Hawái (Honolulu)' },
  { id: 'America/Mexico_City', label: 'Ciudad de México' },
] as const;

export type AllowedTimezone = (typeof ALLOWED_TIMEZONES)[number]['id'];
