import { useCallback, useEffect, useMemo, useState } from 'react';
import { Camera, Users } from 'lucide-react';
import { Navigate } from 'react-router-dom';
import type { Employee, Shift } from '@clockai/shared';
import { api, ApiError } from '../api';
import { useAuth } from '../hooks/useAuth';
import PunchHistoryModal from '../components/PunchHistoryModal';
import CameraCapture from '../components/CameraCapture';
import { PageHeader } from '../components/layout/PageHeader';
import {
  biometricEnrollmentState,
  canAccessEmployees,
  canViewBiometricEnrollment,
} from '../employees/visibility';
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
  TRow,
  useToast,
  type SortDir,
} from '../components/ui';

type EmployeeWithPin = Employee & { pin?: string };
type EmployeeIdentity = Employee & {
  biometric_enrollment_status?: 'ready' | 'error' | null;
  current_biometric_enrollment_id?: string | null;
  biometric_enrollment?: { id: string; version: number; status: 'ready' | 'error'; provider: string } | null;
};

interface FormState {
  full_name: string;
  social_security: string;
  phone: string;
  default_shift_id: string;
  hired_at: string;
}

const EMPTY_FORM: FormState = { full_name: '', social_security: '', phone: '', default_shift_id: '', hired_at: '' };
const PAGE_SIZE = 100;

