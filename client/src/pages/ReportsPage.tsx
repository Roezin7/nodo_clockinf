import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft, ChevronRight, FileSpreadsheet } from 'lucide-react';
import type { WeekReport } from '@clockai/shared';
import { api, ApiError, authenticatedFetch } from '../api';
import { useAuth } from '../hooks/useAuth';
import { fmtDateTime, fmtTime, todayLocal, useAppTimezone } from '../time';
import { PageHeader } from '../components/layout/PageHeader';
import {
  canOverrideDeviceHealth,
  parseDeviceHealthConflict,
  type DeviceHealthConflict,
} from '../reports/deviceHealth';
import {
  parseOperationalBlockerConflict,
  type OperationalBlockerConflict,
} from '../reports/operationalBlockers';
import {
  parseReviewBlockerConflict,
  type ReviewBlockerConflict,
} from '../reports/reviewBlockers';
import {
  ACCOUNTANT_EXCEPTION_LABELS,
  parseAccountantReport,
  parseReportVersionPage,
  parseReportWeekPage,
  reportExportPath,
  reportVersionPath,
  type AccountantDetailRow,
  type AccountantReportSnapshot,
  type FinalReportVersion,
  type FinalReportWeek,
  type PayPeriodStatus,
  type ReportArtifactKind,
} from '../reports/accountantReport';
import {
  mergeReportOverrides,
  NO_REPORT_OVERRIDES,
  reportOverridePayload,
  type ReportOverrides,
} from '../reports/reportOverrideFlow';
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Modal,
  StatusBadge,
  Table,
  TableSkeleton,
  TD,
  TFootRow,
  TH,
  THead,
  Textarea,
  TRow,
  useToast,
} from '../components/ui';

type AdminReport = Omit<WeekReport, 'status'> & {
  status: WeekReport['status'] | 'ready_for_review';
};

type FinalTab = 'summary' | 'detail';

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return new Date(d).toISOString().slice(0, 10);
}

const fmtHours = (seconds: number | null | undefined): string =>
  seconds === null || seconds === undefined ? '—' : (seconds / 3600).toFixed(2);

const shortHash = (hash: string | null | undefined): string => (hash ? hash.slice(0, 12) : '—');

function ReportStatus({ status }: { status: AdminReport['status'] | PayPeriodStatus }) {
  if (status === 'final') return <StatusBadge status="cerrada" />;
  if (status === 'reopened') return <Badge tone="warning">Reabierta</Badge>;
  if (status === 'ready_for_review') return <Badge tone="info">Lista para revisión</Badge>;
  if (status === 'open') return <Badge tone="info">Abierta</Badge>;
  return <StatusBadge status="borrador" />;
}

const PUNCH_LABELS = {
  shift_in: 'Entrada',
  meal_out: 'Lonche in',
  meal_in: 'Lonche out',
  shift_out: 'Salida',
} as const;

function safeError(error: unknown, fallback: string): string {
  return error instanceof ApiError || error instanceof Error ? error.message : fallback;
}

function legacyExportMessage(error: unknown): string {
  if (
    error instanceof ApiError &&
    (error.code === 'legacy_export_unavailable' || error.code === 'legacy_artifact_unavailable')
  ) {
    return 'Esta versión histórica no tiene un archivo exacto almacenado. Consulta su resumen en pantalla.';
  }
  return safeError(error, 'No se pudo exportar el reporte.');
}

function parseFinalizationAnomalyConflict(error: unknown): OperationalBlockerConflict | null {
  return error instanceof ApiError && error.code === 'anomalies_pending'
    ? { message: error.message, blockers: [] }
    : null;
}

function DetailPunches({ row }: { row: AccountantDetailRow }) {
  if (row.punches.length === 0) return <span className="text-ink-tertiary">Sin checadas</span>;
  return (
    <div className="flex min-w-64 flex-wrap gap-x-3 gap-y-1">
      {row.punches.map((punch, index) => (
        <span key={`${punch.type}-${punch.occurred_at}-${index}`} className="whitespace-nowrap text-12">
          <span className="text-ink-tertiary">{PUNCH_LABELS[punch.type]}</span>{' '}
          <span className="tnum font-medium text-ink">{fmtTime(punch.occurred_at)}</span>
        </span>
      ))}
    </div>
  );
}

