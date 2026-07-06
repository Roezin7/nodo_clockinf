import { Fragment, useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { WeekReport } from '@clockai/shared';
import { api, ApiError, getStoredAuth } from '../api';
import { useAuth } from '../hooks/useAuth';

function todayLocal(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(new Date());
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const fmtHours = (min: number): string => (min / 60).toFixed(2);

export default function ReportsPage() {
  const user = useAuth();
  const isAdmin = user?.role === 'admin';
  const [anchor, setAnchor] = useState(todayLocal());
  const [report, setReport] = useState<WeekReport | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await api<WeekReport>(`/api/reports/week/${anchor}`);
      setReport(r);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Error al cargar');
    }
  }, [anchor]);

  useEffect(() => {
    setReport(null);
    void load();
  }, [load]);

  async function finalize() {
    if (!report) return;
    if (!confirm(`¿Cerrar la semana ${report.week_start} – ${report.week_end}? El snapshot queda fijo para el contador.`)) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/reports/week/${report.week_start}/finalize`, { method: 'POST' });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Error al cerrar la semana');
    } finally {
      setBusy(false);
    }
  }

  async function download(format: 'xlsx' | 'csv', sheet: 'summary' | 'detail' = 'summary') {
    if (!report) return;
    const auth = getStoredAuth();
    const res = await fetch(`/api/reports/week/${report.week_start}/export?format=${format}&sheet=${sheet}`, {
      headers: { Authorization: `Bearer ${auth?.access_token ?? ''}` },
    });
    if (!res.ok) {
      setError('Error al exportar');
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
  }

  return (
    <div className="p-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold">Reporte semanal</h1>
        {report && (
          <span
            className={`rounded-full px-3 py-1 text-xs font-bold uppercase ${
              report.status === 'final' ? 'bg-ok/10 text-ok' : 'bg-warn/10 text-warn'
            }`}
          >
            {report.status === 'final' ? `Cerrada · ${report.finalized_by}` : 'Borrador (en vivo)'}
          </span>
        )}
        <div className="flex-1" />
        <div className="flex items-center gap-2">
          <button onClick={() => setAnchor(addDays(report?.week_start ?? anchor, -7))} className="rounded-lg border border-line px-3 py-2 text-sm font-bold hover:bg-card">
            ← Anterior
          </button>
          <span className="min-w-52 text-center text-sm font-bold tabular-nums">
            {report ? `${report.week_start} — ${report.week_end}` : '…'}
          </span>
          <button onClick={() => setAnchor(addDays(report?.week_start ?? anchor, 7))} className="rounded-lg border border-line px-3 py-2 text-sm font-bold hover:bg-card">
            Siguiente →
          </button>
        </div>
      </div>

      {error && <p className="mt-4 rounded-lg bg-bad/10 px-4 py-3 text-sm font-semibold text-bad">{error}</p>}

      {report && (
        <>
          {report.anomaly_count > 0 && report.status !== 'final' && (
            <p className="mt-4 rounded-lg bg-warn/10 px-4 py-3 text-sm font-semibold text-warn">
              {report.anomaly_count} anomalía(s) sin resolver — la semana no se puede cerrar hasta corregirlas en{' '}
              <Link to="/attendance" className="underline">Asistencia</Link>.
            </p>
          )}

          <div className="mt-4 flex flex-wrap gap-2">
            {isAdmin && report.status !== 'final' && (
              <button
                onClick={() => void finalize()}
                disabled={busy || report.anomaly_count > 0}
                className="rounded-lg bg-wine-600 px-4 py-2 text-sm font-bold text-white hover:bg-wine-700 disabled:opacity-40"
                title={report.anomaly_count > 0 ? 'Hay anomalías sin resolver' : undefined}
              >
                Cerrar semana
              </button>
            )}
            <button onClick={() => void download('xlsx')} className="rounded-lg border border-line bg-card px-4 py-2 text-sm font-bold hover:bg-surface">
              Exportar Excel
            </button>
            <button onClick={() => void download('csv', 'summary')} className="rounded-lg border border-line bg-card px-4 py-2 text-sm font-bold hover:bg-surface">
              CSV resumen
            </button>
            <button onClick={() => void download('csv', 'detail')} className="rounded-lg border border-line bg-card px-4 py-2 text-sm font-bold hover:bg-surface">
              CSV detalle
            </button>
          </div>

          <div className="mt-4 overflow-x-auto rounded-xl border border-line bg-card">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs font-bold uppercase tracking-wide text-ink-soft">
                  <th className="px-4 py-3">#</th>
                  <th className="px-4 py-3">Nombre</th>
                  <th className="px-4 py-3 text-right">Días</th>
                  <th className="px-4 py-3 text-right">Hrs reg.</th>
                  <th className="px-4 py-3 text-right">Hrs OT</th>
                  <th className="px-4 py-3 text-right">Retardos</th>
                  <th className="px-4 py-3 text-right">Faltas</th>
                  <th className="px-4 py-3 text-right">Total hrs</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {report.employees.map((e) => (
                  <Fragment key={e.employee_id}>
                    <tr className="border-b border-line last:border-0 hover:bg-surface">
                      <td className="px-4 py-2.5 font-bold tabular-nums">{e.employee_number}</td>
                      <td className="px-4 py-2.5 font-semibold">{e.full_name}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{e.days_worked}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{fmtHours(e.regular_minutes)}</td>
                      <td className={`px-4 py-2.5 text-right font-bold tabular-nums ${e.overtime_minutes ? 'text-wine-600' : ''}`}>
                        {fmtHours(e.overtime_minutes)}
                      </td>
                      <td className={`px-4 py-2.5 text-right tabular-nums ${e.lates ? 'font-bold text-warn' : ''}`}>{e.lates}</td>
                      <td className={`px-4 py-2.5 text-right tabular-nums ${e.absences ? 'font-bold text-bad' : ''}`}>{e.absences}</td>
                      <td className="px-4 py-2.5 text-right font-bold tabular-nums">{fmtHours(e.total_minutes)}</td>
                      <td className="px-4 py-2.5 text-right">
                        <button
                          onClick={() => setExpanded(expanded === e.employee_id ? null : e.employee_id)}
                          className="text-xs font-bold text-wine-600 hover:underline"
                        >
                          {expanded === e.employee_id ? 'Ocultar' : 'Días'}
                        </button>
                      </td>
                    </tr>
                    {expanded === e.employee_id && (
                      <tr className="border-b border-line bg-surface/60">
                        <td colSpan={9} className="px-6 py-3">
                          <table className="w-full max-w-2xl text-xs">
                            <thead>
                              <tr className="text-left font-bold text-ink-soft">
                                <th className="py-1 pr-4">Fecha</th>
                                <th className="py-1 pr-4">Entrada</th>
                                <th className="py-1 pr-4">Salida</th>
                                <th className="py-1 pr-4">Comida</th>
                                <th className="py-1 pr-4">Horas</th>
                                <th className="py-1">Flags</th>
                              </tr>
                            </thead>
                            <tbody>
                              {e.days.map((d) => (
                                <tr key={d.work_date}>
                                  <td className="py-1 pr-4 tabular-nums">{d.work_date}</td>
                                  <td className="py-1 pr-4 tabular-nums">
                                    {d.shift_in ? new Date(d.shift_in).toLocaleTimeString('es-MX', { timeZone: 'America/Mexico_City', hour: '2-digit', minute: '2-digit' }) : '—'}
                                  </td>
                                  <td className="py-1 pr-4 tabular-nums">
                                    {d.shift_out ? new Date(d.shift_out).toLocaleTimeString('es-MX', { timeZone: 'America/Mexico_City', hour: '2-digit', minute: '2-digit' }) : '—'}
                                  </td>
                                  <td className="py-1 pr-4 tabular-nums">{d.meal_minutes}m</td>
                                  <td className="py-1 pr-4 font-bold tabular-nums">{fmtHours(d.worked_minutes)}</td>
                                  <td className="py-1">
                                    {d.late && <span className="mr-1 text-warn">retardo</span>}
                                    {!d.complete && <span className="text-bad">incompleto</span>}
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
                {!report.employees.length && (
                  <tr>
                    <td colSpan={9} className="px-4 py-10 text-center text-ink-soft">Sin datos esta semana.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