export default function EmployeesPage() {
  const user = useAuth();
  const toast = useToast();
  const isAdmin = user?.role === 'admin';
  const showEnrollment = user ? canViewBiometricEnrollment(user.role) : false;
  const [employees, setEmployees] = useState<EmployeeIdentity[] | null>(null);
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [search, setSearch] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [sortBy, setSortBy] = useState<'number' | 'name'>('number');
  const [sortDir, setSortDir] = useState<Exclude<SortDir, null>>('asc');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<Employee | 'new' | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [pinNotice, setPinNotice] = useState<{ name: string; number: number; pin: string } | null>(null);
  const [history, setHistory] = useState<Employee | null>(null);
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);

  const photoPreview = useMemo(() => (photoFile ? URL.createObjectURL(photoFile) : null), [photoFile]);
  useEffect(() => {
    return () => {
      if (photoPreview) URL.revokeObjectURL(photoPreview);
    };
  }, [photoPreview]);

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (!showInactive) params.set('active', 'true');
    if (search) params.set('search', search);
    setEmployees(await api<EmployeeIdentity[]>(`/api/employees?${params}`));
  }, [search, showInactive]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    void api<Shift[]>('/api/shifts').then(setShifts);
  }, []);
  useEffect(() => {
    setPage(1);
  }, [search, showInactive]);

  const sorted = useMemo(() => {
    if (!employees) return null;
    const list = [...employees].sort((a, b) =>
      sortBy === 'number'
        ? a.employee_number - b.employee_number
        : a.full_name.localeCompare(b.full_name, 'es')
    );
    if (sortDir === 'desc') list.reverse();
    return list;
  }, [employees, sortBy, sortDir]);

  const pageCount = Math.max(1, Math.ceil((sorted?.length ?? 0) / PAGE_SIZE));
  const visible = sorted?.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  function toggleSort(col: 'number' | 'name'): void {
    if (sortBy === col) setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    else {
      setSortBy(col);
      setSortDir('asc');
    }
  }

  function openEdit(emp: Employee | 'new'): void {
    setEditing(emp);
    setFormError(null);
    setPhotoFile(null);
    setCameraOpen(false);
    setForm(
      emp === 'new'
        ? EMPTY_FORM
        : {
            full_name: emp.full_name,
            social_security: emp.social_security ?? '',
            phone: emp.phone ?? '',
            default_shift_id: emp.default_shift_id ?? '',
            hired_at: emp.hired_at ?? '',
          }
    );
  }

  async function save(): Promise<void> {
    setSaving(true);
    setFormError(null);
    const payload = {
      full_name: form.full_name,
      social_security: form.social_security || null,
      phone: form.phone || null,
      default_shift_id: form.default_shift_id || null,
      hired_at: form.hired_at || null,
    };
    try {
      let employeeId: string | null = null;
      if (editing === 'new') {
        const created = await api<EmployeeWithPin>('/api/employees', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        employeeId = created.id;
        if (created.pin) {
          setPinNotice({ name: created.full_name, number: created.employee_number, pin: created.pin });
        }
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
      setEditing(null);
      await load();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : 'Error al guardar');
    } finally {
      setSaving(false);
    }
  }

  async function resetPin(emp: Employee): Promise<void> {
    if (!confirm(`¿Generar un PIN nuevo para ${emp.full_name}? El anterior deja de funcionar.`)) return;
    const res = await api<{ pin: string }>(`/api/employees/${emp.id}/reset-pin`, { method: 'POST' });
    setPinNotice({ name: emp.full_name, number: emp.employee_number, pin: res.pin });
    toast('PIN regenerado');
  }

  async function toggleActive(emp: Employee): Promise<void> {
    const action = emp.active ? 'deactivate' : 'reactivate';
    if (emp.active && !confirm(`¿Dar de baja a ${emp.full_name}?`)) return;
    await api(`/api/employees/${emp.id}/${action}`, { method: 'POST' });
    toast(emp.active ? 'Empleado dado de baja' : 'Empleado reactivado');
    await load();
  }

  const shiftName = (id: string | null): string => shifts.find((s) => s.id === id)?.name ?? '—';

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
                onChange={(e) => setSearch(e.target.value)}
                aria-label="Buscar empleados"
              />
            </div>
            <label className="flex items-center gap-2 text-13 text-ink-secondary">
              <input
                type="checkbox"
                checked={showInactive}
                onChange={(e) => setShowInactive(e.target.checked)}
                className="accent-accent"
              />
              Ver inactivos
            </label>
            {isAdmin && <Button onClick={() => openEdit('new')}>Dar de alta</Button>}
          </>
        }
      />

      {!visible ? (
        <TableSkeleton rows={8} cols={showEnrollment ? 8 : 7} />
      ) : !visible.length ? (
        <div className="rounded-card border border-line bg-raised shadow-card">
          <EmptyState
            icon={Users}
            title={search ? `Sin resultados para “${search}”.` : 'Aún no hay empleados.'}
            action={isAdmin && !search ? { label: 'Dar de alta al primero', onClick: () => openEdit('new') } : undefined}
          />
        </div>
      ) : (
        <Table>
          <THead>
            <tr>
              <TH num sortable sorted={sortBy === 'number' ? sortDir : null} onSort={() => toggleSort('number')}>
                #
              </TH>
              <TH sortable sorted={sortBy === 'name' ? sortDir : null} onSort={() => toggleSort('name')}>
                Nombre
              </TH>
              <TH>Turno</TH>
              <TH>Teléfono</TH>
              <TH num>Alta</TH>
              <TH>Estado</TH>
              {showEnrollment && <TH>Identidad facial</TH>}
              <TH className="text-right">Acciones</TH>
            </tr>
          </THead>
          <tbody>
            {visible.map((emp) => (
              <TRow key={emp.id}>
                <TD num className="font-semibold">{emp.employee_number}</TD>
                <TD className="font-medium">{emp.full_name}</TD>
                <TD className="text-ink-secondary">{shiftName(emp.default_shift_id)}</TD>
                <TD className="tnum text-ink-secondary">{emp.phone ?? '—'}</TD>
                <TD num className="text-ink-secondary">{emp.hired_at ?? '—'}</TD>
                <TD>
                  <StatusBadge status={emp.active ? 'activo' : 'inactivo'} />
                </TD>
                {showEnrollment && (
                  <TD>
                    {biometricEnrollmentState(emp) === 'ready' ? (
                      <Badge tone="success">Rostro enrolado</Badge>
                    ) : biometricEnrollmentState(emp) === 'error' ? (
                      <Badge tone="danger">Enrollment con error</Badge>
                    ) : (
                      <Badge tone="warning">Sin enrolar</Badge>
                    )}
                  </TD>
                )}
                <TD>
                  <div className="flex justify-end gap-1.5">
                    <Button variant="secondary" size="sm" onClick={() => setHistory(emp)}>
                      Checadas
                    </Button>
                    {isAdmin && (
                      <>
                        <Button variant="secondary" size="sm" onClick={() => openEdit(emp)}>
                          Editar
                        </Button>
                        <Button variant="secondary" size="sm" title="Regenerar PIN de contingencia legacy" onClick={() => void resetPin(emp)}>
                          PIN legacy
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          title={emp.active ? 'Dar de baja' : 'Reactivar'}
                          onClick={() => void toggleActive(emp)}
                        >
                          {emp.active ? 'Baja' : 'Reactivar'}
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
          onClose={() => setEditing(null)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setEditing(null)}>
                Cancelar
              </Button>
              <Button onClick={() => void save()} loading={saving} disabled={!form.full_name.trim()}>
                {editing === 'new' ? 'Dar de alta' : 'Guardar cambios'}
              </Button>
            </>
          }
        >
          <div className="grid gap-1">
            <Field label="Nombre completo" required error={formError}>
              <Input value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Número de seguro">
                <Input value={form.social_security} onChange={(e) => setForm({ ...form, social_security: e.target.value })} />
              </Field>
              <Field label="Teléfono">
                <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Turno default">
                <Select value={form.default_shift_id} onChange={(e) => setForm({ ...form, default_shift_id: e.target.value })}>
                  <option value="">— Sin turno —</option>
                  {shifts.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} ({s.start_time.slice(0, 5)}–{s.end_time.slice(0, 5)})
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Fecha de contratación">
                <Input type="date" value={form.hired_at} onChange={(e) => setForm({ ...form, hired_at: e.target.value })} />
              </Field>
            </div>
            <Field
              label="Foto de enrolamiento"
              hint="Crea una nueva versión auditable del enrollment facial. El kiosco normal no solicita PIN."
            >
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
                  {photoPreview && (
                    <img
                      src={photoPreview}
                      alt="Foto de enrolamiento"
                      className="h-14 w-14 rounded-control border border-line object-cover"
                    />
                  )}
                  <Button variant="secondary" size="sm" onClick={() => setCameraOpen(true)}>
                    <Camera size={14} strokeWidth={1.5} /> Tomar foto
                  </Button>
                  <input
                    type="file"
                    accept="image/*"
                    onChange={(e) => setPhotoFile(e.target.files?.[0] ?? null)}
                    className="block w-full text-13 text-ink-secondary file:mr-3 file:h-8 file:cursor-pointer file:rounded-control file:border file:border-line file:bg-raised file:px-3 file:text-13 file:font-medium file:text-ink"
                  />
                </div>
              )}
            </Field>
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
