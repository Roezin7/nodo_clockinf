import { useCallback, useEffect, useMemo, useState } from 'react';
import { Camera, DollarSign, Users } from 'lucide-react';
import { Navigate } from 'react-router-dom';
import type { Shift } from '@clockai/shared';
import { api, ApiError } from '../api';
import { useAuth } from '../hooks/useAuth';
import { todayLocal } from '../time';
import PunchHistoryModal from '../components/PunchHistoryModal';
import CameraCapture from '../components/CameraCapture';
import { PageHeader } from '../components/layout/PageHeader';
import {
  biometricEnrollmentState,
  canAccessEmployees,
  canViewBiometricEnrollment,
} from '../employees/visibility';
import {
  canViewEmployeeRates,
  initialRateError,
  initialRatePayload,
  parseEmployeeAdminDetail,
  parseEmployeeList,
  parseEmployeeRates,
  rateChangeError,
  type EmployeeAdminDetail,
  type EmployeeListItem,
  type EmployeeRateHistory,
} from '../employees/model';
import {
  Button,
  Badge,
  EmptyState,
  Field,
  Input,
  Modal,
  Pagination,
  Select,
  StatusBadge,
  Table,
  TableSkeleton,
  TD,
  TH,
  THead,
  Textarea,
  TRow,
  useToast,
  type SortDir,
} from '../components/ui';

interface CreatedEmployee {
  id: string;
  employee_number: number;
  full_name: string;
  pin?: string;
}

interface FormState {
  full_name: string;
  social_security: string;
  phone: string;
  default_shift_id: string;
  hired_at: string;
  initial_hourly_rate: string;
  rate_effective_from: string;
}

interface RateFormState {
  hourly_rate: string;
  effective_from: string;
  reason: string;
}

const EMPTY_FORM = (): FormState => ({
  full_name: '',
  social_security: '',
  phone: '',
  default_shift_id: '',
  hired_at: '',
  initial_hourly_rate: '',
  rate_effective_from: todayLocal(),
});
const EMPTY_RATE_FORM = (): RateFormState => ({ hourly_rate: '', effective_from: todayLocal(), reason: '' });
const PAGE_SIZE = 100;

function rateLabel(value: string): string {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? `${new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(parsed)}/h`
    : '—';
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError || error instanceof Error ? error.message : fallback;
}

