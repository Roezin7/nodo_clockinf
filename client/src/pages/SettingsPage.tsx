import { useEffect, useState } from 'react';
import { Copy, MonitorSmartphone, RefreshCw, ShieldOff, X } from 'lucide-react';
import type { Area, MealWindow, Plant, Settings, Shift, User, UserRole } from '@clockai/shared';
import type { Device } from '@clockai/shared';
import { ALLOWED_TIMEZONES } from '@clockai/shared';
import { api, ApiError } from '../api';
import { useAuth } from '../hooks/useAuth';
import { setAppTimezone } from '../time';
import { kioskNamesToReachTarget } from '../kiosk/deviceNames';
import { PageHeader } from '../components/layout/PageHeader';
import { Badge, Button, Field, Input, Select, StatusBadge, useToast } from '../components/ui';

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
        <DevicesCard />
        <ShiftsCard />
        <AreasCard />
        <UsersCard currentUserId={user!.id} />
      </div>
    </div>
  );
}

type ManagedDevice = Device;

interface CreatedDevice extends Partial<ManagedDevice> {
  id: string;
  name: string;
  plant_id: string;
  enrollment_token: string;
}

interface ActivationLink {
  id: string;
  name: string;
  plantName: string;
  url: string;
}

function deviceHealth(device: ManagedDevice): { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' } {
  if (!device.active) return { label: 'Revocado', tone: 'neutral' };
  if (!device.last_seen_at) return { label: 'Sin activar', tone: 'warning' };
  const age = Date.now() - new Date(device.last_seen_at).getTime();
  if (age <= 90_000) return { label: 'En línea', tone: 'success' };
  if (age <= 10 * 60_000) return { label: 'Sin señal reciente', tone: 'warning' };
  return { label: 'Fuera de línea', tone: 'danger' };
}

function dateTime(value: string | null): string {
  if (!value) return 'Nunca';
  return new Intl.DateTimeFormat('es-US', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value));
}

