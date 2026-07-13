import { ApiError } from '../api';

export interface OperationalBlocker {
  code: string;
  title: string;
  employee_id: string | null;
  work_date: string | null;
  plant_ids: string[];
  source_key: string;
}

export interface OperationalBlockerConflict {
  message: string;
  blockers: OperationalBlocker[];
}

function isOperationalBlocker(value: unknown): value is OperationalBlocker {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.code === 'string' &&
    typeof row.title === 'string' &&
    (row.employee_id === null || typeof row.employee_id === 'string') &&
    (row.work_date === null || typeof row.work_date === 'string') &&
    Array.isArray(row.plant_ids) &&
    row.plant_ids.every((plant) => typeof plant === 'string') &&
    typeof row.source_key === 'string'
  );
}

export function parseOperationalBlockerConflict(
  error: unknown,
): OperationalBlockerConflict | null {
  if (!(error instanceof ApiError) || error.code !== 'operational_exception_blockers') return null;
  const details = error.details as { blockers?: unknown } | undefined;
  const blockers = Array.isArray(details?.blockers)
    ? details.blockers.filter(isOperationalBlocker)
    : [];
  return { message: error.message, blockers };
}
