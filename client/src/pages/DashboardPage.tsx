import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Building2, CalendarCheck } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../hooks/useAuth';
import { fmtDateTime, fmtTime, todayLocal, useAppTimezone } from '../time';
import { PageHeader } from '../components/layout/PageHeader';
import {
  canViewLaborCosts,
  completeCostChangeRatio,
  laborCostDisplay,
  metricChangeRatio,
  parseAdminWeekDashboard,
  parseLaborTrendPage,
  parseOperationsDashboard,
  type AdminWeekDashboard,
  type KioskSyncStatus,
  type LaborTrendPage,
  type OperationsDashboard,
} from '../dashboard/model';
import {
  Badge,
  EmptyState,
  KpiSkeleton,
  Table,
  TableSkeleton,
  TD,
  TH,
  THead,
  TRow,
} from '../components/ui';

const REFRESH_MS = 30_000;

function daysAgo(date: string, days: number): string {
  const result = new Date(`${date}T12:00:00Z`);
  result.setUTCDate(result.getUTCDate() - days);
  return result.toISOString().slice(0, 10);
}

function hours(seconds: number): string {
  return (seconds / 3_600).toFixed(2);
}

function money(decimal: string | null): string {
  if (decimal === null) return 'No calculable';
  const value = Number(decimal);
  if (!Number.isFinite(value)) return 'No calculable';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
}

function percentage(decimal: string): string {
  const value = Number(decimal);
  if (!Number.isFinite(value)) return '—';
  const ratio = value > 1 ? value / 100 : value;
  return new Intl.NumberFormat('es-MX', { style: 'percent', maximumFractionDigits: 1 }).format(ratio);
}

