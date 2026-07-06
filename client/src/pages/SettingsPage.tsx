import { useEffect, useState } from 'react';
import type { Area, MealWindow, Settings, Shift, User } from '@clockai/shared';
import { ALLOWED_TIMEZONES } from '@clockai/shared';
import { api, ApiError } from '../api';
import { useAuth } from '../hooks/useAuth';
import { setAppTimezone } from '../time';

const inputCls =
  'w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-wine-500';

const DAY_NAMES = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom']; // ISO 1..7

export default function SettingsPage() {
  const user = useAuth();
  const isAdmin = user?.role === 'admin';

  if (!isAdmin) {
    return (
      <div className="p-8">
        <h1 className="text-2xl font-bold">Configuración</h1>
        <p className="mt-2 text-ink-soft">Solo el rol admin puede ver esta pantalla.</p>
      </div>
    );
  }

  return (
    <div className="grid gap-6 p-6 lg:grid-cols-2">
      <ThresholdsCard />
      <ShiftsCard />
      <AreasCard />
      <UsersCard currentUserId={user!.id} />
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-line bg-card p-5">
      <h2 className="text-lg font-bold">{title}</h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function ThresholdsCard() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api<Settings>('/api/settings').then(setSettings);
  }, []);

  async function save() {
    if (!settings) return;
    setError(null);
    try {
      const updated = await api<Settings>('/api/settings', { method: 'PATCH', body: JSON.stringify(settings) });
      setSettings(updated);
      // Toda la UI se actualiza a la nueva zona al instante
      setAppTimezone(updated.timezone);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Error al guardar');
    }
  }

  if (!settings) return <Card title="Reglas de nómina">Cargando…</Card>;

  return (
    <Card title="Reglas de nómina">
      <label className="mb-3 block">
        <span className="mb-1 block text-sm font-semibold">Zona horaria de la planta</span>
        <select
          className={inputCls}
          value={settings.timezone}
          onChange={(e) => setSettings({ ...settings, timezone: e.target.value })}
        >
          {ALLOWED_TIMEZONES.map((tz) => (
            <option key={tz.id} value={tz.id}>{tz.label} — {tz.id}</option>
          ))}
        </select>
        <span className="mt-1 block text-xs text-ink-soft">
          Gobierna los cortes de día, retardos, reportes y TODA hora mostrada (kiosco incluido).
        </span>
      </label>
      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="mb-1 block text-sm font-semibold">OT diario después de (horas)</span>
          <input
            type="number" min={1} max={24} step={0.5}
            className={inputCls}
            value={settings.daily_ot_threshold_minutes / 60}
            onChange={(e) => setSettings({ ...settings, daily_ot_threshold_minutes: Math.round(Number(e.target.value) * 60) })}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-semibold">OT semanal después de (horas)</span>
          <input
            type="number" min={1} max={120} step={0.5}
            className={inputCls}
            value={settings.weekly_ot_threshold_minutes / 60}
            onChange={(e) => setSettings({ ...settings, weekly_ot_threshold_minutes: Math.round(Number(e.target.value) * 60) })}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-semibold">La semana inicia en</span>
          <select
            className={inputCls}
            value={settings.week_start_day}
            onChange={(e) => setSettings({ ...settings, week_start_day: Number(e.target.value) })}
          >
            {DAY_NAMES.map((name, i) => (
              <option key={i + 1} value={i + 1}>{name}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-semibold">Retención de fotos (semanas)</span>
          <input
            type="number" min={1} max={104}
            className={inputCls}
            value={settings.photo_retention_weeks}
            onChange={(e) => setSettings({ ...settings, photo_retention_weeks: Number(e.target.value) })}
          />
        </label>
      </div>
      <div className="mt-3">
        <span className="mb-1 block text-sm font-semibold">Días laborables (para contar faltas)</span>
        <div className="flex gap-1.5">
          {DAY_NAMES.map((name, i) => {
            const day = i + 1;
            const active = settings.work_days.includes(day);
            return (
              <button
                key={day}
                onClick={() =>
                  setSettings({
                    ...settings,
                    work_days: active
                      ? settings.work_days.filter((d) => d !== day)
                      : [...settings.work_days, day].sort(),
                  })
                }
                className={`rounded-lg border px-3 py-1.5 text-sm font-bold ${
                  active ? 'border-wine-500 bg-wine-50 text-wine-700' : 'border-line text-ink-soft'
                }`}
              >
                {name}
              </button>
            );
          })}
        </div>
      </div>
      {error && <p className="mt-3 text-sm font-semibold text-bad">{error}</p>}
      <button onClick={() => void save()} className="mt-4 rounded-lg bg-wine-600 px-4 py-2 text-sm font-bold text-white hover:bg-wine-700">
        {saved ? 'Guardado ✓' : 'Guardar reglas'}
      </button>
    </Card>
  );
}

function ShiftsCard() {
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = () => void api<Shift[]>('/api/shifts').then(setShifts);
  useEffect(load, []);

  async function saveShift(shift: Shift) {
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
      {error && <p className="mt-3 text-sm font-semibold text-bad">{error}</p>}
    </Card>
  );
}

function ShiftEditor({ shift, onSave }: { shift: Shift; onSave: (s: Shift) => Promise<void> }) {
  const [s, setS] = useState(shift);
  const [saved, setSaved] = useState(false);
  const meal: MealWindow | undefined = s.meal_windows[0];

  return (
    <div className="rounded-lg border border-line p-3">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <label className="block">
          <span className="mb-1 block text-xs font-semibold text-ink-soft">Nombre</span>
          <input className={inputCls} value={s.name} onChange={(e) => setS({ ...s, name: e.target.value })} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-semibold text-ink-soft">Entrada</span>
          <input type="time" className={inputCls} value={s.start_time.slice(0, 5)} onChange={(e) => setS({ ...s, start_time: e.target.value })} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-semibold text-ink-soft">Salida</span>
          <input type="time" className={inputCls} value={s.end_time.slice(0, 5)} onChange={(e) => setS({ ...s, end_time: e.target.value })} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-semibold text-ink-soft">Tolerancia (min)</span>
          <input type="number" min={0} max={120} className={inputCls} value={s.tolerance_minutes} onChange={(e) => setS({ ...s, tolerance_minutes: Number(e.target.value) })} />
        </label>
      </div>
      <div className="mt-2 flex items-end gap-2">
        <label className="block">
          <span className="mb-1 block text-xs font-semibold text-ink-soft">Comida de</span>
          <input
            type="time"
            className={inputCls}
            value={meal?.start ?? ''}
            onChange={(e) =>
              setS({ ...s, meal_windows: e.target.value ? [{ name: 'Comida', start: e.target.value, end: meal?.end ?? e.target.value, paid: false }] : [] })
            }
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-semibold text-ink-soft">a</span>
          <input
            type="time"
            className={inputCls}
            value={meal?.end ?? ''}
            disabled={!meal}
            onChange={(e) => meal && setS({ ...s, meal_windows: [{ ...meal, end: e.target.value }] })}
          />
        </label>
        <span className="pb-2 text-xs text-ink-soft">(vacío = turno sin comida)</span>
        <div className="flex-1" />
        <button
          onClick={() => {
            void onSave(s).then(() => {
              setSaved(true);
              setTimeout(() => setSaved(false), 2000);
            });
          }}
          className="rounded-lg border border-wine-500 px-3 py-2 text-sm font-bold text-wine-600 hover:bg-wine-50"
        >
          {saved ? 'Guardado ✓' : 'Guardar'}
        </button>
      </div>
    </div>
  );
}

function AreasCard() {
  const [areas, setAreas] = useState<Area[]>([]);
  const [name, setName] = useState('');

  const load = () => void api<Area[]>('/api/areas').then(setAreas);
  useEffect(load, []);

  async function add() {
    if (!name.trim()) return;
    await api('/api/areas', { method: 'POST', body: JSON.stringify({ name: name.trim() }) });
    setName('');
    load();
  }

  return (
    <Card title="Áreas de trabajo">
      <ul className="flex flex-wrap gap-2">
        {areas.map((a) => (
          <li key={a.id} className="rounded-full border border-line bg-surface px-3 py-1 text-sm font-semibold">
            {a.name}
          </li>
        ))}
      </ul>
      <div className="mt-3 flex gap-2">
        <input className={inputCls} placeholder="Nueva área…" value={name} onChange={(e) => setName(e.target.value)} />
        <button onClick={() => void add()} className="rounded-lg bg-wine-600 px-4 py-2 text-sm font-bold text-white hover:bg-wine-700">
          Agregar
        </button>
      </div>
    </Card>
  );
}

function UsersCard({ currentUserId }: { currentUserId: string }) {
  const [users, setUsers] = useState<User[]>([]);
  const [form, setForm] = useState({ name: '', email: '', password: '', role: 'supervisor' as 'admin' | 'supervisor' });
  const [error, setError] = useState<string | null>(null);

  const load = () => void api<User[]>('/api/users').then(setUsers);
  useEffect(load, []);

  async function add() {
    setError(null);
    try {
      await api('/api/users', { method: 'POST', body: JSON.stringify(form) });
      setForm({ name: '', email: '', password: '', role: 'supervisor' });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Error al crear usuario');
    }
  }

  async function toggleActive(u: User) {
    setError(null);
    try {
      await api(`/api/users/${u.id}`, { method: 'PATCH', body: JSON.stringify({ active: !u.active }) });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Error');
    }
  }

  return (
    <Card title="Usuarios del sistema">
      <ul className="divide-y divide-line">
        {users.map((u) => (
          <li key={u.id} className="flex items-center justify-between py-2 text-sm">
            <span>
              <span className="font-semibold">{u.name}</span>{' '}
              <span className="text-ink-soft">· {u.email} · {u.role}</span>
            </span>
            {u.id !== currentUserId && (
              <button
                onClick={() => void toggleActive(u)}
                className={`rounded-lg border border-line px-2.5 py-1 text-xs font-semibold hover:bg-surface ${u.active ? 'text-bad' : 'text-ok'}`}
              >
                {u.active ? 'Desactivar' : 'Activar'}
              </button>
            )}
          </li>
        ))}
      </ul>
      <div className="mt-4 grid grid-cols-2 gap-2">
        <input className={inputCls} placeholder="Nombre" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <input className={inputCls} placeholder="Correo" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        <input className={inputCls} type="password" placeholder="Contraseña (mín. 8)" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        <select className={inputCls} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as 'admin' | 'supervisor' })}>
          <option value="supervisor">Supervisor</option>
          <option value="admin">Admin</option>
        </select>
      </div>
      {error && <p className="mt-2 text-sm font-semibold text-bad">{error}</p>}
      <button
        onClick={() => void add()}
        disabled={!form.name || !form.email || form.password.length < 8}
        className="mt-3 rounded-lg bg-wine-600 px-4 py-2 text-sm font-bold text-white hover:bg-wine-700 disabled:opacity-40"
      >
        Crear usuario
      </button>
    </Card>
  );
}
