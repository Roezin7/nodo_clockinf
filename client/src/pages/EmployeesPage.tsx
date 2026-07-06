import { useCallback, useEffect, useState } from 'react';
import type { Employee, Shift } from '@clockai/shared';
import { api, ApiError } from '../api';
import { useAuth } from '../hooks/useAuth';
import PunchHistoryModal from '../components/PunchHistoryModal';

type EmployeeWithPin = Employee & { pin?: string };

interface FormState {
  full_name: string;
  social_security: string;
  phone: string;
  default_shift_id: string;
  hired_at: string;
}

const EMPTY_FORM: FormState = { full_name: '', social_security: '', phone: '', default_shift_id: '', hired_at: '' };

export default function EmployeesPage() {
  const user = useAuth();
  const isAdmin = user?.role === 'admin';
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [search, setSearch] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<Employee | 'new' | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [pinNotice, setPinNotice] = useState<{ name: string; number: number; pin: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<Employee | null>(null);
  const [photoFile, setPhotoFile] = useState<File | null>(null);

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (!showInactive) params.set('active', 'true');
    if (search) params.set('search', search);
    setEmployees(await api<Employee[]>(`/api/employees?${params}`));
  }, [search, showInactive]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    void api<Shift[]>('/api/shifts').then(setShifts);
  }, []);

  function openEdit(emp: Employee | 'new') {
    setEditing(emp);
    setError(null);
    setPhotoFile(null);
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

  async function save() {
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
      } else if (editing) {
        employeeId = editing.id;
        await api(`/api/employees/${editing.id}`, { method: 'PATCH', body: JSON.stringify(payload) });
      }
      if (employeeId && photoFile) {
        const form = new FormData();
        form.append('photo', photoFile);
        await api(`/api/employees/${employeeId}/photo`, { method: 'POST', body: form });
      }
      setEditing(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Error al guardar');
    }
  }

  async function resetPin(emp: Employee) {
    if (!confirm(`¿Generar un PIN nuevo para ${emp.full_name}? El anterior deja de funcionar.`)) return;
    const res = await api<{ pin: string }>(`/api/employees/${emp.id}/reset-pin`, { method: 'POST' });
    setPinNotice({ name: emp.full_name, number: emp.employee_number, pin: res.pin });
  }

  async function toggleActive(emp: Employee) {
    const action = emp.active ? 'deactivate' : 'reactivate';
    if (emp.active && !confirm(`¿Dar de baja a ${emp.full_name}?`)) return;
    await api(`/api/employees/${emp.id}/${action}`, { method: 'POST' });
    await load();
  }

  const shiftName = (id: string | null) => shifts.find((s) => s.id === id)?.name ?? '—';

  return (
    <div className="p-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold">Empleados</h1>
        <div className="flex-1" />
        <input
          placeholder="Buscar por nombre o número…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-64 rounded-lg border border-line bg-card px-3 py-2 text-sm outline-none focus:border-wine-500"
        />
        <label className="flex items-center gap-2 text-sm text-ink-soft">
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
          Ver inactivos
        </label>
        {isAdmin && (
          <button
            onClick={() => openEdit('new')}
            className="rounded-lg bg-wine-600 px-4 py-2 text-sm font-bold text-white hover:bg-wine-700"
          >
            + Alta de empleado
          </button>
        )}
      </div>

      <div className="mt-4 overflow-x-auto rounded-xl border border-line bg-card">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs font-bold uppercase tracking-wide text-ink-soft">
              <th className="px-4 py-3">#</th>
              <th className="px-4 py-3">Nombre</th>
              <th className="px-4 py-3">Turno default</th>
              <th className="px-4 py-3">Teléfono</th>
              <th className="px-4 py-3">Alta</th>
              <th className="px-4 py-3">Estado</th>
              <th className="px-4 py-3 text-right">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {employees.map((emp) => (
              <tr key={emp.id} className="border-b border-line last:border-0 hover:bg-surface">
                <td className="px-4 py-3 font-bold tabular-nums">{emp.employee_number}</td>
                <td className="px-4 py-3 font-semibold">{emp.full_name}</td>
                <td className="px-4 py-3">{shiftName(emp.default_shift_id)}</td>
                <td className="px-4 py-3">{emp.phone ?? '—'}</td>
                <td className="px-4 py-3 tabular-nums">{emp.hired_at ?? '—'}</td>
                <td className="px-4 py-3">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-bold ${
                      emp.active ? 'bg-wine-50 text-ok' : 'bg-surface text-ink-soft'
                    }`}
                  >
                    {emp.active ? 'Activo' : 'Inactivo'}
                  </span>
                </td>
                <td className="px-4 py-3 text-right">
                  <div className="flex justify-end gap-2">
                    <button onClick={() => setHistory(emp)} className="rounded-lg border border-line px-2.5 py-1 text-xs font-semibold hover:bg-surface">
                      Checadas
                    </button>
                    {isAdmin && (
                      <>
                        <button onClick={() => openEdit(emp)} className="rounded-lg border border-line px-2.5 py-1 text-xs font-semibold hover:bg-surface">
                          Editar
                        </button>
                        <button onClick={() => void resetPin(emp)} className="rounded-lg border border-line px-2.5 py-1 text-xs font-semibold hover:bg-surface">
                          Reset PIN
                        </button>
                        <button
                          onClick={() => void toggleActive(emp)}
                          className={`rounded-lg border border-line px-2.5 py-1 text-xs font-semibold hover:bg-surface ${emp.active ? 'text-bad' : 'text-ok'}`}
                        >
                          {emp.active ? 'Baja' : 'Reactivar'}
                        </button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {!employees.length && (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-ink-soft">
                  Sin empleados. {isAdmin ? 'Usa “Alta de empleado”.' : ''}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {editing && (
        <Modal title={editing === 'new' ? 'Alta de empleado' : `Editar — ${editing.full_name}`} onClose={() => setEditing(null)}>
          <div className="grid gap-3">
            <Field label="Nombre completo *">
              <input className={inputCls} value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Número de seguro">
                <input className={inputCls} value={form.social_security} onChange={(e) => setForm({ ...form, social_security: e.target.value })} />
              </Field>
              <Field label="Teléfono">
                <input className={inputCls} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Turno default">
                <select className={inputCls} value={form.default_shift_id} onChange={(e) => setForm({ ...form, default_shift_id: e.target.value })}>
                  <option value="">— Sin turno —</option>
                  {shifts.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} ({s.start_time.slice(0, 5)}–{s.end_time.slice(0, 5)})
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Fecha de contratación">
                <input type="date" className={inputCls} value={form.hired_at} onChange={(e) => setForm({ ...form, hired_at: e.target.value })} />
              </Field>
            </div>
            <Field label="Foto de enrolamiento (cámara o archivo)">
              <input
                type="file"
                accept="image/*"
                capture="user"
                onChange={(e) => setPhotoFile(e.target.files?.[0] ?? null)}
                className="w-full text-sm"
              />
            </Field>
            {editing === 'new' && (
              <p className="text-xs text-ink-soft">Al guardar se genera un PIN de 4 dígitos que se muestra una sola vez.</p>
            )}
            {error && <p className="text-sm font-semibold text-bad">{error}</p>}
            <div className="mt-2 flex justify-end gap-2">
              <button onClick={() => setEditing(null)} className="rounded-lg border border-line px-4 py-2 text-sm font-semibold hover:bg-surface">
                Cancelar
              </button>
              <button
                onClick={() => void save()}
                disabled={!form.full_name.trim()}
                className="rounded-lg bg-wine-600 px-4 py-2 text-sm font-bold text-white hover:bg-wine-700 disabled:opacity-50"
              >
                Guardar
              </button>
            </div>
          </div>
        </Modal>
      )}

      {history && <PunchHistoryModal employee={history} onClose={() => setHistory(null)} />}

      {pinNotice && (
        <Modal title="PIN generado" onClose={() => setPinNotice(null)}>
          <p className="text-sm">
            PIN para <strong>{pinNotice.name}</strong> (empleado #{pinNotice.number}). Anótalo o imprímelo:
            <strong> no se volverá a mostrar.</strong>
          </p>
          <div className="my-5 text-center font-mono text-5xl font-extrabold tracking-[0.3em] text-wine-600">
            {pinNotice.pin}
          </div>
          <div className="flex justify-end">
            <button onClick={() => setPinNotice(null)} className="rounded-lg bg-wine-600 px-4 py-2 text-sm font-bold text-white hover:bg-wine-700">
              Entendido
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

const inputCls =
  'w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-wine-500';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-semibold">{label}</span>
      {children}
    </label>
  );
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-2xl border border-line bg-card p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-4 text-lg font-bold">{title}</h2>
        {children}
      </div>
    </div>
  );
}
