import { useCallback, useEffect, useMemo, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { CameraOff, ShieldCheck } from 'lucide-react';
import type { Plant, PunchType } from '@clockai/shared';
import { api, ApiError } from '../api';
import { useAuth } from '../hooks/useAuth';
import { fmtDateTime } from '../time';
import { PageHeader } from '../components/layout/PageHeader';
import { groupIdentityAttempts, identityReviewItems } from '../identity/reviewModel';
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Select,
  Table,
  TableSkeleton,
  TD,
  TH,
  THead,
  TRow,
  Textarea,
  useToast,
} from '../components/ui';

type ReviewStatus = 'pending' | 'resolved' | 'all';

interface ReviewListItem {
  session_id: string;
  employee_id: string;
  employee_number: number;
  employee_name: string;
  plant_id: string;
  plant_name: string;
  punch_id: string | null;
  punch_type: PunchType;
  punched_at: string | null;
  review_reason: string | null;
  identity_status: 'identity_review' | 'review_approved' | 'review_rejected';
  session_status: 'pending' | 'verified' | 'review_required';
  provider: string;
  provider_liveness_capable: boolean;
  liveness_status: string;
  similarity: number | string | null;
  attempt_count: number;
  decision_count: number;
  has_attempt_photo: boolean;
  has_enrollment_photo: boolean;
}

interface ReviewAttempt {
  id: string;
  attempt_number: number | null;
  result: string;
  consumes_attempt: boolean;
  captured_at: string;
  similarity: number | string | null;
  liveness_status: string;
  evidence_url?: string | null;
  photo_url?: string | null;
  source_session_id: string;
  semantic_duplicate: boolean;
  source_enrollment_id: string | null;
  source_enrollment_photo_url: string | null;
}

interface ReviewAlias {
  session_id: string;
  status: string;
  review_reason: string | null;
  provider: string;
  liveness_status: string;
  similarity: number | string | null;
  client_event_id: string;
  enrollment_id: string | null;
  enrollment_photo_url: string | null;
  created_at: string;
}

interface ReviewDecision {
  id: string;
  decision: 'approve' | 'reject';
  reason: string;
  decided_by_name?: string | null;
  created_at: string;
}

interface ReviewDetail {
  session: {
    id: string;
    status: 'pending' | 'verified' | 'review_required';
    review_reason: string | null;
    provider: string;
    provider_liveness_capable: boolean;
    liveness_status: string;
    similarity: number | string | null;
    server_started_at: string;
  };
  punch: {
    id: string;
    punched_at: string;
    captured_at: string;
    punch_type: PunchType;
    identity_status: string;
    offline: boolean;
    identity_bypass_reason: string | null;
    photo_url?: string | null;
  };
  employee: {
    id: string;
    employee_number: number;
    full_name: string;
    enrollment_id: string | null;
    enrollment_photo_url: string | null;
  };
  plant: { id: string; name: string };
  device: { id: string; name: string };
  attempts: ReviewAttempt[];
  aliases: ReviewAlias[];
  decisions: ReviewDecision[];
}

const PUNCH_LABELS: Record<PunchType, string> = {
  shift_in: 'Entrada',
  meal_out: 'Salida a comer',
  meal_in: 'Regreso de comer',
  shift_out: 'Salida',
};

const RESULT_LABELS: Record<string, string> = {
  match: 'Coincidencia',
  no_match: 'No coincide',
  no_face: 'Sin rostro',
  multiple_faces: 'Múltiples rostros',
  quality_failed: 'Calidad insuficiente',
  liveness_failed: 'Vivacidad fallida',
  provider_error: 'Error técnico',
  provider_unavailable: 'Proveedor no disponible',
  no_enrollment: 'Sin enrollment',
  review_only: 'Comparación manual',
};

function decisionFor(item: ReviewListItem): 'approve' | 'reject' | null {
  if (item.identity_status === 'review_approved') return 'approve';
  if (item.identity_status === 'review_rejected') return 'reject';
  return null;
}

