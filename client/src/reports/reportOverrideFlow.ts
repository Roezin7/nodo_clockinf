export interface ReportOverrides {
  device: boolean;
  operational: boolean;
}

export const NO_REPORT_OVERRIDES: ReportOverrides = {
  device: false,
  operational: false,
};

export function mergeReportOverrides(
  current: ReportOverrides,
  requested: Partial<ReportOverrides>,
): ReportOverrides {
  return {
    device: current.device || requested.device === true,
    operational: current.operational || requested.operational === true,
  };
}

export function reportOverridePayload(
  overrides: ReportOverrides,
  reason: string,
): {
  override_device_health?: true;
  override_operational_blockers?: true;
  reason?: string;
} {
  const active = overrides.device || overrides.operational;
  return {
    ...(overrides.device ? { override_device_health: true as const } : {}),
    ...(overrides.operational ? { override_operational_blockers: true as const } : {}),
    ...(active ? { reason: reason.trim() } : {}),
  };
}
