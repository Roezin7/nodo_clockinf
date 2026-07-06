import { useEffect, useState } from 'react';
import type { Area, MealWindow, Settings, Shift, User } from '@clockai/shared';
import { ALLOWED_TIMEZONES } from '@clockai/shared';
import { api, ApiError } from '../api';
import { useAuth } from '../hooks/useAuth';
import { setAppTimezone } from '../time';
import { PageHeader } from '../components/layout/PageHeader';
import { Button, Field, Input, Select, StatusBadge, useToast } from '../components/ui';

const DAY_NAMES = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom']; // ISO 1..7

export default function SettingsPage() {
  const user = useAuth();
  const isAdmin = user?.role === 'admin';

  if (!isAdmin) {
    return (
      <div>
        <PageHeader title="Configuración" />
        <p className="text-14 text-ink-secondary">Solo el rol admin puede ver esta pantalla.</p>
      </div>
    );
  }

  return (
    <div>
      <PageHeader title="Configuración" />
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <ThresholdsCard />
        <ShiftsCard />
        <AreasCard />
        <UsersCard currentUserId={user!.id} />
      </div>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-card border border-line bg-raised p-6 shadow-card">
      <h2 className="mb-4 text-16 font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function ThresholdsCard() {
  const toast = useToast();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void api<Settings>('/api/settings').then(setSettings);
  }, []);

  async function save(): Promise<void> {
    if (!settings) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await api<Settings>('/api/settings', { method: 'PATCH', body: JSON.stringify(settings) });
      setSettings(updated);
      setAppTimezone(updated.timezone); // toda la UI cambia de zona al instante
      toast('Reglas de nómina guardadas');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Error al guardar');
    } finally {
      setSaving(false);
    }
  }

  if (!settings) return <Card title="Reglas de nómina">Cargando…</Card>;

  return (
    <Card title="Reglas de nómina">
      <div className="grid gap-1">
        <Field label="Zona horaria de la planta" hint="Gobierna cortes de día, retardos, reportes y toda hora mostrada">
          <Select value={settings.timezone} onChange={(e) => setSettings({ ...settings, timezone: e.target.value })}>
            {ALLOWED_TIMEZONES.map((tz) => (
              <option key={tz.id} value={tz.id}>
                {tz.label} — {tz.id}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="OT diario después de (horas)">
            <Input
              type="number"
              min={1}
              max={24}
              step={0.5}
              value={settings.daily_ot_threshold_minutes / 60}
              onChange={(e) =>
                setSettings({ ...settings, daily_ot_threshold_minutes: Math.round(Number(e.target.value) * 60) })
              }
            />
          </Field>
          <Field label="OT semanal después de (horas)">
            <Input
              type="number"
              min={1}
              max={120}
              step={0.5}
              value={settings.weekly_ot_threshold_minutes / 60}
              onChange={(e) =>
                setSettings({ ...settings, weekly_ot_threshold_minutes: Math.round(Number(e.target.value) * 60) })
              }
            />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Field label="La semana inicia en">
            <Select
              value={settings.week_start_day}
              onChange={(e) => setSettings({ ...settings, week_start_day: Number(e.target.value) })}
            >
              {DAY_NAMES.map((name, i) => (
                <option key={i + 1} value={i + 1}>
                  {name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Retención de fotos (semanas)">
            <Input
              type="number"
              min={1}
              max={104}
              value={settings.photo_retention_weeks}
              onChange={(e) => setSettings({ ...settings, photo_retention_weeks: Number(e.target.value) })}
            />
          </Field>
        </div>
        <div>
          <span className="mb-1 block text-13 font-medium text-ink">Días laborables (para contar faltas)</span>
          <div className="flex gap-1.5">
            {DAY_NAMES.map((name, i) => {
              const day = i + 1;
              const active = settings.work_days.includes(day);
              return (
                <button
                  key={day}
                  aria-pressed={active}
                  onClick={() =>
                    setSettings({
                      ...settings,
                      work_days: active
                        ? settings.work_days.filter((d) => d !== day)
                        : [...settings.work_days, day].sort(),
                    })
                  }
                  className={`h-8 rounded-control border px-3 text-13 font-medium transition-colors duration-150 ${
                    active
                      ? 'border-accent bg-accent-subtle text-accent'
                      : 'border-line bg-raised text-ink-secondary hover:bg-sunken'
                  }`}
                >
                  {name}
                </button>
              );
            })}
          </div>
        </div>
        {error && (
          <p className="mt-2 text-12 font-medium text-danger" role="alert">
            {error}
          </p>
        )}
        <div className="mt-3">
          <Button onClick={() => void save()} loading={saving}>
            Guardar reglas
          </Button>
        </div>
      </div>
    </Card>
  );
}

function ShiftsCard() {
  const toast = useToast();
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = (): void => void api<Shift[]>('/api/shifts').then(setShifts);
  useEffect(load, []);

  async function saveShift(shift: Shift): Promise<void> {
    setError(null);
    try {
      await api(`/api/shifts/${shift.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: shift.name,
          start_time: shift.start_time.slice(0, 5),
          end_time: shift.end_time.slice(0, 5),
          tolerance_minutes: shift.tolerance_minutes,
          meal_windows: shift.meal_windows,
        }),
      });
      toast('Turno guardado');
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Error al guardar turno');
    }
  }

  return (
    <Card title="Turnos y horarios">
      <div className="grid gap-4">
        {shifts.map((shift) => (
          <ShiftEditor key={shift.id} shift={shift} onSave={saveShift} />
        ))}
      </div>
      {error && (
        <p className="mt-3 text-12 font-medium text-danger" role="alert">
          {error}
        </p>
      )}
    </Card>
  );
}

function ShiftEditor({ shift, onSave }: { shift: Shift; onSave: (s: Shift) => Promise<void> }) {
  const [s, setS] = useState(shift);
  const [saving, setSaving] = useState(false);
  const meal: MealWindow | undefined = s.meal_windows[0];

  return (
    <div className="rounded-control border border-line bg-sunken/50 p-4">
      <div className="grid grid-cols-2 gap-x-4">
        <Field label="Nombre">
          <Input value={s.name} onChange={(e) => setS({ ...s, name: e.target.value })} />
        </Field>
        <Field label="Entrada">
          <Input type="time" value={s.start_time.slice(0, 5)} onChange={(e) => setS({ ...s, start_time: e.target.value })} />
        </Field>
        <Field label="Salida">
          <Input type="time" value={s.end_time.slice(0, 5)} onChange={(e) => setS({ ...s, end_time: e.target.value })} />
        </Field>
        <Field label="Tolerancia (min)">
          <Input
            type="number"
            min={0}
            max={120}
            value={s.tolerance_minutes}
            onChange={(e) => setS({ ...s, tolerance_minutes: Number(e.target.value) })}
          />
        </Field>
      </div>
      <div className="flex items-end gap-4">
        <Field label="Comida de" hint="Vacío = turno sin comida">
          <Input
            type="time"
            value={meal?.start ?? ''}
            onChange={(e) =>
              setS({
                ...s,
                meal_windows: e.target.value
                  ? [{ name: 'Comida', start: e.target.value, end: meal?.end ?? e.target.value, paid: false }]
                  : [],
              })
            }
          />
        </Field>
        <Field label="a">
          <Input
            type="time"
            value={meal?.end ?? ''}
            disabled={!meal}
            onChange={(e) => meal && setS({ ...s, meal_windows: [{ ...meal, end: e.target.value }] })}
          />
        </Field>
        <div className="mb-6 ml-auto">
          <Button
            variant="secondary"
            size="sm"
            loading={saving}
            onClick={() => {
              setSaving(true);
              void onSave(s).finally(() => setSaving(false));
            }}
          >
            Guardar turno
          </Button>
        </div>
      </div>
    </div>
  );
}

function AreasCard() {
  const toast = useToast();
  const [areas, setAreas] = useState<Area[]>([]);
  const [name, setName] = useState('');

  const load = (): void => void api<Area[]>('/api/areas').then(setAreas);
  useEffect(load, []);

  async function add(): Promise<void> {
    if (!name.trim()) return;
    await api('/api/areas', { method: 'POST', body: JSON.stringify({ name: name.trim() }) });
    toast('Área agregada');
    setName('');
    load();
  }

  return (
    <Card title="Áreas de trabajo">
      <ul className="flex flex-wrap gap-2">
        {areas.map((a) => (
          <li key={a.id} className="rounded-full border border-line bg-sunken px-3 py-1 text-13 font-medium text-ink-secondary">
            {a.name}
          </li>
        ))}
      </ul>
      <div className="mt-4 flex gap-2">
        <Input placeholder="Nueva área" value={name} onChange={(e) => setName(e.target.value)} />
        <Button variant="secondary" onClick={() => void add()} disabled={!name.trim()}>
          Agregar
        </Button>
      </div>
    </Card>
  );
}

function UsersCard({ currentUserId }: { currentUserId: string }) {
  const toast = useToast();
  const [users, setUsers] = useState<User[]>([]);
  const [form, setForm] = useState({ name: '', email: '', password: '', role: 'supervisor' as 'admin' | 'supervisor' });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = (): void => void api<User[]>('/api/users').then(setUsers);
  useEffect(load, []);

  async function add(): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      await api('/api/users', { method: 'POST', body: JSON.stringify(form) });
      toast('Usuario creado');
      setForm({ name: '', email: '', password: '', role: 'supervisor' });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Error al crear usuario');
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(u: User): Promise<void> {
    try {
      await api(`/api/users/${u.id}`, { method: 'PATCH', body: JSON.stringify({ active: !u.active }) });
      toast(u.active ? 'Usuario desactivado' : 'Usuario activado');
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Error');
    }
  }

  return (
    <Card title="Usuarios del sistema">
      <ul className="divide-y divide-line">
        {users.map((u) => (
          <li key={u.id} className="flex items-center justify-between gap-3 py-2.5 text-14">
            <div className="min-w-0">
              <p className="truncate font-medium">{u.name}</p>
              <p className="truncate text-12 text-ink-tertiary">
                {u.email} · {u.role}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <StatusBadge status={u.active ? 'activo' : 'inactivo'} />
              {u.id !== currentUserId && (
                <Button variant="ghost" size="sm" onClick={() => void toggleActive(u)}>
                  {u.active ? 'Desactivar' : 'Activar'}
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>
      <div className="mt-4 grid grid-cols-2 gap-x-4">
        <Field label="Nombre" required>
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label="Correo" required>
          <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </Field>
        <Field label="Contraseña" required hint="Mínimo 8 caracteres" error={error}>
          <Input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        </Field>
        <Field label="Rol" required>
          <Select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as 'admin' | 'supervisor' })}>
            <option value="supervisor">Supervisor</option>
            <option value="admin">Admin</option>
          </Select>
        </Field>
      </div>
      <Button onClick={() => void add()} loading={saving} disabled={!form.name || !form.email || form.password.length < 8}>
        Crear usuario
      </Button>
    </Card>
  );
}
