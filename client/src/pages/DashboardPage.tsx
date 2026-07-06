import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { AttendanceDayResponse, DayDetailRow } from '@clockai/shared';
import { api } from '../api';

const REFRESH_MS = 30_000;

function timeOf(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('es-MX', {
    timeZone: 'America/Mexico_City',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function DashboardPage() {
  const [data, setData] = useState<AttendanceDayResponse | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await api<AttendanceDayResponse>('/api/attendance/today');
        if (alive) {
          setData(res);
          setUpdatedAt(new Date());
        }
      } catch {
        /* siguiente ciclo lo reintenta */
      }
    };
    void load();
    const interval = setInterval(() => void load(), REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(interval);
    };
  }, []);

  if (!data) return <p className="p-8 text-ink-soft">Cargando…</p>;

  const inside = data.rows.filter((r) => r.calc.state === 'in' || r.calc.state === 'meal');
  const lates = data.rows.filter((r) => r.calc.late);
  const anomalies = data.rows.filter((r) => r.calc.anomalies.length > 0);

  // Agrupar quién está adentro por área
  const byArea = new Map<string, DayDetailRow[]>();
  for (const row of inside) {
    const area = row.area_name ?? 'Sin área asignada';
    byArea.set(area, [...(byArea.get(area) ?? []), row]);
  }

  // Contadores por turno (de los presentes)
  const byShift = new Map<string, number>();
  for (const row of inside) {
    const shift = row.shift_name ?? 'Sin turno';
    byShift.set(shift, (byShift.get(shift) ?? 0) + 1);
  }

  return (
    <div className="p-6">
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-2xl font-bold">Hoy — {data.date}</h1>
        <span className="text-xs text-ink-soft">
          Actualizado {updatedAt?.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
          {' · '}se refresca cada 30s
        </span>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Adentro ahora" value={inside.length} tone="ok" />
        <Stat label="Checaron hoy" value={data.rows.length} />
        <Stat label="Retardos" value={lates.length} tone={lates.length ? 'warn' : undefined} />
        <Stat label="Días con anomalías" value={anomalies.length} tone={anomalies.length ? 'bad' : undefined} />
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {[...byShift.entries()].map(([shift, count]) => (
          <span key={shift} className="rounded-full border border-line bg-card px-3 py-1 text-sm font-semibold">
            {shift}: <span className="tabular-nums">{count}</span> adentro
          </span>
        ))}
      </div>

      <h2 className="mt-8 text-lg font-bold">Quién está adentro, por área</h2>
      {!inside.length ? (
        <p className="mt-2 text-ink-soft">Nadie adentro en este momento.</p>
      ) : (
        <div className="mt-3 grid gap-4 md:grid-cols-2">
          {[...byArea.entries()].map(([area, rows]) => (
            <div key={area} className="rounded-xl border border-line bg-card p-4">
              <h3 className="flex items-baseline justify-between font-bold">
                {area}
                <span className="text-sm font-semibold text-ink-soft">{rows.length}</span>
              </h3>
              <ul className="mt-2 divide-y divide-line">
                {rows.map((r) => (
                  <li key={r.employee_id} className="flex items-center justify-between py-1.5 text-sm">
                    <span>
                      <span className="font-bold tabular-nums">#{r.employee_number}</span>{' '}
                      <span className="font-semibold">{r.full_name}</span>
                    </span>
                    <span className="flex items-center gap-2">
                      {r.calc.state === 'meal' && (
                        <span className="rounded-full bg-warn/10 px-2 py-0.5 text-xs font-bold text-warn">Comida</span>
                      )}
                      {r.calc.late && (
                        <span className="rounded-full bg-bad/10 px-2 py-0.5 text-xs font-bold text-bad">Retardo</span>
                      )}
                      <span className="tabular-nums text-ink-soft">desde {timeOf(r.calc.shift_in)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {(lates.length > 0 || anomalies.length > 0) && (
        <div className="mt-8 grid gap-4 md:grid-cols-2">
          {lates.length > 0 && (
            <div className="rounded-xl border border-line bg-card p-4">
              <h3 className="font-bold text-warn">Retardos del día</h3>
              <ul className="mt-2 divide-y divide-line text-sm">
                {lates.map((r) => (
                  <li key={r.employee_id} className="flex justify-between py-1.5">
                    <span className="font-semibold">
                      #{r.employee_number} {r.full_name}
                    </span>
                    <span className="tabular-nums text-ink-soft">
                      {timeOf(r.calc.shift_in)} (+{r.calc.late_minutes} min)
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {anomalies.length > 0 && (
            <div className="rounded-xl border border-line bg-card p-4">
              <h3 className="font-bold text-bad">Anomalías pendientes</h3>
              <ul className="mt-2 divide-y divide-line text-sm">
                {anomalies.map((r) => (
                  <li key={r.employee_id} className="py-1.5">
                    <span className="font-semibold">
                      #{r.employee_number} {r.full_name}
                    </span>
                    <span className="text-ink-soft"> — {r.calc.anomalies.map((a) => a.detail).join('; ')}</span>
                  </li>
                ))}
              </ul>
              <Link to="/attendance" className="mt-3 inline-block text-sm font-bold text-wine-600 hover:underline">
                Ir a Asistencia para corregir →
              </Link>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'ok' | 'warn' | 'bad' }) {
  const toneCls = tone === 'ok' ? 'text-ok' : tone === 'warn' ? 'text-warn' : tone === 'bad' ? 'text-bad' : 'text-ink';
  return (
    <div className="rounded-xl border border-line bg-card p-4">
      <div className={`text-3xl font-extrabold tabular-nums ${toneCls}`}>{value}</div>
      <div className="mt-1 text-sm font-semibold text-ink-soft">{label}</div>
    </div>
  );
}
