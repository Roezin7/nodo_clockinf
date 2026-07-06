import { Fragment, useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft, ChevronRight, FileSpreadsheet } from 'lucide-react';
import type { WeekReport } from '@clockai/shared';
import { api, ApiError, getStoredAuth } from '../api';
import { useAuth } from '../hooks/useAuth';
import { fmtTime, todayLocal, useAppTimezone } from '../time';
import { PageHeader } from '../components/layout/PageHeader';
import {
  Button,
  EmptyState,
  Modal,
  StatusBadge,
  Table,
  TableSkeleton,
  TD,
  TFootRow,
  TH,
  THead,
  TRow,
  useToast,
} from '../components/ui';

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const fmtHours = (min: number): string => (min / 60).toFixed(2);

export default function ReportsPage() {
  useAppTimezone(); // re-render si cambia la zona de la planta
  const user = useAuth();
  const toast = useToast();
  const isAdmin = user?.role === 'admin';
  const [anchor, setAnchor] = useState(todayLocal());
  const [report, setReport] = useState<WeekReport | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [closing, setClosing] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setReport(await api<WeekReport>(`/api/reports/week/${anchor}`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Error al cargar');
    }
  }, [anchor]);

  useEffect(() => {
    setReport(null);
    void load();
  }, [load]);

  async function finalize(): Promise<void> {
    if (!report) return;
    setClosing(true);
    setError(null);
    try {
      await api(`/api/reports/week/${report.week_start}/finalize`, { method: 'POST' });
      setConfirming(false);
      toast('Semana cerrada');
      await load();
    } catch (err) {
      setConfirming(false);
      setError(err instanceof ApiError ? err.message : 'Error al cerrar la semana');
    } finally {
      setClosing(false);
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
      regular: acc.regular + e.regular_minutes,
      ot: acc.ot + e.overtime_minutes,
      lates: acc.lates + e.lates,
      absences: acc.absences + e.absences,
      total: acc.total + e.total_minutes,
    }),
    { days: 0, regular: 0, ot: 0, lates: 0, absences: 0, total: 0 }
  );

  return (
    <div>
      <PageHeader
        title="Reporte semanal"
        meta={report && <StatusBadge status={report.status === 'final' ? 'cerrada' : 'borrador'} />}
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
            {isAdmin && report?.status !== 'final' && (
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
          </>
        }
      />

      {error && (
        <p className="mb-4 rounded-control bg-danger-subtle px-4 py-3 text-13 font-medium text-danger" role="alert">
          {error}
        </p>
      )}

      {report && report.anomaly_count > 0 && report.status !== 'final' && (
        <p className="mb-4 rounded-control bg-warning-subtle px-4 py-3 text-13 font-medium text-warning">
          {report.anomaly_count} anomalía(s) sin resolver — la semana no puede cerrarse hasta corregirlas en{' '}
          <Link to="/attendance" className="underline">
            Asistencia
          </Link>
          .
        </p>
      )}

      {!report ? (
        <TableSkeleton rows={8} cols={8} />
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
              <TH num>Hrs OT</TH>
              <TH num>Retardos</TH>
              <TH num>Faltas</TH>
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
                  <TD num>{fmtHours(e.regular_minutes)}</TD>
                  <TD num className={e.overtime_minutes ? 'font-semibold' : 'text-ink-tertiary'}>
                    {fmtHours(e.overtime_minutes)}
                  </TD>
                  <TD num className={e.lates ? 'font-semibold text-warning' : 'text-ink-tertiary'}>{e.lates}</TD>
                  <TD num className={e.absences ? 'font-semibold text-danger' : 'text-ink-tertiary'}>{e.absences}</TD>
                  <TD num className="font-semibold">{fmtHours(e.total_minutes)}</TD>
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
                <TD num>{fmtHours(totals.regular)}</TD>
                <TD num>{fmtHours(totals.ot)}</TD>
                <TD num>{totals.lates}</TD>
                <TD num>{totals.absences}</TD>
                <TD num>{fmtHours(totals.total)}</TD>
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
            Al cerrar, el cálculo queda <span className="font-semibold text-ink">congelado como snapshot final</span>{' '}
            para el contador y la semana ya no puede volver a cerrarse ni editarse. Las checadas siguen intactas en el
            log, pero este reporte queda fijo.
          </p>
        </Modal>
      )}
    </div>
  );
}
