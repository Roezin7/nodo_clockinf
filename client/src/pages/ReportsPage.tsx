import { Fragment, useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft, ChevronRight, FileSpreadsheet } from 'lucide-react';
import type { ReportVersionSummary, WeekReport } from '@clockai/shared';
import { api, ApiError, getStoredAuth } from '../api';
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

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const fmtHours = (min: number): string => (min / 60).toFixed(2);
const fmtSeconds = (seconds: number): string => (seconds / 3600).toFixed(2);
const shortHash = (hash: string | undefined): string => (hash ? hash.slice(0, 12) : '—');

function ReportStatus({ status }: { status: WeekReport['status'] }) {
  if (status === 'final') return <StatusBadge status="cerrada" />;
  if (status === 'reopened') return <Badge tone="warning">Reabierta</Badge>;
  if (status === 'open') return <Badge tone="info">Abierta</Badge>;
  return <StatusBadge status="borrador" />;
}

export default function ReportsPage() {
  useAppTimezone(); // re-render si cambia la zona de la planta
  const user = useAuth();
  const toast = useToast();
  const isAdmin = user?.role === 'admin';
  const [anchor, setAnchor] = useState(todayLocal());
  const [report, setReport] = useState<WeekReport | null>(null);
  const [versions, setVersions] = useState<ReportVersionSummary[] | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [closing, setClosing] = useState(false);
  const [reopenModal, setReopenModal] = useState(false);
  const [reopenReason, setReopenReason] = useState('');
  const [reopenError, setReopenError] = useState<string | null>(null);
  const [reopening, setReopening] = useState(false);
  const [deviceHealthConflict, setDeviceHealthConflict] = useState<DeviceHealthConflict | null>(null);
  const [operationalConflict, setOperationalConflict] = useState<OperationalBlockerConflict | null>(null);
  const [approvedDeviceOverride, setApprovedDeviceOverride] = useState(false);
  const [overrideReason, setOverrideReason] = useState('');
  const [overrideConfirmed, setOverrideConfirmed] = useState(false);
  const [overrideError, setOverrideError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const nextReport = await api<WeekReport>(`/api/reports/week/${anchor}`);
      setReport(nextReport);
      try {
        setVersions(
          await api<ReportVersionSummary[]>(`/api/reports/week/${nextReport.week_start}/versions`)
        );
      } catch (err) {
        setVersions([]);
        setError(err instanceof ApiError ? `Reporte cargado, pero no se pudo cargar el historial: ${err.message}` : 'No se pudo cargar el historial de versiones');
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Error al cargar');
    }
  }, [anchor]);

  useEffect(() => {
    setReport(null);
    setVersions(null);
    void load();
  }, [load]);

  async function finalize(overrides: { device?: boolean; operational?: boolean } = {}): Promise<void> {
    if (!report) return;
    setClosing(true);
    setError(null);
    try {
      await api(`/api/reports/week/${report.week_start}/finalize`, {
        method: 'POST',
        body: JSON.stringify({
          ...(overrides.device ? { override_device_health: true } : {}),
          ...(overrides.operational ? { override_operational_blockers: true } : {}),
          ...(overrides.device || overrides.operational ? { reason: overrideReason.trim() } : {}),
        }),
      });
      setConfirming(false);
      setDeviceHealthConflict(null);
      setOperationalConflict(null);
      setApprovedDeviceOverride(false);
      setOverrideReason('');
      setOverrideConfirmed(false);
      setOverrideError(null);
      toast('Semana cerrada');
      await load();
    } catch (err) {
      setConfirming(false);
      const healthConflict = parseDeviceHealthConflict(err);
      const blockerConflict = parseOperationalBlockerConflict(err);
      if (healthConflict && isAdmin) {
        setOperationalConflict(null);
        setDeviceHealthConflict(healthConflict);
        setOverrideReason('');
        setOverrideConfirmed(false);
        setOverrideError(null);
      } else if (blockerConflict && isAdmin) {
        setDeviceHealthConflict(null);
        setOperationalConflict(blockerConflict);
        setApprovedDeviceOverride(Boolean(overrides.device));
        if (!overrides.device) {
          setOverrideReason('');
          setOverrideConfirmed(false);
        }
        setOverrideError(null);
      } else if (overrides.device || overrides.operational) {
        setOverrideError(err instanceof ApiError ? err.message : 'Error al cerrar con excepción');
      } else {
        setError(err instanceof ApiError ? err.message : 'Error al cerrar la semana');
      }
    } finally {
      setClosing(false);
    }
  }

  async function reopen(): Promise<void> {
    if (!report || report.status !== 'final') return;
    setReopening(true);
    setReopenError(null);
    try {
      await api(`/api/reports/week/${report.week_start}/reopen`, {
        method: 'POST',
        body: JSON.stringify({ reason: reopenReason }),
      });
      setReopenModal(false);
      setReopenReason('');
      toast('Semana reabierta');
      await load();
    } catch (err) {
      setReopenError(err instanceof ApiError ? err.message : 'Error al reabrir la semana');
    } finally {
      setReopening(false);
    }
  }

  async function download(format: 'xlsx' | 'csv', sheet: 'summary' | 'detail' = 'summary'): Promise<void> {
    if (!report) return;
    const auth = getStoredAuth();
    const res = await fetch(`/api/reports/week/${report.week_start}/export?format=${format}&sheet=${sheet}`, {
      headers: { Authorization: `Bearer ${auth?.access_token ?? ''}` },
    });
    if (!res.ok) {
      toast('No se pudo exportar el reporte', 'danger');
      return;
    }
    const blob = await res.blob();
    const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? `reporte.${format}`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
    toast(format === 'xlsx' ? 'Excel exportado' : 'CSV exportado');
  }

  const totals = report?.employees.reduce(
    (acc, e) => ({
      days: acc.days + e.days_worked,
      regular: acc.regular + (e.regular_seconds ?? e.regular_minutes * 60),
      ot: acc.ot + (e.overtime_seconds ?? e.overtime_minutes * 60),
      double: acc.double + (e.double_time_seconds ?? 0),
      manual: acc.manual + (e.manual_seconds ?? 0),
      total: acc.total + (e.total_seconds ?? e.total_minutes * 60),
    }),
    { days: 0, regular: 0, ot: 0, double: 0, manual: 0, total: 0 }
  );
  const latestVersion = versions?.[0];
  const displayedVersion = report?.version ?? latestVersion?.version;
  const displayedHash = report?.snapshot_hash ?? latestVersion?.snapshot_hash;
  const canFinalize =
    isAdmin &&
    report !== null &&
    (report.status === 'open' || report.status === 'reopened' || report.status === 'draft');

  return (
    <div>
      <PageHeader
        title="Reporte semanal"
        meta={report && <ReportStatus status={report.status} />}
        actions={
          <>
            <div className="flex items-center gap-1">
              <Button
                variant="secondary"
                size="sm"
                aria-label="Semana anterior"
                onClick={() => setAnchor(addDays(report?.week_start ?? anchor, -7))}
              >
                <ChevronLeft size={16} strokeWidth={1.5} />
              </Button>
              <span className="tnum min-w-48 text-center text-13 font-medium text-ink-secondary">
                {report ? `${report.week_start} — ${report.week_end}` : '…'}
              </span>
              <Button
                variant="secondary"
                size="sm"
                aria-label="Semana siguiente"
                onClick={() => setAnchor(addDays(report?.week_start ?? anchor, 7))}
              >
                <ChevronRight size={16} strokeWidth={1.5} />
              </Button>
            </div>
            <Button variant="secondary" size="sm" onClick={() => void download('xlsx')}>
              Exportar Excel
            </Button>
            <Button variant="secondary" size="sm" onClick={() => void download('csv', 'summary')}>
              CSV resumen
            </Button>
            <Button variant="secondary" size="sm" onClick={() => void download('csv', 'detail')}>
              CSV detalle
            </Button>
            {canFinalize && (
              <Button
                variant="danger"
                size="sm"
                disabled={!report || report.anomaly_count > 0}
                title={report && report.anomaly_count > 0 ? 'Hay anomalías sin resolver' : undefined}
                onClick={() => setConfirming(true)}
              >
                Cerrar semana
              </Button>
            )}
            {isAdmin && report?.status === 'final' && (
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

      {report && report.anomaly_count > 0 && report.status !== 'final' && (
        <div className="mb-4 rounded-control bg-warning-subtle px-4 py-3 text-13 text-warning">
          <p className="font-medium">
            {report.anomaly_count} anomalía(s) sin resolver — la semana no puede cerrarse hasta corregirlas en{' '}
            <Link to="/attendance" className="underline">
              Asistencia
            </Link>
            .
          </p>
          {report.issues && report.issues.length > 0 && (
            <ul className="mt-2 list-disc space-y-1 pl-5">
              {report.issues.slice(0, 8).map((issue, index) => (
                <li key={`${issue.employee_id}-${issue.type}-${index}`}>
                  <span className="font-semibold">#{issue.employee_number} {issue.full_name}:</span>{' '}
                  {issue.detail}
                </li>
              ))}
              {report.issues.length > 8 && <li>y {report.issues.length - 8} incidencia(s) más…</li>}
            </ul>
          )}
        </div>
      )}

      {report && (
        <section className="mb-4 rounded-card border border-line bg-raised px-5 py-4 shadow-card">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-12 font-semibold uppercase tracking-wide text-ink-tertiary">
                {report.status === 'final' ? 'Snapshot actual' : 'Último snapshot final'}
              </p>
              <p className="mt-1 text-14 font-semibold text-ink">
                {displayedVersion ? `Versión ${displayedVersion}` : 'Aún no existe una versión final'}
              </p>
              <p className="tnum mt-1 text-12 text-ink-secondary" title={displayedHash}>
                Hash: <code>{shortHash(displayedHash)}</code>
              </p>
            </div>
            <p className="max-w-xl text-13 leading-relaxed text-ink-secondary">
              Cada cierre crea un snapshot inmutable con su propio hash. Reabrir permite preparar una versión nueva,
              pero nunca modifica ni elimina las versiones que la contadora ya pudo consultar.
            </p>
          </div>

          <div className="mt-4 border-t border-line pt-3">
            <p className="mb-2 text-12 font-semibold uppercase tracking-wide text-ink-secondary">
              Historial de versiones
            </p>
            {versions === null ? (
              <p className="text-13 text-ink-tertiary">Cargando historial…</p>
            ) : versions.length === 0 ? (
              <p className="text-13 text-ink-tertiary">Esta semana todavía no tiene snapshots finales.</p>
            ) : (
              <div className="grid gap-2">
                {versions.map((version) => (
                  <div
                    key={version.id}
                    className="flex flex-wrap items-center justify-between gap-x-5 gap-y-1 rounded-control bg-sunken px-3 py-2 text-13"
                  >
                    <span className="font-semibold text-ink">Versión {version.version}</span>
                    <span className="text-ink-secondary">
                      {fmtDateTime(version.finalized_at)} · {version.finalized_by_name}
                    </span>
                    <code className="tnum text-12 text-ink-tertiary" title={version.snapshot_hash}>
                      {shortHash(version.snapshot_hash)}
                    </code>
                    {version.finalization_reason && (
                      <span className="w-full text-12 text-ink-tertiary">Motivo: {version.finalization_reason}</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      )}

      {!report ? (
        <TableSkeleton rows={8} cols={9} />
      ) : !report.employees.length ? (
        <div className="rounded-card border border-line bg-raised shadow-card">
          <EmptyState icon={FileSpreadsheet} title="Sin datos esta semana." />
        </div>
      ) : (
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
            {report.employees.map((e) => (
              <Fragment key={e.employee_id}>
                <TRow>
                  <TD num className="font-semibold">{e.employee_number}</TD>
                  <TD className="font-medium">{e.full_name}</TD>
                  <TD num>{e.days_worked}</TD>
                  <TD num>{fmtSeconds(e.regular_seconds ?? e.regular_minutes * 60)}</TD>
                  <TD num className={e.overtime_seconds ? 'font-semibold' : 'text-ink-tertiary'}>
                    {fmtSeconds(e.overtime_seconds ?? e.overtime_minutes * 60)}
                  </TD>
                  <TD num className={e.double_time_seconds ? 'font-semibold' : 'text-ink-tertiary'}>
                    {fmtSeconds(e.double_time_seconds ?? 0)}
                  </TD>
                  <TD num className={e.manual_seconds ? 'font-semibold text-accent' : 'text-ink-tertiary'}>
                    {fmtSeconds(e.manual_seconds ?? 0)}
                  </TD>
                  <TD num className="font-semibold">{fmtSeconds(e.total_seconds ?? e.total_minutes * 60)}</TD>
                  <TD className="text-right">
                    <button
                      onClick={() => setExpanded(expanded === e.employee_id ? null : e.employee_id)}
                      className="text-13 font-medium text-accent hover:text-accent-hover"
                    >
                      {expanded === e.employee_id ? 'Ocultar' : 'Días'}
                    </button>
                  </TD>
                </TRow>
                {expanded === e.employee_id && (
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
                          {e.days.map((d) => (
                            <tr key={d.work_date}>
                              <td className="tnum py-1 pr-4">{d.work_date}</td>
                              <td className="tnum py-1 pr-4 text-right">{fmtTime(d.shift_in)}</td>
                              <td className="tnum py-1 pr-4 text-right">{fmtTime(d.shift_out)}</td>
                              <td className="tnum py-1 pr-4 text-right">{d.meal_minutes}m</td>
                              <td className="tnum py-1 pr-4 text-right font-semibold">{fmtHours(d.worked_minutes)}</td>
                              <td className="py-1">
                                <span className="inline-flex gap-1.5">
                                  {d.late && <StatusBadge status="retardo" />}
                                  {!d.complete && <StatusBadge status="incompleto" />}
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
          {totals && (
            <tfoot>
              <TFootRow>
                <TD num>{''}</TD>
                <TD>Totales ({report.employees.length} empleados)</TD>
                <TD num>{totals.days}</TD>
                <TD num>{fmtSeconds(totals.regular)}</TD>
                <TD num>{fmtSeconds(totals.ot)}</TD>
                <TD num>{fmtSeconds(totals.double)}</TD>
                <TD num>{fmtSeconds(totals.manual)}</TD>
                <TD num>{fmtSeconds(totals.total)}</TD>
                <TD>{''}</TD>
              </TFootRow>
            </tfoot>
          )}
        </Table>
      )}

      {confirming && report && (
        <Modal
          title={`Cerrar semana ${report.week_start} — ${report.week_end}`}
          size="sm"
          onClose={() => setConfirming(false)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setConfirming(false)}>
                Cancelar
              </Button>
              <Button variant="danger" loading={closing} onClick={() => void finalize()}>
                Cerrar semana
              </Button>
            </>
          }
        >
          <p className="text-14 text-ink-secondary">
            Al cerrar, el cálculo queda <span className="font-semibold text-ink">congelado como un snapshot final</span>{' '}
            con número de versión y hash. Si después se reabre la semana, este snapshot permanece intacto y el siguiente
            cierre generará una versión nueva.
          </p>
        </Modal>
      )}

      {isAdmin && deviceHealthConflict && report && (
        <Modal
          title="Dispositivos con salud bloqueante"
          size="md"
          onClose={() => {
            if (!closing) setDeviceHealthConflict(null);
          }}
          footer={
            <>
              <Button variant="secondary" disabled={closing} onClick={() => setDeviceHealthConflict(null)}>
                Cancelar cierre
              </Button>
              <Button
                variant="danger"
                loading={closing}
                disabled={!canOverrideDeviceHealth({ isAdmin, confirmed: overrideConfirmed, reason: overrideReason })}
                onClick={() => void finalize({ device: true })}
              >
                Cerrar con excepción
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
              El servidor no devolvió el desglose; revisa Configuración → Checadores antes de continuar.
            </p>
          )}

          <div className="mt-5">
            <Field label="Motivo de la excepción" required error={overrideError}>
              <Textarea
                rows={3}
                value={overrideReason}
                onChange={(event) => setOverrideReason(event.target.value)}
                placeholder="Ej.: Se verificaron manualmente las checadas pendientes con el foreman"
              />
            </Field>
            <label className="flex items-start gap-3 rounded-control border border-danger/30 bg-danger-subtle p-3 text-13 text-ink">
              <input
                type="checkbox"
                checked={overrideConfirmed}
                onChange={(event) => setOverrideConfirmed(event.target.checked)}
                className="mt-0.5 h-4 w-4"
              />
              <span>
                Confirmo que revisé estos dispositivos y entiendo que cerrar ahora puede dejar fuera checadas que aún no
                se han sincronizado.
              </span>
            </label>
          </div>
        </Modal>
      )}

      {isAdmin && operationalConflict && report && (
        <Modal
          title="Incidencias operativas bloqueantes"
          size="md"
          onClose={() => {
            if (!closing) setOperationalConflict(null);
          }}
          footer={
            <>
              <Button variant="secondary" disabled={closing} onClick={() => setOperationalConflict(null)}>
                Corregir antes de cerrar
              </Button>
              <Button
                variant="danger"
                loading={closing}
                disabled={!canOverrideDeviceHealth({ isAdmin, confirmed: overrideConfirmed, reason: overrideReason })}
                onClick={() => void finalize({
                  device: approvedDeviceOverride,
                  operational: true,
                })}
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
                  <p className="mt-1 text-ink-secondary">
                    {blocker.work_date ?? 'Sin fecha'} · {blocker.code}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 rounded-control bg-warning-subtle p-3 text-13 text-warning">
              Abre la bandeja de incidencias para revisar el detalle antes de continuar.
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
                placeholder="Ej.: Se validaron las horas contra evidencia externa y se corregirá el origen"
              />
            </Field>
            <label className="flex items-start gap-3 rounded-control border border-danger/30 bg-danger-subtle p-3 text-13 text-ink">
              <input
                type="checkbox"
                checked={overrideConfirmed}
                onChange={(event) => setOverrideConfirmed(event.target.checked)}
                className="mt-0.5 h-4 w-4"
              />
              <span>
                Confirmo que revisé cada incidencia y entiendo que el snapshot conservará este cierre y su motivo en la auditoría.
              </span>
            </label>
          </div>
        </Modal>
      )}

      {reopenModal && report?.status === 'final' && (
        <Modal
          title={`Reabrir semana ${report.week_start} — ${report.week_end}`}
          size="sm"
          onClose={() => setReopenModal(false)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setReopenModal(false)}>
                Cancelar
              </Button>
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
            La versión {displayedVersion ?? 'actual'} seguirá disponible como snapshot inmutable. Los cambios posteriores
            se incluirán únicamente cuando el admin vuelva a cerrar la semana y genere otra versión.
          </p>
          <Field label="Motivo de reapertura" required error={reopenError}>
            <Textarea
              rows={3}
              value={reopenReason}
              onChange={(event) => setReopenReason(event.target.value)}
              placeholder="Ej.: Se recibió una corrección de horas después del cierre"
              autoFocus
            />
          </Field>
        </Modal>
      )}
    </div>
  );
}
