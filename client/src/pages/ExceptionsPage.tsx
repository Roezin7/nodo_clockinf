import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardCheck,
  ListChecks,
  RefreshCw,
  ShieldAlert,
} from 'lucide-react';
import type { Plant, UserRole } from '@clockai/shared';
import { api, ApiError } from '../api';
import { useAuth } from '../hooks/useAuth';
import { fmtDateTime } from '../time';
import { PageHeader } from '../components/layout/PageHeader';
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Pagination,
  Select,
  Table,
  TableSkeleton,
  TD,
  Textarea,
  TH,
  THead,
  TRow,
  useToast,
} from '../components/ui';
import {
  buildExceptionListPath,
  buildExceptionSummaryPath,
  canViewOperationalExceptions,
  EXCEPTION_CODES,
  EXCEPTION_CODE_LABELS,
  EXCEPTION_EVENT_LABELS,
  EXCEPTION_STATUS_PRESENTATION,
  exceptionActions,
  formatExceptionPlants,
  orderedExceptionEvents,
  transitionReasonError,
  type ExceptionAction,
  type ExceptionCode,
  type ExceptionFilters,
  type ExceptionSeverity,
  type ExceptionStatusFilter,
  type OperationalExceptionDetail,
  type OperationalExceptionListItem,
  type OperationalExceptionPage,
  type OperationalExceptionSummary,
} from '../exceptions/exceptionModel';

const PAGE_SIZE = 50;

const INITIAL_FILTERS: ExceptionFilters = {
  status: 'active',
  severity: '',
  code: '',
  plantId: '',
};

const STATUS_FILTER_LABELS: Record<ExceptionStatusFilter, string> = {
  active: 'Activas',
  open: 'Abiertas',
  acknowledged: 'Reconocidas',
  resolved: 'Resueltas',
  all: 'Todas',
};

const SOURCE_LABELS: Record<OperationalExceptionListItem['source_type'], string> = {
  punch_sequence: 'Secuencia de checadas',
  employee_workday: 'Jornada',
  manual_time: 'Horas manuales',
  identity_session: 'Identidad facial',
  device: 'Checador',
};

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

/**
 * Authorization lives in this wrapper so an unauthorized role never mounts
 * the operational component and therefore never starts its API requests.
 */
export default function ExceptionsPage() {
  const user = useAuth();
  if (!user) return null;
  if (!canViewOperationalExceptions(user.role)) {
    return <Navigate to={user.role === 'accountant' ? '/reports' : '/login'} replace />;
  }
  return <ExceptionsContent role={user.role} />;
}