function DevicesCard() {
  const toast = useToast();
  const [devices, setDevices] = useState<ManagedDevice[]>([]);
  const [plants, setPlants] = useState<Plant[]>([]);
  const [plantId, setPlantId] = useState('');
  const [name, setName] = useState('');
  const [activations, setActivations] = useState<ActivationLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load(): Promise<void> {
    setLoading(true);
    try {
      const [deviceRows, plantRows] = await Promise.all([
        api<ManagedDevice[]>('/api/devices'),
        api<Plant[]>('/api/plants'),
      ]);
      setDevices(deviceRows);
      setPlants(plantRows);
      setPlantId((current) => current || plantRows.find((plant) => plant.active)?.id || '');
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No fue posible cargar los checadores');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function createDevice(targetPlantId: string, deviceName: string): Promise<void> {
    const created = await api<CreatedDevice>('/api/devices', {
      method: 'POST',
      body: JSON.stringify({ plant_id: targetPlantId, name: deviceName }),
    });
    const plant = plants.find((candidate) => candidate.id === targetPlantId);
    // El secreto va en fragmento: el navegador no lo envía a proxies ni access logs.
    const url = `${window.location.origin}/kiosk#enroll=${encodeURIComponent(created.enrollment_token)}`;
    setActivations((current) => [
      ...current,
      { id: created.id, name: created.name, plantName: plant?.name ?? 'Planta', url },
    ]);
  }

  async function createOne(): Promise<void> {
    if (!plantId || !name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await createDevice(plantId, name.trim());
      setName('');
      toast('Checador creado; copia ahora su enlace de activación');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No fue posible crear el checador');
    } finally {
      setSaving(false);
    }
  }

  async function fillTwoPerPlant(): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      let createdCount = 0;
      for (const plant of plants.filter((candidate) => candidate.active)) {
        for (const deviceName of kioskNamesToReachTarget(devices, plant.id)) {
          await createDevice(plant.id, deviceName);
          createdCount += 1;
        }
      }
      toast(createdCount ? `${createdCount} checador(es) creado(s)` : 'Las plantas ya tienen dos checadores activos');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No fue posible completar los checadores');
    } finally {
      setSaving(false);
    }
  }

  async function copyActivation(link: ActivationLink): Promise<void> {
    try {
      await navigator.clipboard.writeText(link.url);
      toast(`Enlace de ${link.name} copiado`);
    } catch {
      setError('El navegador no permitió copiar. Selecciona el enlace manualmente.');
    }
  }

  async function revoke(device: ManagedDevice): Promise<void> {
    const reason = window.prompt(`Motivo para revocar ${device.name}:`);
    if (!reason?.trim()) return;
    try {
      await api(`/api/devices/${device.id}/revoke`, {
        method: 'POST',
        body: JSON.stringify({ reason: reason.trim() }),
      });
      toast('Checador revocado');
      await load();
    } catch (err) {
      if (
        err instanceof ApiError &&
        err.code === 'device_has_pending_events' &&
        window.confirm(
          `${err.message}\n\nSi la tablet se perdió o ya no puede sincronizar, puedes revocarla de todos modos. ` +
          'Los eventos que sólo existan en esa tablet no podrán recuperarse. ¿Forzar revocación?'
        )
      ) {
        try {
          await api(`/api/devices/${device.id}/revoke`, {
            method: 'POST',
            body: JSON.stringify({ reason: reason.trim(), force: true }),
          });
          toast('Checador revocado por excepción');
          await load();
          return;
        } catch (forceError) {
          setError(forceError instanceof ApiError ? forceError.message : 'No fue posible forzar la revocación');
          return;
        }
      }
      setError(err instanceof ApiError ? err.message : 'No fue posible revocar');
    }
  }

  async function reissue(device: ManagedDevice): Promise<void> {
    if (device.enrolled_at) {
      setError('Solo se puede reemitir una credencial antes de que el checador sea enrolado.');
      return;
    }
    const reason = window.prompt(`Motivo para reemitir la credencial de ${device.name}:`);
    if (reason === null) return;
    if (reason.trim().length < 3) {
      setError('El motivo de reemisión debe tener al menos 3 caracteres.');
      return;
    }
    try {
      const created = await api<CreatedDevice>(`/api/devices/${device.id}/reissue`, {
        method: 'POST',
        body: JSON.stringify({ reason: reason.trim() }),
      });
      setActivations((current) => [
        ...current.filter((link) => link.id !== device.id),
        {
          id: device.id,
          name: device.name,
          plantName: device.plant_name,
          url: `${window.location.origin}/kiosk#enroll=${encodeURIComponent(created.enrollment_token)}`,
        },
      ]);
      setError(null);
      toast('Credencial reemitida; el enlace anterior dejó de ser válido');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No fue posible reemitir la credencial');
    }
  }

  const missingCount = plants
    .filter((plant) => plant.active)
    .reduce((total, plant) => {
      const count = devices.filter((device) => device.plant_id === plant.id && device.active).length;
      return total + Math.max(0, 2 - count);
    }, 0);

  return (
    <Card title="Checadores por planta">
      <div className="mb-4 flex items-start justify-between gap-3 rounded-control border border-info/25 bg-info-subtle p-3 text-13">
        <div>
          <p className="font-semibold text-ink">Meta operativa: dos checadores activos por planta</p>
          <p className="mt-1 text-ink-secondary">
            {missingCount ? `Faltan ${missingCount} para cubrir las tres plantas.` : 'Cobertura completa.'}
          </p>
        </div>
        <Button variant="secondary" size="sm" loading={saving} onClick={() => void fillTwoPerPlant()}>
          Completar 2/planta
        </Button>
      </div>

      {activations.length > 0 && (
        <div className="mb-5 rounded-control border border-warning/40 bg-warning-subtle p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-14 font-semibold text-warning">Enlaces de activación — se muestran sólo ahora</p>
              <p className="mt-1 text-12 text-ink-secondary">Abre cada enlace en la tablet asignada. No lo envíes a personal no autorizado.</p>
            </div>
            <button onClick={() => setActivations([])} className="text-ink-tertiary" aria-label="Ocultar enlaces">
              <X size={18} />
            </button>
          </div>
          <ul className="mt-3 space-y-3">
            {activations.map((link) => (
              <li key={link.id} className="rounded-control bg-raised p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-13 font-semibold">{link.plantName} · {link.name}</p>
                    <input
                      readOnly
                      value={link.url}
                      onFocus={(event) => event.currentTarget.select()}
                      className="mt-1 w-full truncate bg-transparent font-mono text-11 text-ink-tertiary outline-none"
                      aria-label={`Enlace de ${link.name}`}
                    />
                  </div>
                  <Button variant="secondary" size="sm" onClick={() => void copyActivation(link)}>
                    <Copy size={14} /> Copiar
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mb-4 grid grid-cols-[1fr_1fr_auto] items-end gap-3">
        <Field label="Planta">
          <Select value={plantId} onChange={(event) => setPlantId(event.target.value)}>
            <option value="">Selecciona…</option>
            {plants.filter((plant) => plant.active).map((plant) => (
              <option key={plant.id} value={plant.id}>{plant.name}</option>
            ))}
          </Select>
        </Field>
        <Field label="Nombre del checador">
          <Input placeholder="Kiosco 1" value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        <div className="mb-6">
          <Button loading={saving} disabled={!plantId || !name.trim()} onClick={() => void createOne()}>
            Crear
          </Button>
        </div>
      </div>

      {error && <p className="mb-3 text-12 font-medium text-danger" role="alert">{error}</p>}
      {loading ? (
        <p className="text-13 text-ink-secondary">Cargando checadores…</p>
      ) : (
        <ul className="divide-y divide-line">
          {devices.map((device) => {
            const health = deviceHealth(device);
            return (
              <li key={device.id} className="py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 gap-3">
                    <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-control bg-sunken text-ink-secondary">
                      <MonitorSmartphone size={18} />
                    </div>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-medium">{device.name}</p>
                        <Badge tone={health.tone}>{health.label}</Badge>
                        {device.pending_event_count > 0 && <Badge tone="warning">{device.pending_event_count} pendientes</Badge>}
                        {device.rejected_event_count > 0 && <Badge tone="danger">{device.rejected_event_count} rechazadas</Badge>}
                      </div>
                      <p className="mt-1 text-12 text-ink-tertiary">
                        {device.plant_name} · ID {device.public_id} · app {device.app_version ?? 'sin reportar'}
                      </p>
                      <p className="mt-1 text-12 text-ink-secondary">
                        Señal: {dateTime(device.last_seen_at)} · Última sincronización: {dateTime(device.last_sync_at)}
                      </p>
                      {(device.camera_status === 'unavailable' || device.camera_status === 'degraded' ||
                        device.storage_status === 'unavailable' || device.storage_status === 'degraded' || device.last_error) && (
                        <p className="mt-1 text-12 font-medium text-danger">
                          {device.camera_status === 'unavailable' ? 'Cámara no disponible. ' : ''}
                          {device.camera_status === 'degraded' ? 'Cámara degradada. ' : ''}
                          {device.storage_status === 'unavailable' ? 'Almacenamiento local no disponible. ' : ''}
                          {device.storage_status === 'degraded' ? 'Almacenamiento local degradado. ' : ''}
                          {device.last_error ?? ''}
                        </p>
                      )}
                    </div>
                  </div>
                  {device.active && (
                    <div className="flex shrink-0 items-center gap-1">
                      {!device.enrolled_at && (
                        <Button variant="secondary" size="sm" onClick={() => void reissue(device)}>
                          <RefreshCw size={14} /> Reemitir acceso
                        </Button>
                      )}
                      <Button variant="ghost" size="sm" onClick={() => void revoke(device)}>
                        <ShieldOff size={14} /> Revocar
                      </Button>
                    </div>
                  )}
                </div>
              </li>
            );
          })}
          {!devices.length && <li className="py-5 text-center text-13 text-ink-secondary">Aún no hay checadores.</li>}
        </ul>
      )}
      <div className="mt-3 flex justify-end">
        <Button variant="ghost" size="sm" onClick={() => void load()}>
          <RefreshCw size={14} /> Actualizar salud
        </Button>
      </div>
    </Card>
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
      const updated = await api<Settings>('/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({
          timezone: settings.timezone,
          photo_retention_weeks: settings.photo_retention_weeks,
          duplicate_window_minutes: settings.duplicate_window_minutes,
        }),
      });
      setSettings(updated);
      setAppTimezone(updated.timezone); // toda la UI cambia de zona al instante
      toast('Configuración guardada');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Error al guardar');
    } finally {
      setSaving(false);
    }
  }

  if (!settings) return <Card title="Reglas de nómina">Cargando…</Card>;

  return (
    <Card title="Política y zona horaria">
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
        <div className="mb-4 rounded-control border border-accent/20 bg-accent-subtle p-4 text-13 text-ink-secondary">
          <p className="font-semibold text-ink">California Standard 8/40</p>
          <p className="mt-1">8 horas regulares; 1.5× después de 8 y hasta 12; 2× después de 12. También aplica 40 horas semanales y séptimo día. Semana: domingo a sábado.</p>
          <p className="mt-1">Esta política legal está bloqueada y no puede sustituirse por una regla interna.</p>
        </div>
        <div className="grid grid-cols-2 gap-4">
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
  const [plants, setPlants] = useState<Plant[]>([]);
  const [form, setForm] = useState({
    name: '', email: '', password: '', role: 'foreman' as Exclude<UserRole, 'platform_operator'>,
    plant_ids: [] as string[],
  });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = (): void => void api<User[]>('/api/users').then(setUsers);
  useEffect(() => {
    load();
    void api<Plant[]>('/api/plants').then(setPlants);
  }, []);

  async function add(): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      await api('/api/users', { method: 'POST', body: JSON.stringify(form) });
      toast('Usuario creado');
      setForm({ name: '', email: '', password: '', role: 'foreman', plant_ids: [] });
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
          <Select
            value={form.role}
            onChange={(e) => {
              const role = e.target.value as Exclude<UserRole, 'platform_operator'>;
              setForm({ ...form, role, plant_ids: role === 'foreman' ? form.plant_ids.slice(0, 1) : [] });
            }}
          >
            <option value="foreman">Foreman</option>
            <option value="accountant">Contadora</option>
            <option value="admin">Admin</option>
          </Select>
        </Field>
        {form.role === 'foreman' && (
          <Field label="Planta" required>
            <Select
              value={form.plant_ids[0] ?? ''}
              onChange={(e) => setForm({ ...form, plant_ids: e.target.value ? [e.target.value] : [] })}
            >
              <option value="">Selecciona…</option>
              {plants.filter((plant) => plant.active).map((plant) => (
                <option key={plant.id} value={plant.id}>{plant.name}</option>
              ))}
            </Select>
          </Field>
        )}
      </div>
      <Button
        onClick={() => void add()}
        loading={saving}
        disabled={!form.name || !form.email || form.password.length < 8 || (form.role === 'foreman' && form.plant_ids.length !== 1)}
      >
        Crear usuario
      </Button>
    </Card>
  );
}