function change(value: number | null): string {
  if (value === null) return 'Sin base comparable';
  const sign = value > 0 ? '+' : '';
  return `${sign}${(value * 100).toFixed(1)}% vs. semana anterior`;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

const SYNC_LABELS: Record<KioskSyncStatus, { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' }> = {
  healthy: { label: 'Sincronizado', tone: 'success' },
  attention: { label: 'Requiere atención', tone: 'warning' },
  offline: { label: 'Sin conexión', tone: 'danger' },
  unknown: { label: 'Sin estado', tone: 'neutral' },
};
const COMPONENT_LABELS = {
  ready: 'lista',
  degraded: 'degradada',
  unavailable: 'no disponible',
  unknown: 'sin dato',
} as const;

export default function DashboardPage() {
  useAppTimezone();
  const user = useAuth();
  const navigate = useNavigate();
  const isAdmin = user ? canViewLaborCosts(user.role) : false;
  const [operations, setOperations] = useState<OperationsDashboard | null>(null);
  const [operationsError, setOperationsError] = useState<string | null>(null);
  const [adminWeek, setAdminWeek] = useState<AdminWeekDashboard | null>(null);
  const [adminError, setAdminError] = useState<string | null>(null);
  const [weeklyTrend, setWeeklyTrend] = useState<LaborTrendPage | null>(null);
  const [monthlyTrend, setMonthlyTrend] = useState<LaborTrendPage | null>(null);
  const [trendError, setTrendError] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);
  const loadingRef = useRef(false);

  const load = useCallback(async () => {
    if (!user || loadingRef.current) return;
    loadingRef.current = true;
    const operationRequest = api<unknown>('/api/dashboard/operations')
      .then((response) => {
        const parsed = parseOperationsDashboard(response);
        setOperations(parsed);
        setOperationsError(null);
        setLastUpdatedAt(parsed.generated_at);
      })
      .catch((error) => {
        setOperationsError(errorMessage(error, 'No se pudo actualizar la operación.'));
      });

    const adminRequests: Promise<unknown>[] = [];
    if (isAdmin) {
      const today = todayLocal();
      adminRequests.push(
        api<unknown>('/api/dashboard/admin/current-week')
          .then((response) => {
            setAdminWeek(parseAdminWeekDashboard(response));
            setAdminError(null);
          })
          .catch((error) => setAdminError(errorMessage(error, 'No se pudieron actualizar horas y costos.'))),
        Promise.all([
          api<unknown>(
            `/api/dashboard/admin/trends?grain=week&from=${daysAgo(today, 98)}&to=${today}&limit=14`,
          ),
          api<unknown>(
            `/api/dashboard/admin/trends?grain=month&from=${daysAgo(today, 400)}&to=${today}&limit=14`,
          ),
        ])
          .then(([weeks, months]) => {
            setWeeklyTrend(parseLaborTrendPage(weeks));
            setMonthlyTrend(parseLaborTrendPage(months));
            setTrendError(null);
          })
          .catch((error) => setTrendError(errorMessage(error, 'No se pudieron actualizar las tendencias.'))),
      );
    } else {
      setAdminWeek(null);
      setWeeklyTrend(null);
      setMonthlyTrend(null);
      setAdminError(null);
      setTrendError(null);
    }

    await Promise.allSettled([operationRequest, ...adminRequests]);
    loadingRef.current = false;
  }, [isAdmin, user?.id]);

  useEffect(() => {
    void load();
    const interval = window.setInterval(() => void load(), REFRESH_MS);
    return () => window.clearInterval(interval);
  }, [load]);

  return (
    <div>
      <PageHeader
        title="Operación"
        meta={
          <span className="text-13 text-ink-tertiary">
            {lastUpdatedAt ? (
              <>actualizado <span className="tnum">{fmtDateTime(lastUpdatedAt)}</span></>
            ) : 'esperando primera actualización'}{' '}
            · cada 30s
          </span>
        }
      />

      {operationsError && (
        <p className="mb-4 rounded-control bg-danger-subtle px-4 py-3 text-13 font-medium text-danger" role="alert">
          No se pudo refrescar la operación: {operationsError}
          {operations && ' Se conservan los últimos datos recibidos.'}
        </p>
      )}

      {!operations ? (
        <>
          <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-6">
            {Array.from({ length: 6 }, (_, index) => <KpiSkeleton key={index} />)}
          </div>
          <TableSkeleton rows={5} cols={8} />
        </>
      ) : (
        <OperationsSection data={operations} navigate={navigate} />
      )}

      {isAdmin && (
        <section className="mt-8 border-t border-line pt-8" aria-labelledby="labor-heading">
          <div className="mb-5">
            <h2 id="labor-heading" className="text-20 font-bold text-ink">Horas y costo directo</h2>
            <p className="mt-1 text-13 text-ink-secondary">
              Vista administrativa. Ningún dato de tasa o costo forma parte del dashboard del foreman.
            </p>
          </div>

          {adminError && (
            <p className="mb-4 rounded-control bg-danger-subtle px-4 py-3 text-13 font-medium text-danger" role="alert">
              {adminError}{adminWeek && ' Se conservan los últimos cálculos disponibles.'}
            </p>
          )}

          {!adminWeek ? (
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              {Array.from({ length: 4 }, (_, index) => <KpiSkeleton key={index} />)}
            </div>
          ) : (
            <AdminLaborSection data={adminWeek} />
          )}

          {trendError && (
            <p className="mt-4 rounded-control bg-warning-subtle px-4 py-3 text-13 text-warning" role="alert">
              {trendError}
            </p>
          )}
          {(weeklyTrend || monthlyTrend) && (
            <TrendSection weekly={weeklyTrend} monthly={monthlyTrend} />
          )}
        </section>
      )}
    </div>
  );
}