function photoUrl(value: { evidence_url?: string | null; photo_url?: string | null } | null | undefined): string | null {
  return value?.evidence_url ?? value?.photo_url ?? null;
}

export default function IdentityReviewsPage() {
  const user = useAuth();
  const toast = useToast();
  const [status, setStatus] = useState<ReviewStatus>('pending');
  const [plantId, setPlantId] = useState('');
  const [plants, setPlants] = useState<Plant[]>([]);
  const [rows, setRows] = useState<ReviewListItem[] | null>(null);
  const [listTotal, setListTotal] = useState(0);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ReviewDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [deciding, setDeciding] = useState(false);

  const allowed = user?.role === 'admin' || user?.role === 'foreman';

  const fetchPage = useCallback(async (offset = 0) => {
    const params = new URLSearchParams();
    params.set('status', status);
    params.set('limit', '200');
    params.set('offset', String(offset));
    if (plantId) params.set('plant_id', plantId);
    return api<{ items: ReviewListItem[]; total: number; next_offset: number | null }>(`/api/identity-reviews?${params}`);
  }, [plantId, status]);

  const loadRows = useCallback(async () => {
    setListError(null);
    try {
      const body = await fetchPage(0);
      setRows(identityReviewItems<ReviewListItem>(body));
      setListTotal(body.total);
      setNextOffset(body.next_offset);
    } catch (error) {
      setRows([]);
      setListTotal(0);
      setNextOffset(null);
      setListError(error instanceof ApiError ? error.message : 'No fue posible cargar las revisiones.');
    }
  }, [fetchPage]);

  async function loadMore(): Promise<void> {
    if (nextOffset === null || loadingMore) return;
    setLoadingMore(true);
    setListError(null);
    try {
      const body = await fetchPage(nextOffset);
      const more = identityReviewItems<ReviewListItem>(body);
      setRows((current) => [...(current ?? []), ...more]);
      setListTotal(body.total);
      setNextOffset(body.next_offset);
    } catch (error) {
      setListError(error instanceof ApiError ? error.message : 'No fue posible cargar más revisiones.');
    } finally {
      setLoadingMore(false);
    }
  }

  const loadDetail = useCallback(async (sessionId: string) => {
    setDetailLoading(true);
    setDetailError(null);
    setDecisionError(null);
    try {
      setDetail(await api<ReviewDetail>(`/api/identity-reviews/${encodeURIComponent(sessionId)}`));
    } catch (error) {
      setDetail(null);
      setDetailError(error instanceof ApiError ? error.message : 'No fue posible cargar el detalle.');
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!allowed) return;
    void api<Plant[]>('/api/plants').then(setPlants);
  }, [allowed]);

  useEffect(() => {
    if (!allowed) return;
    setRows(null);
    void loadRows();
  }, [allowed, loadRows]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setDetailError(null);
      return;
    }
    setReason('');
    void loadDetail(selectedId);
  }, [selectedId, loadDetail]);

  const visiblePendingCount = useMemo(
    () => rows?.filter((row) => decisionFor(row) === null).length ?? 0,
    [rows]
  );
  const badgeCount = status === 'pending' ? listTotal : status === 'all' ? visiblePendingCount : listTotal;

  async function decide(decision: 'approve' | 'reject'): Promise<void> {
    if (!selectedId) return;
    if (reason.trim().length < 3) {
      setDecisionError('El motivo debe tener al menos 3 caracteres.');
      return;
    }
    setDeciding(true);
    setDecisionError(null);
    try {
      await api(`/api/identity-reviews/${encodeURIComponent(selectedId)}/decisions`, {
        method: 'POST',
        body: JSON.stringify({ decision, reason: reason.trim() }),
      });
      toast(decision === 'approve' ? 'Identidad aprobada' : 'Identidad rechazada; las horas no se modificaron');
      await Promise.all([loadRows(), loadDetail(selectedId)]);
      setReason('');
    } catch (error) {
      setDecisionError(error instanceof ApiError ? error.message : 'No fue posible guardar la decisión.');
    } finally {
      setDeciding(false);
    }
  }

  if (user && !allowed) return <Navigate to="/reports" replace />;

  return (
    <div>
      <PageHeader
        title="Revisión de identidad"
        meta={
          <Badge tone={status === 'pending' && badgeCount ? 'warning' : 'success'}>
            {status === 'pending'
              ? `${badgeCount} pendientes`
              : status === 'all'
                ? `${listTotal} revisiones · ${visiblePendingCount} pendientes`
                : `${listTotal} resueltas`}
          </Badge>
        }
        actions={
          <>
            <div className="w-48">
              <Select value={plantId} onChange={(event) => setPlantId(event.target.value)} aria-label="Filtrar por planta">
                <option value="">Todas mis plantas</option>
                {plants.map((plant) => <option key={plant.id} value={plant.id}>{plant.name}</option>)}
              </Select>
            </div>
            <div className="w-44">
              <Select value={status} onChange={(event) => setStatus(event.target.value as ReviewStatus)} aria-label="Filtrar por estado">
                <option value="pending">Pendientes</option>
                <option value="resolved">Resueltas</option>
                <option value="all">Todas</option>
              </Select>
            </div>
          </>
        }
      />

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(380px,.8fr)]">
        <div>
          {listError ? (
            <div className="rounded-card border border-danger/40 bg-danger-subtle p-5 text-14 text-danger" role="alert">
              {listError} <Button variant="secondary" size="sm" className="ml-3" onClick={() => void loadRows()}>Reintentar</Button>
            </div>
          ) : !rows ? (
            <TableSkeleton rows={8} cols={7} />
          ) : !rows.length ? (
            <div className="rounded-card border border-line bg-raised shadow-card">
              <EmptyState icon={ShieldCheck} title="No hay revisiones con estos filtros." />
            </div>
          ) : (
            <>
              <Table>
                <THead>
                  <tr>
                    <TH>Empleado</TH>
                    <TH>Planta</TH>
                    <TH>Checada</TH>
                    <TH>Hora</TH>
                    <TH num>Intentos</TH>
                    <TH>Estado</TH>
                    <TH />
                  </tr>
                </THead>
                <tbody>
                  {rows.map((row) => {
                    const decision = decisionFor(row);
                    return (
                      <TRow key={row.session_id} flag={!decision ? 'warning' : null} className={selectedId === row.session_id ? 'bg-accent-subtle/50' : ''}>
                        <TD>
                          <p className="font-medium">{row.employee_name}</p>
                          <p className="tnum text-12 text-ink-tertiary">#{row.employee_number}</p>
                        </TD>
                        <TD className="text-ink-secondary">{row.plant_name}</TD>
                        <TD>{PUNCH_LABELS[row.punch_type]}</TD>
                        <TD num>{row.punched_at ? fmtDateTime(row.punched_at) : '—'}</TD>
                        <TD num>{row.attempt_count}</TD>
                        <TD>
                          {!decision ? (
                            <Badge tone="warning">Pendiente</Badge>
                          ) : decision === 'approve' ? (
                            <Badge tone="success">Aprobada</Badge>
                          ) : (
                            <Badge tone="danger">Rechazada</Badge>
                          )}
                        </TD>
                        <TD>
                          <Button variant="secondary" size="sm" onClick={() => setSelectedId(row.session_id)}>
                            Revisar
                          </Button>
                        </TD>
                      </TRow>
                    );
                  })}
                </tbody>
              </Table>
              {nextOffset !== null && (
                <div className="mt-3 flex items-center justify-between rounded-control border border-warning/40 bg-warning-subtle px-4 py-3 text-13 text-warning">
                  <span>Mostrando {rows.length} de {listTotal}; aún hay revisiones fuera de esta página.</span>
                  <Button variant="secondary" size="sm" loading={loadingMore} onClick={() => void loadMore()}>
                    Cargar siguientes
                  </Button>
                </div>
              )}
            </>
          )}
        </div>

        <aside className="rounded-card border border-line bg-raised shadow-card">
          {!selectedId ? (
            <div className="flex min-h-80 items-center justify-center p-8 text-center text-14 text-ink-tertiary">
              Selecciona una checada para comparar las fotografías y documentar la decisión.
            </div>
          ) : detailError ? (
            <div className="flex min-h-80 flex-col items-center justify-center gap-3 p-8 text-center text-14 text-danger" role="alert">
              <p>{detailError}</p>
              <Button variant="secondary" size="sm" onClick={() => void loadDetail(selectedId)}>
                Reintentar
              </Button>
            </div>
          ) : detailLoading || !detail ? (
            <div className="min-h-80 animate-pulse bg-sunken/40" />
          ) : (
            <ReviewPanel
              detail={detail}
              reason={reason}
              setReason={setReason}
              error={decisionError}
              deciding={deciding}
              onDecision={decide}
            />
          )}
        </aside>
      </div>
    </div>
  );
}