export default function EmployeesPage() {
  const user = useAuth();
  const toast = useToast();
  const isAdmin = user ? canViewEmployeeRates(user.role) : false;
  const showEnrollment = user ? canViewBiometricEnrollment(user.role) : false;
  const [employees, setEmployees] = useState<EmployeeListItem[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [search, setSearch] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [sortBy, setSortBy] = useState<'number' | 'name'>('number');
  const [sortDir, setSortDir] = useState<Exclude<SortDir, null>>('asc');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<EmployeeAdminDetail | 'new' | null>(null);
  const [loadingDetailId, setLoadingDetailId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [pinNotice, setPinNotice] = useState<{ name: string; number: number; pin: string } | null>(null);
  const [history, setHistory] = useState<EmployeeListItem | null>(null);
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [rateEmployee, setRateEmployee] = useState<EmployeeListItem | null>(null);
  const [rates, setRates] = useState<EmployeeRateHistory[] | null>(null);
  const [rateForm, setRateForm] = useState<RateFormState>(EMPTY_RATE_FORM);
  const [rateError, setRateError] = useState<string | null>(null);
  const [savingRate, setSavingRate] = useState(false);

  const photoPreview = useMemo(() => (photoFile ? URL.createObjectURL(photoFile) : null), [photoFile]);
  useEffect(() => () => {
    if (photoPreview) URL.revokeObjectURL(photoPreview);
  }, [photoPreview]);

  const load = useCallback(async () => {
    if (!user) return;
    const params = new URLSearchParams();
    if (!showInactive) params.set('active', 'true');
    if (search) params.set('search', search);
    try {
      const response = await api<unknown>(`/api/employees?${params}`);
      setEmployees(parseEmployeeList(response, user.role));
      setLoadError(null);
    } catch (error) {
      setLoadError(errorMessage(error, 'No se pudo cargar empleados.'));
    }
  }, [search, showInactive, user?.id, user?.role]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void api<Shift[]>('/api/shifts').then(setShifts); }, []);
  useEffect(() => { setPage(1); }, [search, showInactive]);

  const sorted = useMemo(() => {
    if (!employees) return null;
    const list = [...employees].sort((left, right) =>
      sortBy === 'number'
        ? left.employee_number - right.employee_number
        : left.full_name.localeCompare(right.full_name, 'es'),
    );
    if (sortDir === 'desc') list.reverse();
    return list;
  }, [employees, sortBy, sortDir]);

  const pageCount = Math.max(1, Math.ceil((sorted?.length ?? 0) / PAGE_SIZE));
  const visible = sorted?.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  function toggleSort(column: 'number' | 'name'): void {
    if (sortBy === column) setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    else {
      setSortBy(column);
      setSortDir('asc');
    }
  }

  function openNew(): void {
    setEditing('new');
    setForm(EMPTY_FORM());
    setFormError(null);
    setPhotoFile(null);
    setCameraOpen(false);
  }

  function closeEditor(): void {
    setEditing(null);
    setForm(EMPTY_FORM());
    setFormError(null);
    setPhotoFile(null);
    setCameraOpen(false);
  }

  async function openEdit(employee: EmployeeListItem): Promise<void> {
    if (!isAdmin) return;
    setLoadingDetailId(employee.id);
    try {
      const detail = parseEmployeeAdminDetail(await api<unknown>(`/api/employees/${employee.id}`));
      setEditing(detail);
      setForm({
        full_name: detail.full_name,
        social_security: detail.social_security ?? '',
        phone: detail.phone ?? '',
        default_shift_id: detail.default_shift_id ?? '',
        hired_at: detail.hired_at ?? '',
        initial_hourly_rate: '',
        rate_effective_from: todayLocal(),
      });
      setFormError(null);
      setPhotoFile(null);
      setCameraOpen(false);
    } catch (error) {
      toast(errorMessage(error, 'No se pudo cargar el detalle privado del empleado.'), 'danger');
    } finally {
      setLoadingDetailId(null);
    }
  }

  async function save(): Promise<void> {
    const rateValidation = editing === 'new'
      ? initialRateError(form.initial_hourly_rate, form.rate_effective_from)
      : null;
    if (rateValidation) {
      setFormError(rateValidation);
      return;
    }
    setSaving(true);
    setFormError(null);
    const payload = {
      full_name: form.full_name,
      social_security: form.social_security || null,
      phone: form.phone || null,
      default_shift_id: form.default_shift_id || null,
      hired_at: form.hired_at || null,
      ...(editing === 'new' ? initialRatePayload(form.initial_hourly_rate, form.rate_effective_from) : {}),
    };
    try {
      let employeeId: string | null = null;
      if (editing === 'new') {
        const created = await api<CreatedEmployee>('/api/employees', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        employeeId = created.id;
        if (created.pin) setPinNotice({ name: created.full_name, number: created.employee_number, pin: created.pin });
        toast('Empleado dado de alta');
      } else if (editing) {
        employeeId = editing.id;
        await api(`/api/employees/${editing.id}`, { method: 'PATCH', body: JSON.stringify(payload) });
        toast('Empleado actualizado');
      }
      if (employeeId && photoFile) {
        const formData = new FormData();
        formData.append('photo', photoFile);
        await api(`/api/employees/${employeeId}/photo`, { method: 'POST', body: formData });
      }
      closeEditor();
      await load();
    } catch (error) {
      setFormError(errorMessage(error, 'Error al guardar.'));
    } finally {
      setSaving(false);
    }
  }

  async function resetPin(employee: EmployeeListItem): Promise<void> {
    if (!confirm(`¿Generar un PIN nuevo para ${employee.full_name}? El anterior deja de funcionar.`)) return;
    const response = await api<{ pin: string }>(`/api/employees/${employee.id}/reset-pin`, { method: 'POST' });
    setPinNotice({ name: employee.full_name, number: employee.employee_number, pin: response.pin });
    toast('PIN regenerado');
  }

  async function toggleActive(employee: EmployeeListItem): Promise<void> {
    const action = employee.active ? 'deactivate' : 'reactivate';
    if (employee.active && !confirm(`¿Dar de baja a ${employee.full_name}?`)) return;
    await api(`/api/employees/${employee.id}/${action}`, { method: 'POST' });
    toast(employee.active ? 'Empleado dado de baja' : 'Empleado reactivado');
    await load();
  }

  async function openRates(employee: EmployeeListItem): Promise<void> {
    if (!isAdmin) return;
    setRateEmployee(employee);
    setRates(null);
    setRateError(null);
    setRateForm(EMPTY_RATE_FORM());
    try {
      setRates(parseEmployeeRates(await api<unknown>(`/api/employees/${employee.id}/rates`)));
    } catch (error) {
      setRateError(errorMessage(error, 'No se pudo cargar el historial de tasas.'));
    }
  }

  async function saveRate(): Promise<void> {
    if (!rateEmployee) return;
    const validation = rateChangeError(rateForm);
    if (validation) {
      setRateError(validation);
      return;
    }
    setSavingRate(true);
    setRateError(null);
    try {
      await api(`/api/employees/${rateEmployee.id}/rates/change`, {
        method: 'POST',
        body: JSON.stringify({
          hourly_rate: rateForm.hourly_rate.trim(),
          effective_from: rateForm.effective_from,
          reason: rateForm.reason.trim(),
        }),
      });
      setRates(parseEmployeeRates(await api<unknown>(`/api/employees/${rateEmployee.id}/rates`)));
      setRateForm(EMPTY_RATE_FORM());
      toast('Nueva tasa registrada');
      await load();
    } catch (error) {
      setRateError(errorMessage(error, 'No se pudo cambiar la tasa.'));
    } finally {
      setSavingRate(false);
    }
  }

  const shiftName = (id: string | null): string => shifts.find((shift) => shift.id === id)?.name ?? '—';

  if (user && !canAccessEmployees(user.role)) return <Navigate to="/reports" replace />;

  return (
    <div>
      <PageHeader
        title="Empleados"
        actions={
          <>
            <div className="w-64">
              <Input
                placeholder="Buscar por nombre o número"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                aria-label="Buscar empleados"
              />
            </div>
            <label className="flex items-center gap-2 text-13 text-ink-secondary">
              <input
                type="checkbox"
                checked={showInactive}
                onChange={(event) => setShowInactive(event.target.checked)}
                className="accent-accent"
              />
              Ver inactivos
            </label>
            {isAdmin && <Button onClick={openNew}>Dar de alta</Button>}
          </>
        }
      />

      {loadError && (
        <p className="mb-4 rounded-control bg-danger-subtle px-4 py-3 text-13 font-medium text-danger" role="alert">
          {loadError}{employees && ' Se conserva el último listado recibido.'}
        </p>
      )}

      {!visible ? (
        <TableSkeleton rows={8} cols={(showEnrollment ? 8 : 7) + (isAdmin ? 1 : 0)} />
      ) : !visible.length ? (
        <div className="rounded-card border border-line bg-raised shadow-card">
          <EmptyState
            icon={Users}
            title={search ? `Sin resultados para “${search}”.` : 'Aún no hay empleados.'}
            action={isAdmin && !search ? { label: 'Dar de alta al primero', onClick: openNew } : undefined}
          />
        </div>
      ) : (
        <Table>
          <THead>
            <tr>
              <TH num sortable sorted={sortBy === 'number' ? sortDir : null} onSort={() => toggleSort('number')}>#</TH>
              <TH sortable sorted={sortBy === 'name' ? sortDir : null} onSort={() => toggleSort('name')}>Nombre</TH>
              <TH>Turno</TH>
              <TH>Teléfono</TH>
              <TH num>Alta</TH>
              <TH>Estado</TH>
              {showEnrollment && <TH>Identidad facial</TH>}
              {isAdmin && <TH num>Tasa vigente</TH>}
              <TH className="text-right">Acciones</TH>
            </tr>
          </THead>
          <tbody>
            {visible.map((employee) => (
              <TRow key={employee.id}>
                <TD num className="font-semibold">{employee.employee_number}</TD>
                <TD className="font-medium">{employee.full_name}</TD>
                <TD className="text-ink-secondary">{shiftName(employee.default_shift_id)}</TD>
                <TD className="tnum text-ink-secondary">{employee.phone ?? '—'}</TD>
                <TD num className="text-ink-secondary">{employee.hired_at ?? '—'}</TD>
                <TD><StatusBadge status={employee.active ? 'activo' : 'inactivo'} /></TD>
                {showEnrollment && (
                  <TD>
                    {biometricEnrollmentState(employee) === 'ready' ? (
                      <Badge tone="success">Rostro enrolado</Badge>
                    ) : biometricEnrollmentState(employee) === 'error' ? (
                      <Badge tone="danger">Enrollment con error</Badge>
                    ) : (
                      <Badge tone="warning">Sin enrolar</Badge>
                    )}
                  </TD>
                )}
                {isAdmin && (
                  <TD num className={employee.current_rate ? 'font-semibold' : 'text-warning'}>
                    {employee.current_rate ? rateLabel(employee.current_rate.hourly_rate) : 'Sin tasa'}
                    {employee.current_rate && (
                      <span className="block text-11 font-normal text-ink-tertiary">desde {employee.current_rate.effective_from}</span>
                    )}
                  </TD>
                )}
                <TD>
                  <div className="flex justify-end gap-1.5">
                    <Button variant="secondary" size="sm" onClick={() => setHistory(employee)}>Checadas</Button>
                    {isAdmin && (
                      <>
                        <Button variant="secondary" size="sm" onClick={() => void openRates(employee)}>
                          <DollarSign size={14} /> Tasas
                        </Button>
                        <Button
                          variant="secondary"
                          size="sm"
                          loading={loadingDetailId === employee.id}
                          onClick={() => void openEdit(employee)}
                        >
                          Editar
                        </Button>
                        <Button variant="secondary" size="sm" title="Regenerar PIN de contingencia legacy" onClick={() => void resetPin(employee)}>
                          PIN legacy
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => void toggleActive(employee)}>
                          {employee.active ? 'Baja' : 'Reactivar'}
                        </Button>
                      </>
                    )}
                  </div>
                </TD>
              </TRow>
            ))}
          </tbody>
        </Table>
      )}
      {sorted && sorted.length > PAGE_SIZE && <Pagination page={page} pageCount={pageCount} onPage={setPage} />}

      {editing && (
        <Modal
          title={editing === 'new' ? 'Dar de alta empleado' : `Editar — ${editing.full_name}`}
          onClose={closeEditor}
          footer={
            <>
              <Button variant="secondary" onClick={closeEditor}>Cancelar</Button>
              <Button onClick={() => void save()} loading={saving} disabled={!form.full_name.trim()}>
                {editing === 'new' ? 'Dar de alta' : 'Guardar cambios'}
              </Button>
            </>
          }
        >
          <div className="grid gap-1">
            <Field label="Nombre completo" required error={formError}>
              <Input value={form.full_name} onChange={(event) => setForm({ ...form, full_name: event.target.value })} />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Número de seguro" hint="Dato privado: sólo se carga dentro de esta edición administrativa.">
                <Input
                  type="password"
                  autoComplete="off"
                  value={form.social_security}
                  onChange={(event) => setForm({ ...form, social_security: event.target.value })}
                />
              </Field>
              <Field label="Teléfono">
                <Input value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Turno default">
                <Select value={form.default_shift_id} onChange={(event) => setForm({ ...form, default_shift_id: event.target.value })}>
                  <option value="">— Sin turno —</option>
                  {shifts.map((shift) => (
                    <option key={shift.id} value={shift.id}>{shift.name} ({shift.start_time.slice(0, 5)}–{shift.end_time.slice(0, 5)})</option>
                  ))}
                </Select>
              </Field>
              <Field label="Fecha de contratación">
                <Input type="date" value={form.hired_at} onChange={(event) => setForm({ ...form, hired_at: event.target.value })} />
              </Field>
            </div>

            {editing === 'new' && (
              <div className="grid grid-cols-2 gap-4 rounded-control border border-line bg-sunken p-3">
                <Field label="Tasa inicial por hora" hint="Opcional. Ej.: 24.5000">
                  <Input
                    inputMode="decimal"
                    value={form.initial_hourly_rate}
                    onChange={(event) => setForm({ ...form, initial_hourly_rate: event.target.value })}
                  />
                </Field>
                <Field label="Vigente desde">
                  <Input
                    type="date"
                    disabled={!form.initial_hourly_rate.trim()}
                    value={form.rate_effective_from}
                    onChange={(event) => setForm({ ...form, rate_effective_from: event.target.value })}
                  />
                </Field>
              </div>
            )}

            <Field label="Foto de enrolamiento" hint="Crea una versión auditable del enrollment facial.">
              {cameraOpen ? (
                <CameraCapture
                  onCapture={(file) => {
                    setPhotoFile(file);
                    setCameraOpen(false);
                  }}
                  onCancel={() => setCameraOpen(false)}
                />
              ) : (
                <div className="flex items-center gap-3">
                  {photoPreview && <img src={photoPreview} alt="Foto de enrolamiento" className="h-14 w-14 rounded-control border border-line object-cover" />}
                  <Button variant="secondary" size="sm" onClick={() => setCameraOpen(true)}>
                    <Camera size={14} strokeWidth={1.5} /> Tomar foto
                  </Button>
                  <input
                    type="file"
                    accept="image/*"
                    onChange={(event) => setPhotoFile(event.target.files?.[0] ?? null)}
                    className="block w-full text-13 text-ink-secondary file:mr-3 file:h-8 file:cursor-pointer file:rounded-control file:border file:border-line file:bg-raised file:px-3 file:text-13 file:font-medium file:text-ink"
                  />
                </div>
              )}
            </Field>
          </div>
        </Modal>
      )}

      {rateEmployee && (
        <Modal
          title={`Tasas — ${rateEmployee.full_name} (#${rateEmployee.employee_number})`}
          size="lg"
          onClose={() => setRateEmployee(null)}
          footer={<Button variant="secondary" onClick={() => setRateEmployee(null)}>Cerrar</Button>}
        >
          <div className="grid gap-5 lg:grid-cols-[1fr_1.1fr]">
            <section>
              <h3 className="mb-3 text-14 font-semibold">Historial inmutable</h3>
              {rates === null ? (
                <TableSkeleton rows={4} cols={3} />
              ) : rates.length === 0 ? (
                <EmptyState icon={DollarSign} title="Este empleado todavía no tiene tasa." />
              ) : (
                <div className="max-h-72 overflow-y-auto rounded-control border border-line">
                  <table className="w-full text-13">
                    <thead className="sticky top-0 bg-sunken text-12 uppercase tracking-wide text-ink-secondary">
                      <tr><th className="px-3 py-2 text-left">Vigencia</th><th className="px-3 py-2 text-right">Tasa</th></tr>
                    </thead>
                    <tbody>
                      {rates.map((rate) => (
                        <tr key={rate.id} className="border-t border-line">
                          <td className="px-3 py-2">
                            <span className="tnum">{rate.effective_from} — {rate.effective_to ?? 'actual'}</span>
                            {rate.reason && <span className="mt-1 block text-12 text-ink-tertiary">{rate.reason}</span>}
                          </td>
                          <td className="tnum px-3 py-2 text-right font-semibold">{rateLabel(rate.hourly_rate)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
            <section className="rounded-control border border-line bg-sunken p-4">
              <h3 className="mb-3 text-14 font-semibold">Registrar cambio efectivo</h3>
              <Field label="Nueva tasa por hora" required error={rateError}>
                <Input
                  inputMode="decimal"
                  placeholder="Ej.: 25.7500"
                  value={rateForm.hourly_rate}
                  onChange={(event) => setRateForm({ ...rateForm, hourly_rate: event.target.value })}
                />
              </Field>
              <Field label="Vigente desde" required>
                <Input
                  type="date"
                  value={rateForm.effective_from}
                  onChange={(event) => setRateForm({ ...rateForm, effective_from: event.target.value })}
                />
              </Field>
              <Field label="Motivo" required hint="Quedará en la auditoría y no puede omitirse.">
                <Textarea
                  rows={3}
                  value={rateForm.reason}
                  onChange={(event) => setRateForm({ ...rateForm, reason: event.target.value })}
                />
              </Field>
              <Button className="w-full" loading={savingRate} onClick={() => void saveRate()}>
                Registrar nueva tasa
              </Button>
            </section>
          </div>
        </Modal>
      )}

      {history && <PunchHistoryModal employee={history} onClose={() => setHistory(null)} />}

      {pinNotice && (
        <Modal
          title="PIN generado"
          size="sm"
          onClose={() => setPinNotice(null)}
          footer={<Button onClick={() => setPinNotice(null)}>Entendido</Button>}
        >
          <p className="text-14 text-ink-secondary">
            PIN para <span className="font-semibold text-ink">{pinNotice.name}</span>{' '}
            <span className="tnum">(#{pinNotice.number})</span>. Anótalo o imprímelo:{' '}
            <span className="font-semibold text-ink">no se volverá a mostrar.</span>
          </p>
          <p className="tnum my-5 text-center font-display text-40 font-bold tracking-[0.25em] text-accent">
            {pinNotice.pin}
          </p>
        </Modal>
      )}
    </div>
  );
}