function OperationsSection({
  data,
  navigate,
}: {
  data: OperationsDashboard;
  navigate: ReturnType<typeof useNavigate>;
}) {
  return (
    <>
      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4 xl:grid-cols-7">
        <Kpi label="Adentro ahora" value={data.totals.inside} tone="text-success" />
        <Kpi label="En comida" value={data.totals.on_meal} tone="text-info" />
        <Kpi label="Secuencias abiertas" value={data.totals.open_sequences} tone="text-ink" onClick={() => navigate('/attendance')} />
        <Kpi label="Abiertas obsoletas" value={data.totals.stale_open} tone={data.totals.stale_open ? 'text-danger' : 'text-ink'} onClick={() => navigate('/exceptions')} />
        <Kpi label="Identidad por revisar" value={data.totals.identity_reviews_open} tone={data.totals.identity_reviews_open ? 'text-warning' : 'text-ink'} onClick={() => navigate('/identity-reviews')} />
        <Kpi label="Incidencias abiertas" value={data.totals.exceptions_open} tone={data.totals.exceptions_open ? 'text-danger' : 'text-ink'} onClick={() => navigate('/exceptions')} />
        <Kpi label="Kioscos con atención" value={data.totals.devices_attention} tone={data.totals.devices_attention ? 'text-warning' : 'text-ink'} />
      </div>

      <h2 className="mb-3 text-18 font-semibold">Operación ahora por planta</h2>
      {data.plants.length === 0 ? (
        <div className="rounded-card border border-line bg-raised shadow-card">
          <EmptyState icon={Building2} title="No hay plantas permitidas para este usuario." />
        </div>
      ) : (
        <Table>
          <THead>
            <tr>
              <TH>Planta</TH>
              <TH num>Adentro</TH>
              <TH num>En comida</TH>
              <TH num>Secuencias</TH>
              <TH num>Obsoletas</TH>
              <TH num>Identidad</TH>
              <TH num>Bloqueos</TH>
              <TH num>Advertencias</TH>
              <TH>Kioscos / sync</TH>
            </tr>
          </THead>
          <tbody>
            {data.plants.map((plant) => (
              <TRow key={plant.id} flag={plant.exceptions_open.blockers || plant.devices.some((device) => device.sync_status !== 'healthy') ? 'warning' : null}>
                <TD>
                  <span className="font-semibold">{plant.code}</span>
                  <span className="block text-12 text-ink-secondary">{plant.name}</span>
                </TD>
                <TD num className="font-semibold text-success">{plant.workers.inside_count}</TD>
                <TD num className="text-info">{plant.workers.on_meal_count}</TD>
                <TD num>{plant.workers.open_sequences_count}</TD>
                <TD num className={plant.workers.stale_open_count ? 'font-semibold text-danger' : 'text-ink-tertiary'}>
                  {plant.workers.stale_open_count}
                </TD>
                <TD num>{plant.identity_reviews_open}</TD>
                <TD num className={plant.exceptions_open.blockers ? 'font-semibold text-danger' : 'text-ink-tertiary'}>
                  {plant.exceptions_open.blockers}
                </TD>
                <TD num>{plant.exceptions_open.warnings}</TD>
                <TD className="whitespace-normal">
                  <div className="grid min-w-60 gap-2">
                    {plant.devices.length === 0 ? (
                      <span className="text-13 text-ink-tertiary">Sin kiosco registrado</span>
                    ) : plant.devices.map((device) => {
                      const sync = SYNC_LABELS[device.sync_status];
                      return (
                        <div key={device.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-12">
                          <span className="font-semibold text-ink">{device.name}</span>
                          {!device.active && <Badge tone="neutral">Inactivo</Badge>}
                          <Badge tone={sync.tone}>{sync.label}</Badge>
                          <span className="tnum text-ink-secondary">
                            {device.pending_event_count} pend. · {device.rejected_event_count} rech.
                          </span>
                          <span className="w-full text-ink-tertiary">
                            heartbeat {device.last_heartbeat_at ? fmtTime(device.last_heartbeat_at) : 'nunca'} · sync{' '}
                            {device.last_sync_at ? fmtTime(device.last_sync_at) : 'nunca'} · cámara{' '}
                            {COMPONENT_LABELS[device.camera_status]} · almacenamiento {COMPONENT_LABELS[device.storage_status]}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </TD>
              </TRow>
            ))}
          </tbody>
        </Table>
      )}

      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        {data.plants.map((plant) => (
          <article key={plant.id} className="rounded-card border border-line bg-raised p-5 shadow-card">
            <h3 className="text-14 font-semibold text-ink">{plant.code} · personas con secuencia abierta</h3>
            <p className="mt-1 text-12 text-ink-secondary">{plant.name}</p>
            {plant.workers.inside.length === 0 && plant.workers.on_meal.length === 0 && plant.workers.stale_open.length === 0 ? (
              <p className="mt-4 text-13 text-ink-tertiary">Nadie adentro en este momento.</p>
            ) : (
              <ul className="mt-3 divide-y divide-line">
                {[...plant.workers.inside, ...plant.workers.on_meal, ...plant.workers.stale_open].map((worker, index) => (
                  <li key={`${worker.employee_number}-${worker.state}-${index}`} className="flex items-center justify-between gap-3 py-2 text-13">
                    <span>
                      <span className="tnum font-semibold">#{worker.employee_number}</span> {worker.full_name}
                    </span>
                    <span className="flex items-center gap-2">
                      <Badge tone={worker.state === 'stale_open' ? 'danger' : worker.state === 'on_meal' ? 'info' : 'success'}>
                        {worker.state === 'stale_open'
                          ? worker.employee_active === false ? 'Obsoleta · empleado inactivo' : 'Obsoleta · revisar'
                          : worker.state === 'on_meal' ? 'En comida' : 'Adentro'}
                      </Badge>
                      <span className="tnum text-ink-tertiary">{fmtTime(worker.since)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </article>
        ))}
      </div>
    </>
  );
}

function AdminLaborSection({ data }: { data: AdminWeekDashboard }) {
  const hourChange = metricChangeRatio(data.actual, data.previous_week);
  const costChange = completeCostChangeRatio(data.actual, data.previous_week);
  const costDisplay = laborCostDisplay(data.actual);
  const complete = costDisplay.complete;
  return (
    <>
      <div className="mb-4 rounded-control border border-line bg-sunken px-4 py-3 text-13 text-ink-secondary">
        Semana {data.week_start} — {data.week_end} · registrado al <span className="tnum">{fmtDateTime(data.as_of)}</span>.
      </div>
      <div className="mb-5 grid grid-cols-2 gap-4 lg:grid-cols-4 xl:grid-cols-7">
        <MetricCard label="Regulares" value={`${hours(data.actual.seconds.regular)} h`} />
        <MetricCard label="OT 1.5×" value={`${hours(data.actual.seconds.overtime_1_5)} h`} tone={data.actual.seconds.overtime_1_5 ? 'text-warning' : undefined} />
        <MetricCard label="Double 2×" value={`${hours(data.actual.seconds.double_time)} h`} tone={data.actual.seconds.double_time ? 'text-danger' : undefined} />
        <MetricCard label="Manuales" value={`${hours(data.actual.seconds.manual)} h`} tone={data.actual.seconds.manual ? 'text-accent' : undefined} />
        <MetricCard label="Total registrado" value={`${hours(data.actual.seconds.total)} h`} note={change(hourChange)} />
        <MetricCard
          label={complete ? 'Costo directo' : 'Costo completo'}
          value={money(costDisplay.amount)}
          tone={complete ? 'text-ink' : 'text-warning'}
          note={complete ? change(costChange) : `${data.missing_rates} empleado(s) sin tasa`}
        />
        <MetricCard label="Cobertura de tasas" value={percentage(data.actual.coverage_ratio)} note={`${hours(data.actual.seconds.uncosted)} h sin costo`} />
      </div>

      {!complete && (
        <div className="mb-5 rounded-control border border-warning/30 bg-warning-subtle px-4 py-3 text-13 text-warning">
          No se muestra $0 ni un total incompleto como si fuera definitivo. El costo conocido es{' '}
          <span className="font-semibold">{money(costDisplay.known_amount)}</span>, pero faltan tasas para{' '}
          {hours(data.actual.seconds.uncosted)} hora(s).
        </div>
      )}

      <div className="mb-5 grid gap-4 lg:grid-cols-2">
        <article className="rounded-card border border-line bg-raised p-5 shadow-card">
          <h3 className="text-14 font-semibold">Alertas antes de overtime</h3>
          <div className="mt-4 grid grid-cols-3 gap-3">
            <Threshold label="Diario 7–8 h" value={data.thresholds.daily_7_to_8} />
            <Threshold label="Diario 11–12 h" value={data.thresholds.daily_11_to_12} />
            <Threshold label="Semanal 36–40 h" value={data.thresholds.weekly_36_to_40} />
          </div>
          <p className="mt-4 text-12 text-ink-tertiary">
            Bandas alcanzadas: {data.thresholds.daily_at_or_over_8} entre 8 y &lt;11 h diarias ·{' '}
            {data.thresholds.daily_at_or_over_12} ≥12 h diarias · {data.thresholds.weekly_at_or_over_40} ≥40 h semanales.
          </p>
        </article>

        <article className="rounded-card border border-accent/20 bg-accent-subtle p-5">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-14 font-semibold text-ink">Proyección de cierre</h3>
            <Badge tone="accent">Estimación</Badge>
          </div>
          {data.projection ? (
            <>
              <p className="mt-3 font-display text-28 font-bold tnum text-ink">{hours(data.projection.seconds.total)} h</p>
              <p className="mt-1 text-13 text-ink-secondary">
                Costo directo proyectado: {money(data.projection.direct_cost_complete)} · cobertura{' '}
                {percentage(data.projection.coverage_ratio)}.
              </p>
              <p className="mt-3 text-12 text-ink-tertiary">
                Corte {fmtDateTime(data.projection.as_of)} · método: horas registradas más secuencias abiertas transcurridas,
                limitadas a 16 h. Proyección sintética y no pagable; no sustituye el cierre semanal.
              </p>
            </>
          ) : (
            <p className="mt-3 text-13 text-ink-tertiary">Aún no hay base suficiente para proyectar.</p>
          )}
        </article>
      </div>

      <h3 className="mb-3 text-16 font-semibold">Semana actual por planta</h3>
      <Table>
        <THead>
          <tr>
            <TH>Planta</TH>
            <TH num>Regular</TH>
            <TH num>OT 1.5×</TH>
            <TH num>Double 2×</TH>
            <TH num>Manual</TH>
            <TH num>Total</TH>
            <TH num>Cobertura</TH>
            <TH num>Costo directo</TH>
          </tr>
        </THead>
        <tbody>
          {data.plants.map((plant) => (
            <TRow key={plant.id} flag={plant.direct_cost_complete === null ? 'warning' : null}>
              <TD><span className="font-semibold">{plant.code}</span><span className="block text-12 text-ink-secondary">{plant.name}</span></TD>
              <TD num>{hours(plant.seconds.regular)}</TD>
              <TD num>{hours(plant.seconds.overtime_1_5)}</TD>
              <TD num>{hours(plant.seconds.double_time)}</TD>
              <TD num>{hours(plant.seconds.manual)}</TD>
              <TD num className="font-semibold">{hours(plant.seconds.total)}</TD>
              <TD num>{percentage(plant.coverage_ratio)}</TD>
              <TD num className={plant.direct_cost_complete === null ? 'font-semibold text-warning' : 'font-semibold'}>
                {money(plant.direct_cost_complete)}
              </TD>
            </TRow>
          ))}
        </tbody>
      </Table>

      <h3 className="mb-3 mt-6 text-16 font-semibold">Cambios manuales de la semana</h3>
      {data.manual_changes.length === 0 ? (
        <p className="rounded-control bg-sunken px-4 py-3 text-13 text-ink-tertiary">
          No se han agregado horas manuales en esta semana.
        </p>
      ) : (
        <Table>
          <THead>
            <tr>
              <TH num>#</TH>
              <TH>Empleado</TH>
              <TH>Planta</TH>
              <TH>Fecha</TH>
              <TH num>Horas</TH>
              <TH>Registró</TH>
              <TH>Momento</TH>
              <TH>Tipo</TH>
              <TH>Motivo</TH>
            </tr>
          </THead>
          <tbody>
            {data.manual_changes.map((entry, index) => (
              <TRow key={`${entry.employee_number}-${entry.work_date}-${entry.created_at}-${index}`}>
                <TD num className="font-semibold">{entry.employee_number}</TD>
                <TD className="font-medium">{entry.full_name}</TD>
                <TD title={entry.plant_name}>{entry.plant_code}</TD>
                <TD>{entry.work_date}</TD>
                <TD num className="font-semibold text-accent">{hours(entry.duration_seconds)}</TD>
                <TD>{entry.actor_name}</TD>
                <TD>{fmtDateTime(entry.created_at)}</TD>
                <TD>
                  <Badge tone={entry.change_type === 'voided' ? 'neutral' : 'accent'}>
                    {entry.change_type === 'voided' ? 'Anulado' : 'Agregado'}
                  </Badge>
                </TD>
                <TD className="whitespace-normal text-ink-secondary">{entry.reason}</TD>
              </TRow>
            ))}
          </tbody>
        </Table>
      )}

      <p className="mt-4 rounded-control bg-sunken px-4 py-3 text-12 leading-relaxed text-ink-secondary">
        {data.disclaimer} Tampoco incluye deducciones ni otros costos de nómina. Periodos anteriores a la captura completa
        de tasas pueden tener cobertura parcial y no deben interpretarse como costos históricos exactos.
      </p>
    </>
  );
}

function TrendSection({ weekly, monthly }: { weekly: LaborTrendPage | null; monthly: LaborTrendPage | null }) {
  return (
    <div className="mt-6 grid gap-4 xl:grid-cols-2">
      <TrendTable title="Tendencia semanal" page={weekly} />
      <TrendTable title="Semanas agrupadas por mes de inicio" page={monthly} />
    </div>
  );
}

function TrendTable({ title, page }: { title: string; page: LaborTrendPage | null }) {
  return (
    <article className="rounded-card border border-line bg-raised p-5 shadow-card">
      <h3 className="mb-3 text-14 font-semibold">{title}</h3>
      {page?.grain === 'month' && (
        <p className="mb-3 text-12 text-ink-tertiary">
          Agrupa semanas completas por el mes en que empiezan; no representa días calendario exactos del mes.
        </p>
      )}
      {!page || page.items.length === 0 ? (
        <EmptyState icon={CalendarCheck} title="Todavía no hay periodos suficientes." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-13">
            <thead className="text-12 uppercase tracking-wide text-ink-secondary">
              <tr><th className="py-2 text-left">Periodo</th><th className="py-2 text-right">Horas</th><th className="py-2 text-right">Costo</th><th className="py-2 text-right">Cobertura</th></tr>
            </thead>
            <tbody>
              {page.items.map((item) => (
                <tr key={item.period_start} className="border-t border-line">
                  <td className="tnum py-2">
                    {page.grain === 'month'
                      ? `${item.period_start.slice(0, 7)} · por inicio de semana`
                      : `${item.period_start} — ${item.period_end}`}
                    {(item.cost_status === 'unavailable_legacy' || item.cost_status === 'partial_legacy_unavailable') && (
                      <span className="block text-11 text-warning">Sin snapshot de costo</span>
                    )}
                    {(item.cost_status === 'frozen_missing_rates' || item.cost_status === 'live_missing_rates' || item.cost_status === 'partial_missing_rates') && (
                      <span className="block text-11 text-warning">Faltan tasas</span>
                    )}
                  </td>
                  <td className="tnum py-2 text-right font-semibold">{hours(item.seconds.total)}</td>
                  <td className={`tnum py-2 text-right ${item.direct_cost_complete === null ? 'text-warning' : ''}`}>
                    {money(item.direct_cost_complete)}
                  </td>
                  <td className="tnum py-2 text-right">{percentage(item.coverage_ratio)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </article>
  );
}

function Kpi({ label, value, tone, onClick }: { label: string; value: number; tone: string; onClick?: () => void }) {
  const Component = onClick ? 'button' : 'div';
  return (
    <Component
      {...(onClick ? { onClick } : {})}
      className="rounded-card border border-line bg-raised p-4 text-left shadow-card transition-colors duration-150 hover:border-line-strong"
    >
      <span className={`block font-display text-32 font-bold tnum ${tone}`}>{value}</span>
      <span className="mt-1 block text-12 font-medium text-ink-secondary">{label}</span>
    </Component>
  );
}

function MetricCard({ label, value, tone = 'text-ink', note }: { label: string; value: string; tone?: string; note?: string }) {
  return (
    <div className="rounded-card border border-line bg-raised p-4 shadow-card">
      <p className={`font-display text-24 font-bold tnum ${tone}`}>{value}</p>
      <p className="mt-1 text-12 font-medium text-ink-secondary">{label}</p>
      {note && <p className="mt-2 text-11 text-ink-tertiary">{note}</p>}
    </div>
  );
}

function Threshold({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-control bg-sunken p-3 text-center">
      <p className={`font-display text-24 font-bold tnum ${value ? 'text-warning' : 'text-ink'}`}>{value}</p>
      <p className="mt-1 text-11 text-ink-secondary">{label}</p>
    </div>
  );
}