function ReviewPanel({
  detail,
  reason,
  setReason,
  error,
  deciding,
  onDecision,
}: {
  detail: ReviewDetail;
  reason: string;
  setReason: (value: string) => void;
  error: string | null;
  deciding: boolean;
  onDecision: (decision: 'approve' | 'reject') => Promise<void>;
}) {
  const latest = detail.decisions.at(-1) ?? null;
  const enrollmentPhoto = detail.employee.enrollment_photo_url;
  const punchPhoto = detail.punch.photo_url ?? null;
  const attemptGroups = groupIdentityAttempts(detail.attempts, detail.session.id);
  const aliasBySession = new Map(detail.aliases.map((alias) => [alias.session_id, alias]));
  return (
    <div>
      <div className="border-b border-line px-5 py-4">
        <h2 className="text-18 font-bold">{detail.employee.full_name}</h2>
        <p className="mt-1 text-13 text-ink-secondary">
          #{detail.employee.employee_number} · {detail.plant.name} · {PUNCH_LABELS[detail.punch.punch_type]}
        </p>
        <p className="tnum mt-1 text-13 text-ink-tertiary">{fmtDateTime(detail.punch.punched_at ?? detail.session.server_started_at)}</p>
      </div>

      <div className="space-y-6 px-5 py-5">
        <section>
          <h3 className="mb-3 text-13 font-semibold uppercase tracking-wide text-ink-secondary">Comparación visual</h3>
          <div className="grid grid-cols-2 gap-3">
            <EvidencePhoto title="Enrollment vigente" url={enrollmentPhoto} />
            <EvidencePhoto title="Foto final de checada" url={punchPhoto} />
          </div>
          <p className="mt-3 text-12 text-ink-tertiary">
            Proveedor: {detail.session.provider} · Vivacidad:{' '}
            {detail.session.provider_liveness_capable
              ? detail.session.liveness_status
              : 'no disponible con este proveedor'}
          </p>
        </section>

        <section>
          <h3 className="mb-3 text-13 font-semibold uppercase tracking-wide text-ink-secondary">Intentos biométricos</h3>
          {!detail.attempts.length ? (
            <p className="rounded-control bg-warning-subtle p-3 text-13 text-warning">Sin intentos remotos: fallback offline o cámara no disponible.</p>
          ) : (
            <div className="space-y-4">
              {attemptGroups.map((group) => {
                const alias = aliasBySession.get(group.sessionId);
                const aliasNumber = Math.max(
                  1,
                  detail.aliases.findIndex((item) => item.session_id === group.sessionId) + 1
                );
                return (
                  <div key={group.sessionId} className="rounded-control border border-line bg-sunken/30 p-3">
                    <div className="mb-3 flex flex-wrap items-center gap-2 text-12">
                      <Badge tone={group.semanticDuplicate ? 'warning' : 'info'}>
                        {group.semanticDuplicate ? `Evento duplicado ${aliasNumber}` : 'Evento principal'}
                      </Badge>
                      {alias && (
                        <span className="tnum text-ink-tertiary" title={alias.client_event_id}>
                          UUID {alias.client_event_id.slice(0, 8)}… · {alias.provider}
                        </span>
                      )}
                    </div>
                    <div className="space-y-3">
                      {group.attempts.map((attempt) => (
                        <div key={attempt.id} className="grid grid-cols-[88px_1fr] gap-3 rounded-control border border-line bg-raised p-3">
                          <EvidencePhoto compact title={attempt.attempt_number ? `Intento ${attempt.attempt_number}` : 'Evidencia'} url={photoUrl(attempt)} />
                          <div className="min-w-0 text-13">
                            <p className="font-semibold">{RESULT_LABELS[attempt.result] ?? attempt.result}</p>
                            <p className="mt-1 text-ink-secondary">{fmtDateTime(attempt.captured_at)}</p>
                            <p className="mt-1 text-ink-tertiary">
                              {attempt.consumes_attempt ? 'Consumió intento' : 'Evidencia/no consumió intento'}
                              {' · '}Vivacidad: {attempt.liveness_status === 'not_performed' ? 'no realizada' : attempt.liveness_status}
                            </p>
                            {group.semanticDuplicate && attempt.source_enrollment_photo_url && (
                              <a
                                href={attempt.source_enrollment_photo_url}
                                target="_blank"
                                rel="noreferrer"
                                className="mt-1 inline-block font-medium text-accent hover:underline"
                              >
                                Ver enrollment usado por este evento
                              </a>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {latest ? (
          <section className="rounded-control border border-line bg-sunken p-4">
            <div className="flex items-center gap-2">
              <Badge tone={latest.decision === 'approve' ? 'success' : 'danger'}>
                {latest.decision === 'approve' ? 'Aprobada' : 'Rechazada'}
              </Badge>
              <span className="text-12 text-ink-tertiary">{fmtDateTime(latest.created_at)}</span>
            </div>
            <p className="mt-2 text-14">{latest.reason}</p>
            {latest.decided_by_name && <p className="mt-1 text-12 text-ink-tertiary">Por {latest.decided_by_name}</p>}
          </section>
        ) : (
          <section>
            <Field label="Motivo de la decisión" required error={error} hint="La decisión queda en historial y no modifica horas ni pagos.">
              <Textarea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} placeholder="Describe lo que comparaste…" />
            </Field>
            <div className="mt-1 flex justify-end gap-2">
              <Button variant="danger" loading={deciding} onClick={() => void onDecision('reject')}>Rechazar identidad</Button>
              <Button loading={deciding} onClick={() => void onDecision('approve')}>Aprobar identidad</Button>
            </div>
            <p className="mt-3 rounded-control bg-info-subtle p-3 text-12 font-medium text-info">
              Rechazar identidad genera evidencia para investigación; nunca borra ni cambia automáticamente la checada.
            </p>
          </section>
        )}

        {detail.decisions.length > 1 && (
          <section>
            <h3 className="mb-2 text-13 font-semibold uppercase tracking-wide text-ink-secondary">Historial completo</h3>
            <ol className="space-y-2 text-13">
              {detail.decisions.map((decision) => (
                <li key={decision.id} className="border-l-2 border-line pl-3">
                  <span className="font-semibold">{decision.decision === 'approve' ? 'Aprobó' : 'Rechazó'}</span>
                  {' · '}{decision.reason}
                  <span className="ml-1 text-ink-tertiary">{fmtDateTime(decision.created_at)}</span>
                </li>
              ))}
            </ol>
          </section>
        )}
      </div>
    </div>
  );
}

function EvidencePhoto({ title, url, compact = false }: { title: string; url: string | null; compact?: boolean }) {
  return (
    <figure>
      <div className={`flex items-center justify-center overflow-hidden rounded-control border border-line bg-sunken ${compact ? 'h-16 w-20' : 'aspect-[4/3] w-full'}`}>
        {url ? (
          <img src={url} alt={title} className="h-full w-full object-cover" />
        ) : (
          <CameraOff size={compact ? 20 : 30} className="text-ink-tertiary" />
        )}
      </div>
      <figcaption className={`mt-1 font-medium text-ink-secondary ${compact ? 'text-11' : 'text-12'}`}>{title}</figcaption>
    </figure>
  );
}
