import { ApiError } from '../api';

export interface ReviewBlocker {
  code: string;
  work_date: string | null;
}

export interface ReviewBlockerConflict {
  message: string;
  anomaly_count: number;
  blockers: ReviewBlocker[];
}

export function parseReviewBlockerConflict(error: unknown): ReviewBlockerConflict | null {
  if (!(error instanceof ApiError) || error.code !== 'review_operational_blockers') return null;
  const details = error.details && typeof error.details === 'object'
    ? error.details as Record<string, unknown>
    : {};
  const blockers = Array.isArray(details.blockers)
    ? details.blockers.flatMap((value): ReviewBlocker[] => {
      if (!value || typeof value !== 'object') return [];
      const row = value as Record<string, unknown>;
      if (typeof row.code !== 'string') return [];
      return [{
        code: row.code,
        work_date: typeof row.work_date === 'string' ? row.work_date : null,
      }];
    })
    : [];
  const anomalyCount = Number(details.anomaly_count);
  return {
    message: error.message,
    anomaly_count: Number.isInteger(anomalyCount) && anomalyCount >= 0 ? anomalyCount : 0,
    blockers,
  };
}