export default function ReportsPage() {
  useAppTimezone();
  const user = useAuth();
  const toast = useToast();
  const isAdmin = user?.role === 'admin';
  const [anchor, setAnchor] = useState(todayLocal());
  const [periods, setPeriods] = useState<FinalReportWeek[] | null>(null);
  const [periodCursor, setPeriodCursor] = useState<string | null>(null);
  const [preview, setPreview] = useState<AdminReport | null>(null);
  const [versions, setVersions] = useState<FinalReportVersion[] | null>(null);
  const [versionCursor, setVersionCursor] = useState<number | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const [snapshot, setSnapshot] = useState<AccountantReportSnapshot | null>(null);
  const [showPreview, setShowPreview] = useState(true);
  const [finalTab, setFinalTab] = useState<FinalTab>('summary');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMorePeriods, setLoadingMorePeriods] = useState(false);
  const [loadingMoreVersions, setLoadingMoreVersions] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [closing, setClosing] = useState(false);
  const [transitioning, setTransitioning] = useState(false);
  const [reopenModal, setReopenModal] = useState(false);
  const [reopenReason, setReopenReason] = useState('');
  const [reopenError, setReopenError] = useState<string | null>(null);
  const [reopening, setReopening] = useState(false);
  const [deviceHealthConflict, setDeviceHealthConflict] = useState<DeviceHealthConflict | null>(null);
  const [operationalConflict, setOperationalConflict] = useState<OperationalBlockerConflict | null>(null);
  const [reviewConflict, setReviewConflict] = useState<ReviewBlockerConflict | null>(null);
  const [overrideTarget, setOverrideTarget] = useState<'ready' | 'finalize' | null>(null);
  const [approvedOverrides, setApprovedOverrides] = useState<ReportOverrides>(NO_REPORT_OVERRIDES);
  const [overrideReason, setOverrideReason] = useState('');
  const [overrideConfirmed, setOverrideConfirmed] = useState(false);
  const [overrideError, setOverrideError] = useState<string | null>(null);
  const versionRequestRef = useRef(0);

  const loadFinalVersion = useCallback(async (weekStart: string, version: number) => {
    const requestId = ++versionRequestRef.current;
    setError(null);
    setSnapshot(null);
    setSelectedVersion(version);
    setLoading(true);
    try {
      const response = await api<unknown>(reportVersionPath(weekStart, version));
      if (requestId !== versionRequestRef.current) return;
      const parsed = parseAccountantReport(response);
      setSnapshot(parsed);
      setFinalTab('summary');
    } catch (err) {
      if (requestId === versionRequestRef.current) {
        setError(safeError(err, 'No se pudo cargar la versión final.'));
      }
    } finally {
      if (requestId === versionRequestRef.current) setLoading(false);
    }
  }, []);

  const loadAdmin = useCallback(async () => {
    versionRequestRef.current += 1;
    setLoading(true);
    setError(null);
    setHistoryError(null);
    setPreview(null);
    setSnapshot(null);
    setVersions(null);
    setVersionCursor(null);
    setSelectedVersion(null);
    setShowPreview(true);
    try {
      const nextPreview = await api<AdminReport>(`/api/reports/week/${encodeURIComponent(anchor)}/preview`);
      setPreview(nextPreview);
      try {
        const rawVersions = await api<unknown>(
          `/api/reports/week/${encodeURIComponent(nextPreview.week_start)}/versions?limit=100`,
        );
        const page = parseReportVersionPage(rawVersions);
        setVersions(page.items);
        setVersionCursor(page.next_cursor);
      } catch (err) {
        setVersions([]);
        setHistoryError(safeError(err, 'No se pudo cargar el historial de versiones.'));
      }
    } catch (err) {
      setError(safeError(err, 'No se pudo cargar la vista de trabajo.'));
    } finally {
      setLoading(false);
    }
  }, [anchor]);

  useEffect(() => {
    if (!user) return;
    if (isAdmin) {
      setPeriods(null);
      void loadAdmin();
      return;
    }

    let active = true;
    setLoading(true);
    setError(null);
    void api<unknown>('/api/reports/weeks?limit=52')
      .then((response) => {
        if (!active) return;
        const page = parseReportWeekPage(response);
        const finalPeriods = page.items.filter(
          (period) => period.current_version !== null && period.current_version > 0,
        );
        setPeriods(finalPeriods);
        setPeriodCursor(page.next_cursor);
        if (finalPeriods.length > 0 && !finalPeriods.some((period) => period.week_start === anchor)) {
          setAnchor(finalPeriods[0]!.week_start);
        }
      })
      .catch((err) => {
        if (active) setError(safeError(err, 'No se pudieron cargar las semanas finalizadas.'));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [isAdmin, user?.id]);

  useEffect(() => {
    if (!user || isAdmin || periods === null) return;
    if (periods.length === 0) {
      setVersions([]);
      setSnapshot(null);
      setLoading(false);
      return;
    }
    if (!periods.some((period) => period.week_start === anchor)) return;

    let active = true;
    const requestId = ++versionRequestRef.current;
    setLoading(true);
    setError(null);
    setHistoryError(null);
    setSnapshot(null);
    setVersions(null);
    void api<unknown>(`/api/reports/week/${encodeURIComponent(anchor)}/versions?limit=100`)
      .then(async (response) => {
        const page = parseReportVersionPage(response);
        const nextVersions = page.items;
        if (!active) return;
        setVersions(nextVersions);
        setVersionCursor(page.next_cursor);
        const latest = nextVersions[0];
        if (!latest) {
          setSelectedVersion(null);
          setError('Esta semana ya no tiene una versión final disponible.');
          return;
        }
        setSelectedVersion(latest.version);
        const reportResponse = await api<unknown>(reportVersionPath(anchor, latest.version));
        if (active && requestId === versionRequestRef.current) {
          setSnapshot(parseAccountantReport(reportResponse));
        }
      })
      .catch((err) => {
        if (active && requestId === versionRequestRef.current) {
          setError(safeError(err, 'No se pudo cargar el reporte final.'));
        }
      })
      .finally(() => {
        if (active && requestId === versionRequestRef.current) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [anchor, isAdmin, periods, user?.id]);

  async function chooseVersion(value: string): Promise<void> {
    if (value === 'preview') {
      versionRequestRef.current += 1;
      setLoading(false);
      setShowPreview(true);
      setSelectedVersion(null);
      setSnapshot(null);
      setError(null);
      return;
    }
    const version = Number(value);
    const weekStart = preview?.week_start ?? anchor;
    setShowPreview(false);
    await loadFinalVersion(weekStart, version);
  }

  async function loadMorePeriods(): Promise<void> {
    if (!periodCursor || loadingMorePeriods) return;
    setLoadingMorePeriods(true);
    try {
      const response = await api<unknown>(
        `/api/reports/weeks?limit=52&cursor=${encodeURIComponent(periodCursor)}`,
      );
      const page = parseReportWeekPage(response);
      const additional = page.items.filter(
        (period) => period.current_version !== null && period.current_version > 0,
      );
      setPeriods((current) => {
        const byWeek = new Map((current ?? []).map((period) => [period.week_start, period]));
        for (const period of additional) byWeek.set(period.week_start, period);
        return [...byWeek.values()].sort((left, right) => right.week_start.localeCompare(left.week_start));
      });
      setPeriodCursor(page.next_cursor);
    } catch (err) {
      toast(safeError(err, 'No se pudieron cargar semanas anteriores.'), 'danger');
    } finally {
      setLoadingMorePeriods(false);
    }
  }

  async function loadMoreVersions(): Promise<void> {
    const weekStart = preview?.week_start ?? anchor;
    if (!versionCursor || loadingMoreVersions) return;
    setLoadingMoreVersions(true);
    try {
      const response = await api<unknown>(
        `/api/reports/week/${encodeURIComponent(weekStart)}/versions?limit=100&cursor=${versionCursor}`,
      );
      const page = parseReportVersionPage(response);
      setVersions((current) => {
        const byVersion = new Map((current ?? []).map((version) => [version.version, version]));
        for (const version of page.items) byVersion.set(version.version, version);
        return [...byVersion.values()].sort((left, right) => right.version - left.version);
      });
      setVersionCursor(page.next_cursor);
    } catch (err) {
      toast(safeError(err, 'No se pudieron cargar versiones anteriores.'), 'danger');
    } finally {
      setLoadingMoreVersions(false);
    }
  }

  function clearOverrideFlow(): void {
    setDeviceHealthConflict(null);
    setOperationalConflict(null);
    setReviewConflict(null);
    setOverrideTarget(null);
    setApprovedOverrides(NO_REPORT_OVERRIDES);
    setOverrideReason('');
    setOverrideConfirmed(false);
    setOverrideError(null);
  }

  async function finalize(
    requested: Partial<ReportOverrides> = {},
    accumulate = true,
  ): Promise<void> {
    if (!preview) return;
    const overrides = mergeReportOverrides(
      accumulate ? approvedOverrides : NO_REPORT_OVERRIDES,
      requested,
    );
    setClosing(true);
    setError(null);
    try {
      await api(`/api/reports/week/${preview.week_start}/finalize`, {
        method: 'POST',
        body: JSON.stringify(reportOverridePayload(overrides, overrideReason)),
      });
      setConfirming(false);
      clearOverrideFlow();
      toast('Semana cerrada y versión final publicada');
      await loadAdmin();
    } catch (err) {
      setConfirming(false);
      const healthConflict = parseDeviceHealthConflict(err);
      const blockerConflict = parseOperationalBlockerConflict(err) ?? parseFinalizationAnomalyConflict(err);
      if (healthConflict && isAdmin) {
        setOperationalConflict(null);
        setReviewConflict(null);
        setDeviceHealthConflict(healthConflict);
        setOverrideTarget('finalize');
        setApprovedOverrides(overrides);
        if (!overrides.device && !overrides.operational) {
          setOverrideReason('');
          setOverrideConfirmed(false);
        }
        setOverrideError(null);
      } else if (blockerConflict && isAdmin) {
        setDeviceHealthConflict(null);
        setReviewConflict(null);
        setOperationalConflict(blockerConflict);
        setOverrideTarget('finalize');
        setApprovedOverrides(overrides);
        if (!overrides.device && !overrides.operational) {
          setOverrideReason('');
          setOverrideConfirmed(false);
        }
        setOverrideError(null);
      } else if (overrides.device || overrides.operational) {
        setOverrideError(safeError(err, 'Error al cerrar con excepción.'));
      } else {
        setError(safeError(err, 'Error al cerrar la semana.'));
      }
    } finally {
      setClosing(false);
    }
  }

  async function changeReviewState(
    action: 'ready-for-review' | 'resume',
    requested: Partial<ReportOverrides> = {},
    accumulate = true,
  ): Promise<void> {
    if (!preview) return;
    const overrides = action === 'ready-for-review'
      ? mergeReportOverrides(
        accumulate ? approvedOverrides : NO_REPORT_OVERRIDES,
        requested,
      )
      : NO_REPORT_OVERRIDES;
    setTransitioning(true);
    setError(null);
    try {
      await api(`/api/reports/week/${preview.week_start}/${action}`, {
        method: 'POST',
        ...(action === 'ready-for-review' ? {
          body: JSON.stringify(reportOverridePayload(overrides, overrideReason)),
        } : {}),
      });
      clearOverrideFlow();
      toast(action === 'ready-for-review' ? 'Semana lista para revisión' : 'Semana devuelta a edición');
      await loadAdmin();
    } catch (err) {
      const conflict = parseReviewBlockerConflict(err);
      const healthConflict = parseDeviceHealthConflict(err);
      if (healthConflict && isAdmin && action === 'ready-for-review') {
        setReviewConflict(null);
        setOperationalConflict(null);
        setDeviceHealthConflict(healthConflict);
        setOverrideTarget('ready');
        setApprovedOverrides(overrides);
        if (!overrides.device && !overrides.operational) {
          setOverrideReason('');
          setOverrideConfirmed(false);
        }
        setOverrideError(null);
      } else if (conflict && isAdmin) {
        setDeviceHealthConflict(null);
        setOperationalConflict(null);
        setReviewConflict(conflict);
        setOverrideTarget('ready');
        setApprovedOverrides(overrides);
        if (!overrides.device && !overrides.operational) {
          setOverrideReason('');
          setOverrideConfirmed(false);
        }
        setOverrideError(null);
      } else if (overrides.device || overrides.operational) {
        setOverrideError(safeError(err, 'No se pudo enviar la semana con excepción.'));
      } else {
        setError(safeError(err, 'No se pudo cambiar el estado de la semana.'));
      }
    } finally {
      setTransitioning(false);
    }
  }

  async function reopen(): Promise<void> {
    if (!preview || preview.status !== 'final') return;
    setReopening(true);
    setReopenError(null);
    try {
      await api(`/api/reports/week/${preview.week_start}/reopen`, {
        method: 'POST',
        body: JSON.stringify({ reason: reopenReason }),
      });
      setReopenModal(false);
      setReopenReason('');
      toast('Semana reabierta; la versión anterior permanece congelada');
      await loadAdmin();
    } catch (err) {
      setReopenError(safeError(err, 'Error al reabrir la semana.'));
    } finally {
      setReopening(false);
    }
  }

  async function download(format: 'xlsx' | 'csv', sheet: 'summary' | 'detail' = 'summary'): Promise<void> {
    if (!snapshot) return;
    try {
      const res = await authenticatedFetch(
        reportExportPath(snapshot.week_start, snapshot.version, format, sheet),
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
        throw new ApiError(res.status, body.error ?? 'No se pudo exportar el reporte.', body.code);
      }
      const blob = await res.blob();
      const disposition = res.headers.get('Content-Disposition') ?? '';
      const name = /filename="([^"]+)"/.exec(disposition)?.[1] ??
        `clockai_${snapshot.week_start}_v${snapshot.version}.${format}`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
      toast(format === 'xlsx' ? 'Excel exacto exportado' : 'CSV exacto exportado');
    } catch (err) {
      toast(legacyExportMessage(err), 'danger');
    }
  }

  const previewTotals = useMemo(() => preview?.employees.reduce(
    (acc, employee) => ({
      days: acc.days + employee.days_worked,
      regular: acc.regular + (employee.regular_seconds ?? employee.regular_minutes * 60),
      overtime: acc.overtime + (employee.overtime_seconds ?? employee.overtime_minutes * 60),
      double: acc.double + (employee.double_time_seconds ?? 0),
      manual: acc.manual + (employee.manual_seconds ?? 0),
      total: acc.total + (employee.total_seconds ?? employee.total_minutes * 60),
    }),
    { days: 0, regular: 0, overtime: 0, double: 0, manual: 0, total: 0 },
  ), [preview]);

  const activePeriod = periods?.find((period) => period.week_start === anchor);
  const displayedStatus = isAdmin
    ? preview?.status
    : snapshot?.period_status ?? activePeriod?.period_status;
  const weekStart = preview?.week_start ?? snapshot?.week_start ?? activePeriod?.week_start;
  const weekEnd = preview?.week_end ?? snapshot?.week_end ?? activePeriod?.week_end;
  const latestVersion = versions?.[0]?.version ?? null;
  const historical = snapshot !== null && (
    snapshot.period_status === 'reopened' || !snapshot.is_current_final ||
    (latestVersion !== null && snapshot.version !== latestVersion)
  );
  const selectedVersionMetadata = versions?.find((version) => version.version === snapshot?.version);
  const hasArtifact = (kind: ReportArtifactKind): boolean =>
    selectedVersionMetadata?.export_formats.includes(kind) === true;
  const canFinalize = isAdmin && preview?.status === 'ready_for_review';

  return (
    <div>
      <PageHeader
        title={isAdmin ? 'Cierre semanal' : 'Horas finalizadas'}
        meta={displayedStatus && <ReportStatus status={displayedStatus} />}
        actions={
          <>
            {isAdmin ? (
              <div className="flex items-center gap-1">
                <Button
                  variant="secondary"
                  size="sm"
                  aria-label="Semana anterior"
                  onClick={() => setAnchor(addDays(preview?.week_start ?? anchor, -7))}
                >
                  <ChevronLeft size={16} strokeWidth={1.5} />
                </Button>
                <span className="tnum min-w-48 text-center text-13 font-medium text-ink-secondary">
                  {weekStart && weekEnd ? `${weekStart} — ${weekEnd}` : '…'}
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  aria-label="Semana siguiente"
                  onClick={() => setAnchor(addDays(preview?.week_start ?? anchor, 7))}
                >
                  <ChevronRight size={16} strokeWidth={1.5} />
                </Button>
              </div>
            ) : periods && periods.length > 0 ? (
              <>
                <label className="flex items-center gap-2 text-13 text-ink-secondary">
                  Semana
                  <select
                    aria-label="Semana finalizada"
                    value={anchor}
                    onChange={(event) => setAnchor(event.target.value)}
                    className="h-8 rounded-control border border-line bg-raised px-3 text-13 font-medium text-ink"
                  >
                    {periods.map((period) => (
                      <option key={period.week_start} value={period.week_start}>
                        {period.week_start} — {period.week_end}
                      </option>
                    ))}
                  </select>
                </label>
                {periodCursor && (
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={loadingMorePeriods}
                    onClick={() => void loadMorePeriods()}
                  >
                    Cargar semanas anteriores
                  </Button>
                )}
              </>
            ) : null}

            {snapshot && (
              <>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={!hasArtifact('xlsx')}
                  title={!hasArtifact('xlsx') ? 'Esta versión no guardó un archivo Excel' : undefined}
                  onClick={() => void download('xlsx')}
                >
                  Exportar Excel
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={!hasArtifact('csv_summary')}
                  title={!hasArtifact('csv_summary') ? 'Esta versión no guardó CSV de resumen' : undefined}
                  onClick={() => void download('csv', 'summary')}
                >
                  CSV resumen
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={!snapshot.detail_available || !hasArtifact('csv_detail')}
                  title={!snapshot.detail_available || !hasArtifact('csv_detail')
                    ? 'Esta versión no guardó CSV de detalle'
                    : undefined}
                  onClick={() => void download('csv', 'detail')}
                >
                  CSV detalle
                </Button>
              </>
            )}

            {isAdmin && preview && (preview.status === 'open' || preview.status === 'reopened') && (
              <Button
                variant="secondary"
                size="sm"
                loading={transitioning}
                onClick={() => {
                  clearOverrideFlow();
                  void changeReviewState('ready-for-review', {}, false);
                }}
              >
                Enviar a revisión
              </Button>
            )}
            {isAdmin && preview?.status === 'ready_for_review' && (
              <Button
                variant="secondary"
                size="sm"
                loading={transitioning}
                onClick={() => {
                  clearOverrideFlow();
                  void changeReviewState('resume', {}, false);
                }}
              >
                Volver a edición
              </Button>
            )}
            {canFinalize && (
              <Button
                variant="danger"
                size="sm"
                onClick={() => {
                  clearOverrideFlow();
                  setConfirming(true);
                }}
              >
                Cerrar semana
              </Button>
            )}
            {isAdmin && preview?.status === 'final' && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setReopenReason('');
                  setReopenError(null);
                  setReopenModal(true);
                }}
              >
                Reabrir semana
              </Button>
            )}
          </>
        }
      />

      {error && (
        <p className="mb-4 rounded-control bg-danger-subtle px-4 py-3 text-13 font-medium text-danger" role="alert">
          {error}
        </p>
      )}

      {historyError && (
        <p className="mb-4 rounded-control bg-warning-subtle px-4 py-3 text-13 text-warning" role="status">
          {historyError}
        </p>
      )}

      {!isAdmin && periods?.length === 0 && !loading && (
        <div className="rounded-card border border-line bg-raised shadow-card">
          <EmptyState
            icon={FileSpreadsheet}
            title="Todavía no hay semanas finalizadas. Cuando el administrador cierre una, aparecerá aquí."
          />
        </div>
      )}

      {isAdmin && preview && (
        <section className="mb-4 rounded-card border border-line bg-raised px-5 py-4 shadow-card">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="text-12 font-semibold uppercase tracking-wide text-ink-tertiary">Vista</p>
              <p className="mt-1 text-14 font-semibold text-ink">
                {showPreview ? 'Horas de trabajo actuales' : `Versión final ${selectedVersion ?? ''}`}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-2 text-13 text-ink-secondary">
                Consultar
                <select
                  value={showPreview ? 'preview' : String(selectedVersion ?? '')}
                  onChange={(event) => void chooseVersion(event.target.value)}
                  className="h-9 rounded-control border border-line bg-sunken px-3 text-13 font-medium text-ink"
                >
                  <option value="preview">Vista de trabajo</option>
                  {(versions ?? []).map((version) => (
                    <option key={version.version} value={version.version}>
                      Versión {version.version} · {fmtDateTime(version.finalized_at)}
                    </option>
                  ))}
                </select>
              </label>
              {versionCursor && (
                <Button
                  variant="secondary"
                  size="sm"
                  loading={loadingMoreVersions}
                  onClick={() => void loadMoreVersions()}
                >
                  Cargar versiones anteriores
                </Button>
              )}
            </div>
          </div>
          <p className="mt-3 max-w-3xl text-13 leading-relaxed text-ink-secondary">
            La vista de trabajo cambia con las correcciones. Cada cierre crea archivos y horas congelados; seleccionar
            una versión nunca mezcla información actual con la que ya recibió contabilidad.
          </p>
        </section>
      )}

      {!isAdmin && versions && versions.length > 0 && (
        <section className="mb-4 rounded-card border border-line bg-raised px-5 py-4 shadow-card">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="text-12 font-semibold uppercase tracking-wide text-ink-tertiary">Versión publicada</p>
              <p className="mt-1 text-14 text-ink-secondary">
                Selecciona exactamente el cierre que quieres conciliar.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-2 text-13 text-ink-secondary">
                Versión
                <select
                  value={selectedVersion ?? ''}
                  onChange={(event) => void loadFinalVersion(anchor, Number(event.target.value))}
                  className="h-9 rounded-control border border-line bg-sunken px-3 text-13 font-semibold text-ink"
                >
                  {versions.map((version) => (
                    <option key={version.version} value={version.version}>
                      v{version.version} · {fmtDateTime(version.finalized_at)}
                    </option>
                  ))}
                </select>
              </label>
              {versionCursor && (
                <Button
                  variant="secondary"
                  size="sm"
                  loading={loadingMoreVersions}
                  onClick={() => void loadMoreVersions()}
                >
                  Cargar versiones anteriores
                </Button>
              )}
            </div>
          </div>
        </section>
      )}

      {isAdmin && preview && preview.anomaly_count > 0 && preview.status !== 'final' && (
        <div className="mb-4 rounded-control bg-warning-subtle px-4 py-3 text-13 text-warning">
          <p className="font-medium">
            {preview.anomaly_count} anomalía(s) sin resolver — revísalas antes de enviar la semana en{' '}
            <Link to="/attendance" className="underline">Asistencia</Link>.
          </p>
          {preview.issues && preview.issues.length > 0 && (
            <ul className="mt-2 list-disc space-y-1 pl-5">
              {preview.issues.slice(0, 8).map((issue, index) => (
                <li key={`${issue.employee_id}-${issue.type}-${index}`}>
                  <span className="font-semibold">#{issue.employee_number} {issue.full_name}:</span>{' '}
                  {issue.detail}
                </li>
              ))}
              {preview.issues.length > 8 && <li>y {preview.issues.length - 8} incidencia(s) más…</li>}
            </ul>
          )}
        </div>
      )}

      {snapshot && (
        <>
          <section className={`mb-4 rounded-card border px-5 py-4 ${historical ? 'border-warning/30 bg-warning-subtle' : 'border-line bg-raised shadow-card'}`}>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-12 font-semibold uppercase tracking-wide text-ink-tertiary">
                  {historical ? 'Versión histórica congelada' : 'Versión final congelada'}
                </p>
                <p className="mt-1 text-14 font-semibold text-ink">
                  Versión {snapshot.version} · cerrada {fmtDateTime(snapshot.finalized_at)}
                </p>
                <p className="tnum mt-1 text-12 text-ink-secondary" title={snapshot.snapshot_hash ?? undefined}>
                  Hash: <code>{shortHash(snapshot.snapshot_hash)}</code> · {snapshot.timezone}
                </p>
              </div>
              <p className="max-w-xl text-13 leading-relaxed text-ink-secondary">
                {historical
                  ? 'La semana fue reabierta o existe un cierre posterior. Estas cifras siguen intactas y no incluyen cambios sin publicar.'
                  : 'Las cifras y los archivos exportados pertenecen al mismo cierre inmutable.'}
              </p>
            </div>
            {!snapshot.detail_available && (
              <p className="mt-3 rounded-control bg-info-subtle px-3 py-2 text-13 text-info">
                Versión de formato anterior: el resumen sigue disponible, pero este cierre no guardó detalle por planta.
              </p>
            )}
          </section>

          <div className="mb-3 flex gap-2" role="tablist" aria-label="Contenido del reporte">
            <Button
              variant={finalTab === 'summary' ? 'primary' : 'secondary'}
              size="sm"
              role="tab"
              aria-selected={finalTab === 'summary'}
              onClick={() => setFinalTab('summary')}
            >
              Resumen
            </Button>
            <Button
              variant={finalTab === 'detail' ? 'primary' : 'secondary'}
              size="sm"
              role="tab"
              aria-selected={finalTab === 'detail'}
              disabled={!snapshot.detail_available}
              onClick={() => setFinalTab('detail')}
            >
              Detalle por día y planta
            </Button>
          </div>

          {finalTab === 'summary' ? (
            snapshot.summary.length === 0 ? (
              <div className="rounded-card border border-line bg-raised shadow-card">
                <EmptyState icon={FileSpreadsheet} title="Sin horas en esta versión." />
              </div>
            ) : (
              <Table>
                <THead>
                  <tr>
                    <TH num>#</TH>
                    <TH>Nombre</TH>
                    <TH>Plantas</TH>
                    <TH num>Hrs reg.</TH>
                    <TH num>OT 1.5×</TH>
                    <TH num>Double 2×</TH>
                    <TH num>Manuales</TH>
                    <TH num>Total hrs</TH>
                  </tr>
                </THead>
                <tbody>
                  {snapshot.summary.map((row) => (
                    <TRow key={row.employee_number}>
                      <TD num className="font-semibold">{row.employee_number}</TD>
                      <TD className="font-medium">{row.name}</TD>
                      <TD className="whitespace-normal">
                        {row.plants.length > 0 ? row.plants.map((plant) => plant.code).join(', ') : '—'}
                      </TD>
                      <TD num>{fmtHours(row.regular_seconds)}</TD>
                      <TD num className={row.overtime_seconds ? 'font-semibold' : 'text-ink-tertiary'}>
                        {fmtHours(row.overtime_seconds)}
                      </TD>
                      <TD num className={row.double_time_seconds ? 'font-semibold' : 'text-ink-tertiary'}>
                        {fmtHours(row.double_time_seconds)}
                      </TD>
                      <TD num className={row.manual_seconds ? 'font-semibold text-accent' : 'text-ink-tertiary'}>
                        {fmtHours(row.manual_seconds)}
                      </TD>
                      <TD num className="font-semibold">{fmtHours(row.total_seconds)}</TD>
                    </TRow>
                  ))}
                </tbody>
                <tfoot>
                  <TFootRow>
                    <TD num>{''}</TD>
                    <TD>Totales ({snapshot.summary.length} empleados)</TD>
                    <TD>{''}</TD>
                    <TD num>{fmtHours(snapshot.totals.regular_seconds)}</TD>
                    <TD num>{fmtHours(snapshot.totals.overtime_seconds)}</TD>
                    <TD num>{fmtHours(snapshot.totals.double_time_seconds)}</TD>
                    <TD num>{fmtHours(snapshot.totals.manual_seconds)}</TD>
                    <TD num>{fmtHours(snapshot.totals.total_seconds)}</TD>
                  </TFootRow>
                </tfoot>
              </Table>
            )
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH num>#</TH>
                  <TH>Nombre</TH>
                  <TH>Fecha</TH>
                  <TH>Planta</TH>
                  <TH>Checadas</TH>
                  <TH num>Comida</TH>
                  <TH num>Reloj</TH>
                  <TH num>Manuales</TH>
                  <TH num>Total</TH>
                  <TH>Indicadores</TH>
                </tr>
              </THead>
              <tbody>
                {snapshot.detail.map((row, index) => (
                  <TRow key={`${row.employee_number}-${row.work_date}-${row.plant.code}-${index}`}>
                    <TD num className="font-semibold">{row.employee_number}</TD>
                    <TD className="font-medium">{row.name}</TD>
                    <TD>{row.work_date}</TD>
                    <TD title={row.plant.name}>{row.plant.code}</TD>
                    <TD className="whitespace-normal"><DetailPunches row={row} /></TD>
                    <TD num>{(row.meal_seconds / 60).toFixed(0)} min</TD>
                    <TD num>{fmtHours(row.clock_seconds)}</TD>
                    <TD num className={row.manual_seconds ? 'font-semibold text-accent' : 'text-ink-tertiary'}>
                      {fmtHours(row.manual_seconds)}
                    </TD>
                    <TD num className="font-semibold">{fmtHours(row.total_seconds)}</TD>
                    <TD className="whitespace-normal">
                      {row.exception_indicators.length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {row.exception_indicators.map((indicator) => (
                            <Badge key={indicator} tone="warning">
                              {ACCOUNTANT_EXCEPTION_LABELS[indicator]}
                            </Badge>
                          ))}
                        </div>
                      ) : (
                        <span className="text-ink-tertiary">—</span>
                      )}
                    </TD>
                  </TRow>
                ))}
              </tbody>
            </Table>
          )}
        </>
      )}

      {isAdmin && showPreview && (loading && !preview ? (
        <TableSkeleton rows={8} cols={9} />
      ) : preview && !preview.employees.length ? (
        <div className="rounded-card border border-line bg-raised shadow-card">
          <EmptyState icon={FileSpreadsheet} title="Sin datos esta semana." />
        </div>
      ) : preview ? (
        <Table>
          <THead>
            <tr>
              <TH num>#</TH>
              <TH>Nombre</TH>
              <TH num>Días</TH>
              <TH num>Hrs reg.</TH>
              <TH num>OT 1.5×</TH>
              <TH num>Double 2×</TH>
              <TH num>Manuales</TH>
              <TH num>Total hrs</TH>
              <TH>{''}</TH>
            </tr>
          </THead>
          <tbody>
            {preview.employees.map((employee) => (
              <Fragment key={employee.employee_id}>
                <TRow>
                  <TD num className="font-semibold">{employee.employee_number}</TD>
                  <TD className="font-medium">{employee.full_name}</TD>
                  <TD num>{employee.days_worked}</TD>
                  <TD num>{fmtHours(employee.regular_seconds ?? employee.regular_minutes * 60)}</TD>
                  <TD num className={employee.overtime_seconds ? 'font-semibold' : 'text-ink-tertiary'}>
                    {fmtHours(employee.overtime_seconds ?? employee.overtime_minutes * 60)}
                  </TD>
                  <TD num className={employee.double_time_seconds ? 'font-semibold' : 'text-ink-tertiary'}>
                    {fmtHours(employee.double_time_seconds ?? 0)}
                  </TD>
                  <TD num className={employee.manual_seconds ? 'font-semibold text-accent' : 'text-ink-tertiary'}>
                    {fmtHours(employee.manual_seconds ?? 0)}
                  </TD>
                  <TD num className="font-semibold">{fmtHours(employee.total_seconds ?? employee.total_minutes * 60)}</TD>
                  <TD className="text-right">
                    <button
                      onClick={() => setExpanded(expanded === employee.employee_id ? null : employee.employee_id)}
                      className="text-13 font-medium text-accent hover:text-accent-hover"
                    >
                      {expanded === employee.employee_id ? 'Ocultar' : 'Días'}
                    </button>
                  </TD>
                </TRow>
                {expanded === employee.employee_id && (
                  <tr className="border-b border-line bg-sunken/60">
                    <td colSpan={9} className="px-6 py-3">
                      <table className="w-full max-w-2xl text-13">
                        <thead>
                          <tr className="text-left text-12 font-semibold uppercase tracking-wide text-ink-secondary">
                            <th className="py-1 pr-4">Fecha</th>
                            <th className="py-1 pr-4 text-right">Entrada</th>
                            <th className="py-1 pr-4 text-right">Salida</th>
                            <th className="py-1 pr-4 text-right">Comida</th>
                            <th className="py-1 pr-4 text-right">Horas</th>
                            <th className="py-1">Estado</th>
                          </tr>
                        </thead>
                        <tbody>
                          {employee.days.map((day) => (
                            <tr key={day.work_date}>
                              <td className="tnum py-1 pr-4">{day.work_date}</td>
                              <td className="tnum py-1 pr-4 text-right">{fmtTime(day.shift_in)}</td>
                              <td className="tnum py-1 pr-4 text-right">{fmtTime(day.shift_out)}</td>
                              <td className="tnum py-1 pr-4 text-right">{day.meal_minutes}m</td>
                              <td className="tnum py-1 pr-4 text-right font-semibold">{fmtHours(day.worked_minutes * 60)}</td>
                              <td className="py-1">
                                <span className="inline-flex gap-1.5">
                                  {day.late && <StatusBadge status="retardo" />}
                                  {!day.complete && <StatusBadge status="incompleto" />}
                                </span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
          {previewTotals && (
            <tfoot>
              <TFootRow>
                <TD num>{''}</TD>
                <TD>Totales ({preview.employees.length} empleados)</TD>
                <TD num>{previewTotals.days}</TD>
                <TD num>{fmtHours(previewTotals.regular)}</TD>
                <TD num>{fmtHours(previewTotals.overtime)}</TD>
                <TD num>{fmtHours(previewTotals.double)}</TD>
                <TD num>{fmtHours(previewTotals.manual)}</TD>
                <TD num>{fmtHours(previewTotals.total)}</TD>
                <TD>{''}</TD>
              </TFootRow>
            </tfoot>
          )}
        </Table>
      ) : null)}

      {!isAdmin && loading && !snapshot && periods?.length !== 0 && <TableSkeleton rows={8} cols={8} />}
      {isAdmin && loading && !showPreview && !snapshot && <TableSkeleton rows={8} cols={8} />}

      {confirming && preview && (
        <Modal
          title={`Cerrar semana ${preview.week_start} — ${preview.week_end}`}
          size="sm"
          onClose={() => setConfirming(false)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setConfirming(false)}>Cancelar</Button>
              <Button variant="danger" loading={closing} onClick={() => void finalize({}, false)}>Cerrar semana</Button>
            </>
          }
        >
          <p className="text-14 text-ink-secondary">
            Se congelarán las horas, nombres de empleado, plantas y archivos de exportación como una nueva versión final.
            Las correcciones posteriores requerirán reabrir y crear otra versión.
          </p>
        </Modal>
      )}

      {isAdmin && reviewConflict && preview && (
        <Modal
          title="La semana necesita revisión"
          size="md"
          onClose={() => { if (!transitioning) clearOverrideFlow(); }}
          footer={
            <>
              <Button variant="secondary" disabled={transitioning} onClick={clearOverrideFlow}>
                Corregir en asistencia
              </Button>
              <Button
                variant="danger"
                loading={transitioning}
                disabled={!canOverrideDeviceHealth({ isAdmin, confirmed: overrideConfirmed, reason: overrideReason })}
                onClick={() => void changeReviewState('ready-for-review', { operational: true })}
              >
                Enviar con excepción
              </Button>
            </>
          }
        >
          <p className="text-14 text-ink-secondary">{reviewConflict.message}</p>
          <p className="mt-2 text-13 text-ink-secondary">
            La validación encontró {Math.max(reviewConflict.anomaly_count, reviewConflict.blockers.length)} incidencia(s).
            Puedes corregirlas o documentar por qué el periodo puede pasar a revisión.
          </p>
          {reviewConflict.blockers.length > 0 && (
            <ul className="mt-4 max-h-48 space-y-2 overflow-auto">
              {reviewConflict.blockers.map((blocker, index) => (
                <li
                  key={`${blocker.code}-${blocker.work_date ?? 'none'}-${index}`}
                  className="rounded-control border border-warning/30 bg-warning-subtle px-3 py-2 text-13"
                >
                  <span className="font-semibold text-ink">{blocker.code}</span>
                  <span className="ml-2 text-ink-secondary">{blocker.work_date ?? 'Sin fecha'}</span>
                </li>
              ))}
            </ul>
          )}
          <Link to="/attendance" className="mt-3 inline-block text-13 font-semibold text-accent hover:underline">
            Abrir asistencia
          </Link>
          <div className="mt-5">
            <Field label="Motivo de la excepción" required error={overrideError}>
              <Textarea
                rows={3}
                value={overrideReason}
                onChange={(event) => setOverrideReason(event.target.value)}
                placeholder="Ej.: Las horas fueron verificadas con el foreman"
              />
            </Field>
            <label className="flex items-start gap-3 rounded-control border border-danger/30 bg-danger-subtle p-3 text-13 text-ink">
              <input
                type="checkbox"
                checked={overrideConfirmed}
                onChange={(event) => setOverrideConfirmed(event.target.checked)}
                className="mt-0.5 h-4 w-4"
              />
              <span>Confirmo que revisé estas incidencias y que el motivo quedará en la auditoría.</span>
            </label>
          </div>
        </Modal>
      )}

      {isAdmin && deviceHealthConflict && preview && (
        <Modal
          title="Dispositivos con salud bloqueante"
          size="md"
          onClose={() => {
            if (!(overrideTarget === 'ready' ? transitioning : closing)) clearOverrideFlow();
          }}
          footer={
            <>
              <Button
                variant="secondary"
                disabled={overrideTarget === 'ready' ? transitioning : closing}
                onClick={clearOverrideFlow}
              >
                {overrideTarget === 'ready' ? 'Cancelar revisión' : 'Cancelar cierre'}
              </Button>
              <Button
                variant="danger"
                loading={overrideTarget === 'ready' ? transitioning : closing}
                disabled={!canOverrideDeviceHealth({ isAdmin, confirmed: overrideConfirmed, reason: overrideReason })}
                onClick={() => {
                  if (overrideTarget === 'ready') {
                    void changeReviewState('ready-for-review', { device: true });
                  } else {
                    void finalize({ device: true });
                  }
                }}
              >
                {overrideTarget === 'ready' ? 'Enviar con excepción' : 'Cerrar con excepción'}
              </Button>
            </>
          }
        >
          <p className="text-14 text-ink-secondary">{deviceHealthConflict.message}</p>
          {deviceHealthConflict.devices.length > 0 ? (
            <ul className="mt-4 space-y-3">
              {deviceHealthConflict.devices.map((device) => (
                <li key={device.id} className="rounded-control border border-warning/30 bg-warning-subtle p-3 text-13">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-semibold text-ink">{device.plant_name} · {device.name}</p>
                    <span className="text-warning">
                      {device.pending_event_count} pendiente(s) · {device.rejected_event_count} rechazada(s)
                    </span>
                  </div>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-ink-secondary">
                    {device.reasons.map((reason) => <li key={reason}>{reason}</li>)}
                  </ul>
                  <p className="mt-2 text-12 text-ink-tertiary">
                    Último heartbeat: {device.last_heartbeat_at ? fmtDateTime(device.last_heartbeat_at) : 'nunca'}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 rounded-control bg-warning-subtle p-3 text-13 text-warning">
              Revisa Configuración → Checadores antes de continuar.
            </p>
          )}
          <div className="mt-5">
            <Field label="Motivo de la excepción" required error={overrideError}>
              <Textarea
                rows={3}
                value={overrideReason}
                onChange={(event) => setOverrideReason(event.target.value)}
                placeholder="Ej.: Se verificaron manualmente las checadas pendientes"
              />
            </Field>
            <label className="flex items-start gap-3 rounded-control border border-danger/30 bg-danger-subtle p-3 text-13 text-ink">
              <input
                type="checkbox"
                checked={overrideConfirmed}
                onChange={(event) => setOverrideConfirmed(event.target.checked)}
                className="mt-0.5 h-4 w-4"
              />
              <span>Confirmo que revisé los dispositivos y el riesgo de checadas aún no sincronizadas.</span>
            </label>
          </div>
        </Modal>
      )}

      {isAdmin && operationalConflict && preview && (
        <Modal
          title="Incidencias operativas bloqueantes"
          size="md"
          onClose={() => { if (!closing) clearOverrideFlow(); }}
          footer={
            <>
              <Button variant="secondary" disabled={closing} onClick={clearOverrideFlow}>
                Corregir antes de cerrar
              </Button>
              <Button
                variant="danger"
                loading={closing}
                disabled={!canOverrideDeviceHealth({ isAdmin, confirmed: overrideConfirmed, reason: overrideReason })}
                onClick={() => void finalize({ operational: true })}
              >
                Cerrar con excepción
              </Button>
            </>
          }
        >
          <p className="text-14 text-ink-secondary">{operationalConflict.message}</p>
          {operationalConflict.blockers.length > 0 ? (
            <ul className="mt-4 max-h-64 space-y-2 overflow-auto">
              {operationalConflict.blockers.map((blocker) => (
                <li
                  key={`${blocker.code}:${blocker.source_key}`}
                  className="rounded-control border border-danger/30 bg-danger-subtle p-3 text-13"
                >
                  <p className="font-semibold text-ink">{blocker.title}</p>
                  <p className="mt-1 text-ink-secondary">{blocker.work_date ?? 'Sin fecha'} · {blocker.code}</p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 rounded-control bg-warning-subtle p-3 text-13 text-warning">
              Abre la bandeja de incidencias para revisar el detalle.
            </p>
          )}
          <Link to="/exceptions" className="mt-3 inline-block text-13 font-semibold text-accent hover:underline">
            Ir a incidencias
          </Link>
          <div className="mt-5">
            <Field label="Motivo de la excepción" required error={overrideError}>
              <Textarea
                rows={3}
                value={overrideReason}
                onChange={(event) => setOverrideReason(event.target.value)}
                placeholder="Ej.: Se validaron las horas contra evidencia externa"
              />
            </Field>
            <label className="flex items-start gap-3 rounded-control border border-danger/30 bg-danger-subtle p-3 text-13 text-ink">
              <input
                type="checkbox"
                checked={overrideConfirmed}
                onChange={(event) => setOverrideConfirmed(event.target.checked)}
                className="mt-0.5 h-4 w-4"
              />
              <span>Confirmo que revisé las incidencias y entiendo que este cierre quedará auditado.</span>
            </label>
          </div>
        </Modal>
      )}

      {reopenModal && preview?.status === 'final' && (
        <Modal
          title={`Reabrir semana ${preview.week_start} — ${preview.week_end}`}
          size="sm"
          onClose={() => setReopenModal(false)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setReopenModal(false)}>Cancelar</Button>
              <Button
                variant="danger"
                loading={reopening}
                disabled={reopenReason.trim().length < 3}
                onClick={() => void reopen()}
              >
                Reabrir semana
              </Button>
            </>
          }
        >
          <p className="mb-4 text-14 text-ink-secondary">
            La versión final seguirá disponible sin cambios. Las correcciones sólo llegarán a contabilidad después de un nuevo cierre.
          </p>
          <Field label="Motivo de reapertura" required error={reopenError}>
            <Textarea
              rows={3}
              value={reopenReason}
              onChange={(event) => setReopenReason(event.target.value)}
              placeholder="Ej.: Se recibió una corrección después del cierre"
              autoFocus
            />
          </Field>
        </Modal>
      )}
    </div>
  );
}