function ExceptionsContent({ role }: { role: Extract<UserRole, 'admin' | 'foreman'> }) {
  const toast = useToast();
  const [filters, setFilters] = useState<ExceptionFilters>(INITIAL_FILTERS);
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<OperationalExceptionListItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [listError, setListError] = useState<string | null>(null);
  const [summary, setSummary] = useState<OperationalExceptionSummary | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [plants, setPlants] = useState<Plant[]>([]);
  const [plantsError, setPlantsError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<OperationalExceptionDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [transitionError, setTransitionError] = useState<string | null>(null);
  const [transitioning, setTransitioning] = useState<ExceptionAction | null>(null);
  const [olderEventsLoading, setOlderEventsLoading] = useState(false);
  const listRequest = useRef(0);
  const summaryRequest = useRef(0);
  const detailRequest = useRef(0);

  const loadRows = useCallback(async () => {
    const request = ++listRequest.current;
    setRows(null);
    setListError(null);
    try {
      const result = await api<OperationalExceptionPage>(
        buildExceptionListPath(filters, (page - 1) * PAGE_SIZE, PAGE_SIZE),
      );
      if (request !== listRequest.current) return;
      if (result.items.length === 0 && page > 1) {
        setPage((current) => Math.max(1, current - 1));
        return;
      }
      setRows(result.items);
      setTotal(result.total);
    } catch (error) {
      if (request !== listRequest.current) return;
      setRows([]);
      setTotal(0);
      setListError(errorMessage(error, 'No fue posible cargar las incidencias.'));
    }
  }, [filters, page]);

  const loadSummary = useCallback(async () => {
    const request = ++summaryRequest.current;
    setSummary(null);
    setSummaryError(null);
    try {
      const result = await api<OperationalExceptionSummary>(
        buildExceptionSummaryPath(filters.plantId),
      );
      if (request === summaryRequest.current) setSummary(result);
    } catch (error) {
      if (request !== summaryRequest.current) return;
      setSummaryError(errorMessage(error, 'No fue posible cargar el resumen.'));
    }
  }, [filters.plantId]);

  const loadDetail = useCallback(async (exceptionId: string) => {
    const request = ++detailRequest.current;
    setDetailLoading(true);
    setDetailError(null);
    setTransitionError(null);
    try {
      const result = await api<OperationalExceptionDetail>(
        `/api/operational-exceptions/${encodeURIComponent(exceptionId)}`,
      );
      if (request === detailRequest.current) setDetail(result);
    } catch (error) {
      if (request !== detailRequest.current) return;
      setDetail(null);
      setDetailError(errorMessage(error, 'No fue posible cargar el detalle.'));
    } finally {
      if (request === detailRequest.current) setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadRows();
  }, [loadRows]);

  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  useEffect(() => {
    let active = true;
    setPlantsError(null);
    void api<Plant[]>('/api/plants')
      .then((result) => {
        if (active) setPlants(result.filter((plant) => plant.active));
      })
      .catch((error: unknown) => {
        if (active) setPlantsError(errorMessage(error, 'No se pudieron cargar las plantas.'));
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!selectedId) {
      detailRequest.current += 1;
      setDetail(null);
      setDetailError(null);
      setDetailLoading(false);
      return;
    }
    setReason('');
    void loadDetail(selectedId);
  }, [loadDetail, selectedId]);

  function changeFilter<K extends keyof ExceptionFilters>(key: K, value: ExceptionFilters[K]): void {
    setFilters((current) => ({ ...current, [key]: value }));
    setPage(1);
    setSelectedId(null);
  }

  async function transition(action: ExceptionAction): Promise<void> {
    if (!selectedId || !detail) return;
    const validation = transitionReasonError(reason);
    if (validation) {
      setTransitionError(validation);
      return;
    }
    setTransitioning(action);
    setTransitionError(null);
    try {
      await api(`/api/operational-exceptions/${encodeURIComponent(selectedId)}/${action}`, {
        method: 'POST',
        body: JSON.stringify({ reason: reason.trim() }),
      });
      toast(action === 'acknowledge' ? 'Incidencia reconocida' : 'Incidencia resuelta');
      setReason('');
      await Promise.all([loadRows(), loadSummary(), loadDetail(selectedId)]);
    } catch (error) {
      setTransitionError(
        errorMessage(
          error,
          action === 'acknowledge'
            ? 'No fue posible reconocer la incidencia.'
            : 'No fue posible resolver la incidencia.',
        ),
      );
      // A 409 means another user changed the lifecycle. Refreshing makes the
      // current append-only history visible without retrying the mutation.
      if (error instanceof ApiError && error.status === 409) {
        await Promise.all([loadRows(), loadSummary(), loadDetail(selectedId)]);
      }
    } finally {
      setTransitioning(null);
    }
  }

  async function loadOlderEvents(): Promise<void> {
    if (!selectedId || !detail?.events_next_before_sequence || olderEventsLoading) return;
    setOlderEventsLoading(true);
    try {
      const older = await api<OperationalExceptionDetail>(
        `/api/operational-exceptions/${encodeURIComponent(selectedId)}?event_limit=100&event_before_sequence=${detail.events_next_before_sequence}`,
      );
      setDetail((current) => {
        if (!current || current.id !== older.id) return current;
        const merged = new Map(
          [...older.events, ...current.events].map((event) => [event.id, event]),
        );
        return {
          ...current,
          events: orderedExceptionEvents([...merged.values()]),
          events_next_before_sequence: older.events_next_before_sequence,
        };
      });
    } catch (loadError) {
      toast(errorMessage(loadError, 'No fue posible cargar el historial anterior.'), 'danger');
    } finally {
      setOlderEventsLoading(false);
    }
  }

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const activeFilters = Number(Boolean(filters.severity)) + Number(Boolean(filters.code));

  return (
    <div>
      <PageHeader
        title="Incidencias operativas"
        meta={
          summary ? (
            <Badge tone={summary.totals.blockers > 0 ? 'danger' : summary.totals.active > 0 ? 'warning' : 'success'}>
              {summary.totals.active} activas
            </Badge>
          ) : undefined
        }
        actions={
          <Button variant="secondary" size="sm" onClick={() => void Promise.all([loadRows(), loadSummary()])}>
            <RefreshCw size={14} /> Actualizar
          </Button>
        }
      />

      <p className="mb-5 rounded-control border border-info/30 bg-info-subtle px-4 py-3 text-13 text-info">
        Este panel detecta y documenta incidencias. Reconocer o resolver una incidencia no crea, borra ni modifica checadas u horas.
      </p>

      <SummaryCards summary={summary} error={summaryError} onRetry={loadSummary} />

      <section className="mb-5 rounded-card border border-line bg-raised p-4 shadow-card" aria-label="Filtros de incidencias">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <label className="block">
            <span className="mb-1 block text-12 font-semibold uppercase tracking-wide text-ink-secondary">Ciclo de vida</span>
            <Select
              aria-label="Filtrar por ciclo de vida"
              value={filters.status}
              onChange={(event) => changeFilter('status', event.target.value as ExceptionStatusFilter)}
            >
              {Object.entries(STATUS_FILTER_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </Select>
          </label>
          <label className="block">
            <span className="mb-1 block text-12 font-semibold uppercase tracking-wide text-ink-secondary">Severidad</span>
            <Select
              aria-label="Filtrar por severidad"
              value={filters.severity}
              onChange={(event) => changeFilter('severity', event.target.value as ExceptionSeverity | '')}
            >
              <option value="">Todas</option>
              <option value="blocker">Bloqueantes</option>
              <option value="warning">Advertencias</option>
            </Select>
          </label>
          <label className="block">
            <span className="mb-1 block text-12 font-semibold uppercase tracking-wide text-ink-secondary">Tipo</span>
            <Select
              aria-label="Filtrar por tipo"
              value={filters.code}
              onChange={(event) => changeFilter('code', event.target.value as ExceptionCode | '')}
            >
              <option value="">Todos</option>
              {EXCEPTION_CODES.map((code) => (
                <option key={code} value={code}>{EXCEPTION_CODE_LABELS[code]}</option>
              ))}
            </Select>
          </label>
          <label className="block">
            <span className="mb-1 block text-12 font-semibold uppercase tracking-wide text-ink-secondary">Planta</span>
            <Select
              aria-label="Filtrar por planta"
              value={filters.plantId}
              onChange={(event) => changeFilter('plantId', event.target.value)}
            >
              <option value="">{role === 'foreman' ? 'Todas mis plantas' : 'Todas las plantas'}</option>
              {plants.map((plant) => <option key={plant.id} value={plant.id}>{plant.name}</option>)}
            </Select>
            {plantsError && <span className="mt-1 block text-12 text-danger" role="alert">{plantsError}</span>}
          </label>
        </div>
        {activeFilters > 0 && (
          <div className="mt-3 flex justify-end">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setFilters((current) => ({ ...current, severity: '', code: '' }));
                setPage(1);
                setSelectedId(null);
              }}
            >
              Limpiar tipo y severidad
            </Button>
          </div>
        )}
      </section>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(390px,.65fr)]">
        <section aria-label="Lista de incidencias">
          {listError ? (
            <ErrorPanel message={listError} onRetry={loadRows} />
          ) : !rows ? (
            <TableSkeleton rows={8} cols={7} />
          ) : rows.length === 0 ? (
            <div className="rounded-card border border-line bg-raised shadow-card">
              <EmptyState
                icon={ListChecks}
                title="No hay incidencias con estos filtros."
                action={{ label: 'Actualizar', onClick: () => void loadRows() }}
              />
            </div>
          ) : (
            <>
              <Table>
                <THead>
                  <tr>
                    <TH>Severidad</TH>
                    <TH>Incidencia</TH>
                    <TH>Empleado / equipo</TH>
                    <TH>Planta</TH>
                    <TH>Fecha</TH>
                    <TH>Estado</TH>
                    <TH />
                  </tr>
                </THead>
                <tbody>
                  {rows.map((row) => {
                    const presentation = EXCEPTION_STATUS_PRESENTATION[row.status];
                    return (
                      <TRow
                        key={row.id}
                        flag={row.status !== 'resolved' ? (row.severity === 'blocker' ? 'danger' : 'warning') : null}
                        className={selectedId === row.id ? 'bg-accent-subtle/50' : ''}
                      >
                        <TD>
                          <Badge tone={row.severity === 'blocker' ? 'danger' : 'warning'}>
                            {row.severity === 'blocker' ? 'Bloqueante' : 'Advertencia'}
                          </Badge>
                        </TD>
                        <TD className="max-w-64 whitespace-normal">
                          <p className="font-medium">{row.title}</p>
                          <p className="mt-0.5 text-12 text-ink-tertiary">{EXCEPTION_CODE_LABELS[row.code]}</p>
                        </TD>
                        <TD>
                          {row.employee_name ? (
                            <>
                              <p className="font-medium">{row.employee_name}</p>
                              <p className="tnum text-12 text-ink-tertiary">#{row.employee_number}</p>
                            </>
                          ) : (
                            <span className="text-ink-secondary">{SOURCE_LABELS[row.source_type]}</span>
                          )}
                        </TD>
                        <TD className="max-w-48 whitespace-normal text-ink-secondary">{formatExceptionPlants(row.plants)}</TD>
                        <TD num>{row.work_date ?? fmtDateTime(row.occurred_at)}</TD>
                        <TD><Badge tone={presentation.tone}>{presentation.label}</Badge></TD>
                        <TD>
                          <Button variant="secondary" size="sm" onClick={() => setSelectedId(row.id)}>
                            Ver detalle
                          </Button>
                        </TD>
                      </TRow>
                    );
                  })}
                </tbody>
              </Table>
              <Pagination page={page} pageCount={pageCount} onPage={setPage} />
              <p className="mt-2 text-right text-12 text-ink-tertiary">
                Mostrando {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} de {total}
              </p>
            </>
          )}
        </section>

        <aside className="min-h-96 rounded-card border border-line bg-raised shadow-card" aria-label="Detalle de incidencia">
          {!selectedId ? (
            <div className="flex min-h-96 items-center justify-center p-8 text-center text-14 text-ink-tertiary">
              Selecciona una incidencia para ver su evidencia y el historial inmutable.
            </div>
          ) : detailError ? (
            <ErrorPanel message={detailError} onRetry={() => loadDetail(selectedId)} compact />
          ) : detailLoading || !detail ? (
            <div className="min-h-96 animate-pulse bg-sunken/40" aria-label="Cargando detalle" />
          ) : (
            <ExceptionDetailPanel
              detail={detail}
              reason={reason}
              setReason={setReason}
              error={transitionError}
              transitioning={transitioning}
              onTransition={transition}
              onLoadOlderEvents={loadOlderEvents}
              olderEventsLoading={olderEventsLoading}
            />
          )}
        </aside>
      </div>
    </div>
  );
}

function SummaryCards({
  summary,
  error,
  onRetry,
}: {
  summary: OperationalExceptionSummary | null;
  error: string | null;
  onRetry: () => Promise<void>;
}) {
  if (error) {
    return <div className="mb-5"><ErrorPanel message={error} onRetry={onRetry} /></div>;
  }

  const cards = summary
    ? [
        { label: 'Activas', value: summary.totals.active, icon: ClipboardCheck, tone: 'text-ink' },
        { label: 'Bloqueantes', value: summary.totals.blockers, icon: ShieldAlert, tone: 'text-danger' },
        { label: 'Advertencias', value: summary.totals.warnings, icon: AlertTriangle, tone: 'text-warning' },
        { label: 'Resueltas', value: summary.by_status.resolved, icon: CheckCircle2, tone: 'text-success' },
      ]
    : null;

  return (
    <div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Resumen de incidencias">
      {(cards ?? Array.from({ length: 4 }, () => null)).map((card, index) => (
        <div key={card?.label ?? index} className="rounded-card border border-line bg-raised p-4 shadow-card">
          {!card ? (
            <div className="h-12 animate-pulse rounded-control bg-sunken" />
          ) : (
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-12 font-semibold uppercase tracking-wide text-ink-secondary">{card.label}</p>
                <p className={`tnum mt-1 text-24 font-bold ${card.tone}`}>{card.value}</p>
              </div>
              <card.icon size={24} strokeWidth={1.5} className={card.tone} aria-hidden />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function ErrorPanel({
  message,
  onRetry,
  compact = false,
}: {
  message: string;
  onRetry: () => void | Promise<void>;
  compact?: boolean;
}) {
  return (
    <div
      className={`flex ${compact ? 'min-h-96 flex-col justify-center text-center' : 'items-center justify-between'} gap-3 rounded-card border border-danger/40 bg-danger-subtle p-5 text-14 text-danger`}
      role="alert"
    >
      <span>{message}</span>
      <Button variant="secondary" size="sm" onClick={() => void onRetry()}>Reintentar</Button>
    </div>
  );
}

function ExceptionDetailPanel({
  detail,
  reason,
  setReason,
  error,
  transitioning,
  onTransition,
  onLoadOlderEvents,
  olderEventsLoading,
}: {
  detail: OperationalExceptionDetail;
  reason: string;
  setReason: (value: string) => void;
  error: string | null;
  transitioning: ExceptionAction | null;
  onTransition: (action: ExceptionAction) => Promise<void>;
  onLoadOlderEvents: () => Promise<void>;
  olderEventsLoading: boolean;
}) {
  const actions = exceptionActions(detail.status);
  const events = useMemo(() => orderedExceptionEvents(detail.events), [detail.events]);
  const presentation = EXCEPTION_STATUS_PRESENTATION[detail.status];

  return (
    <div>
      <header className="border-b border-line px-5 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={detail.severity === 'blocker' ? 'danger' : 'warning'}>
            {detail.severity === 'blocker' ? 'Bloqueante' : 'Advertencia'}
          </Badge>
          <Badge tone={presentation.tone}>{presentation.label}</Badge>
        </div>
        <h2 className="mt-3 text-18 font-bold">{detail.title}</h2>
        <p className="mt-1 text-13 text-ink-secondary">
          {detail.employee_name
            ? `#${detail.employee_number} · ${detail.employee_name}`
            : SOURCE_LABELS[detail.source_type]}
        </p>
        <p className="mt-1 text-12 text-ink-tertiary">
          {formatExceptionPlants(detail.plants)} · {detail.work_date ?? fmtDateTime(detail.occurred_at)}
        </p>
      </header>

      <div className="space-y-6 px-5 py-5">
        <section>
          <h3 className="mb-2 text-13 font-semibold uppercase tracking-wide text-ink-secondary">Evidencia actual</h3>
          <ExceptionFacts details={detail.details} />
        </section>

        <section>
          <div className="mb-3 flex items-center justify-between gap-3">
            <h3 className="text-13 font-semibold uppercase tracking-wide text-ink-secondary">Historial inmutable</h3>
            <span className="tnum text-12 text-ink-tertiary">
              {events.length}{detail.events_next_before_sequence ? '+' : ''} eventos
            </span>
          </div>
          {events.length === 0 ? (
            <p className="rounded-control bg-warning-subtle p-3 text-13 text-warning">El servidor no devolvió eventos de historial.</p>
          ) : (
            <ol className="space-y-3">
              {events.map((event) => (
                <li key={event.id} className="relative border-l-2 border-line pl-4 text-13">
                  <span className="absolute -left-[5px] top-1 h-2 w-2 rounded-full bg-accent" aria-hidden />
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{EXCEPTION_EVENT_LABELS[event.event_type]}</span>
                    <span className="tnum text-11 text-ink-tertiary">#{event.sequence}</span>
                  </div>
                  <p className="mt-0.5 text-12 text-ink-tertiary">
                    {fmtDateTime(event.created_at)}
                    {event.actor_name ? ` · ${event.actor_name}` : ' · Sistema'}
                  </p>
                  {event.reason && <p className="mt-1 whitespace-pre-wrap text-ink-secondary">{event.reason}</p>}
                </li>
              ))}
            </ol>
          )}
          {detail.events_next_before_sequence && (
            <Button
              className="mt-3 w-full"
              variant="secondary"
              size="sm"
              loading={olderEventsLoading}
              onClick={() => void onLoadOlderEvents()}
            >
              Cargar eventos anteriores
            </Button>
          )}
        </section>

        {actions.length > 0 ? (
          <section className="border-t border-line pt-5">
            <Field
              label="Motivo"
              required
              error={error}
              hint="Quedará registrado en el historial. Mínimo 3 caracteres."
            >
              <Textarea
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                maxLength={2_000}
                placeholder="Describe qué revisaste o cómo se corrigió…"
              />
            </Field>
            <div className="flex flex-wrap justify-end gap-2">
              {actions.includes('acknowledge') && (
                <Button
                  variant="secondary"
                  loading={transitioning === 'acknowledge'}
                  disabled={transitioning !== null}
                  onClick={() => void onTransition('acknowledge')}
                >
                  Reconocer
                </Button>
              )}
              {actions.includes('resolve') && (
                <Button
                  loading={transitioning === 'resolve'}
                  disabled={transitioning !== null}
                  onClick={() => void onTransition('resolve')}
                >
                  Marcar resuelta
                </Button>
              )}
            </div>
            <p className="mt-3 text-12 text-ink-tertiary">
              Reconocer confirma que alguien la está atendiendo. Resolver cierra el seguimiento; ninguna acción cambia las horas.
            </p>
          </section>
        ) : (
          <section className="rounded-control border border-success/30 bg-success-subtle p-4 text-13 text-success">
            <p className="font-semibold">Seguimiento cerrado</p>
            {detail.resolution_reason && <p className="mt-1 whitespace-pre-wrap">{detail.resolution_reason}</p>}
            {detail.resolved_by_name && <p className="mt-1 text-12">Por {detail.resolved_by_name}</p>}
          </section>
        )}

        {(detail.employee_id || detail.source_type === 'identity_session') && (
          <section className="rounded-control border border-line bg-sunken p-4">
            <p className="text-13 font-medium">
              {detail.source_type === 'identity_session'
                ? 'Compara la evidencia desde Revisión de identidad.'
                : 'Si falta corregir una checada, hazlo desde Asistencia diaria.'}
            </p>
            <p className="mt-1 text-12 text-ink-tertiary">
              La decisión o corrección y su motivo conservarán su propio historial.
            </p>
            <Link
              to={detail.source_type === 'identity_session' ? '/identity-reviews' : '/attendance'}
              className="mt-3 inline-flex h-8 items-center rounded-control border border-line bg-raised px-3 text-13 font-medium text-ink hover:bg-sunken"
            >
              {detail.source_type === 'identity_session' ? 'Abrir revisión de identidad' : 'Abrir asistencia diaria'}
            </Link>
          </section>
        )}
      </div>
    </div>
  );
}

const DETAIL_LABELS: Record<string, string> = {
  detail: 'Detalle',
  screening_error: 'Error de revisión',
  meal_number: 'Comida',
  threshold_seconds: 'Límite',
  observed_seconds: 'Valor observado',
  total_worked_seconds: 'Tiempo trabajado',
  review_reason: 'Razón de revisión facial',
  similarity: 'Similitud facial',
  duration_seconds: 'Duración',
  reason_length: 'Longitud del motivo',
  has_creator: 'Usuario identificado',
  device_name: 'Checador',
  reasons: 'Señales detectadas',
  pending_event_count: 'Eventos pendientes',
  rejected_event_count: 'Eventos rechazados',
  last_heartbeat_at: 'Última conexión',
  camera_status: 'Cámara',
  storage_status: 'Almacenamiento',
  clock_skew_seconds: 'Desfase del reloj',
  has_last_error: 'Reportó error',
};

function detailValue(key: string, value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'Sí' : 'No';
  if (typeof value === 'number' && key.endsWith('_seconds')) {
    if (Math.abs(value) >= 3_600) return `${(value / 3_600).toFixed(2)} h`;
    return `${Math.round(value / 60)} min`;
  }
  if (Array.isArray(value)) return value.map((item) => String(item)).join(', ') || '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function ExceptionFacts({ details }: { details: Record<string, unknown> }) {
  const visible = Object.entries(details).filter(([key]) => DETAIL_LABELS[key]);
  if (visible.length === 0) {
    return <p className="rounded-control bg-sunken p-3 text-13 text-ink-secondary">La evidencia está conservada en el historial del servidor.</p>;
  }
  return (
    <dl className="divide-y divide-line rounded-control border border-line bg-sunken/40 px-3">
      {visible.map(([key, value]) => (
        <div key={key} className="grid grid-cols-[minmax(110px,.8fr)_minmax(0,1.2fr)] gap-3 py-2 text-12">
          <dt className="font-medium text-ink-secondary">{DETAIL_LABELS[key]}</dt>
          <dd className="break-words text-right text-ink">{detailValue(key, value)}</dd>
        </div>
      ))}
    </dl>
  );
}
