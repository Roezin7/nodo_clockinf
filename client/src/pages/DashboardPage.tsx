import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CalendarCheck } from 'lucide-react';
import type { AttendanceDayResponse, DayDetailRow } from '@clockai/shared';
import { api } from '../api';
import { fmtTime, useAppTimezone } from '../time';
import { PageHeader } from '../components/layout/PageHeader';
import { EmptyState, KpiSkeleton, StatusBadge, Table, TableSkeleton, TD, TH, THead, TRow } from '../components/ui';

const REFRESH_MS = 30_000;

export default function DashboardPage() {
  useAppTimezone(); // re-render si cambia la zona de la planta
  const navigate = useNavigate();
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

  if (!data) {
    return (
      <div>
        <PageHeader title="Hoy" />
        <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
          <KpiSkeleton />
          <KpiSkeleton />
          <KpiSkeleton />
          <KpiSkeleton />
        </div>
        <TableSkeleton rows={6} cols={5} />
      </div>
    );
  }

  const inside = data.rows.filter((r) => r.calc.state === 'in' || r.calc.state === 'meal');
  const atMeal = data.rows.filter((r) => r.calc.state === 'meal');
  const lates = data.rows.filter((r) => r.calc.late);
  const anomalies = data.rows.filter((r) => r.calc.anomalies.length > 0);

  // Agrupar presentes por área para la tabla en vivo
  const byArea = new Map<string, DayDetailRow[]>();
  for (const row of inside) {
    const area = row.area_name ?? 'Sin área asignada';
    byArea.set(area, [...(byArea.get(area) ?? []), row]);
  }
  const areas = [...byArea.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  return (
    <div>
      <PageHeader
        title="Hoy"
        meta={
          <span className="text-13 text-ink-tertiary">
            {data.date} · actualizado <span className="tnum">{updatedAt ? fmtTime(updatedAt.toISOString()) : '—'}</span> · cada 30s
          </span>
        }
      />

      {/* KPIs: números en Hanken 40 tabular. Son navegación, no decoración. */}
      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Kpi label="Adentro ahora" value={inside.length} tone="text-success" onClick={() => scrollToTable()} />
        <Kpi label="Retardos hoy" value={lates.length} tone={lates.length ? 'text-warning' : 'text-ink'} onClick={() => navigate('/attendance')} />
        <Kpi label="En comida" value={atMeal.length} tone={atMeal.length ? 'text-info' : 'text-ink'} onClick={() => scrollToTable()} />
        <Kpi
          label="Anomalías pendientes"
          value={anomalies.length}
          tone={anomalies.length ? 'text-danger' : 'text-ink'}
          onClick={() => navigate('/attendance')}
        />
      </div>

      <h2 className="mb-3 text-18 font-semibold" id="live-table">
        Adentro ahora, por área
      </h2>
      {!inside.length ? (
        <div className="rounded-card border border-line bg-raised shadow-card">
          <EmptyState icon={CalendarCheck} title="Nadie adentro en este momento." />
        </div>
      ) : (
        <Table>
          <THead>
            <tr>
              <TH>Área</TH>
              <TH>Empleado</TH>
              <TH>Estado</TH>
              <TH num>Entrada</TH>
            </tr>
          </THead>
          <tbody>
            {areas.flatMap(([area, rows]) =>
              rows.map((r, i) => (
                <TRow key={r.employee_id} flag={r.calc.late ? 'warning' : null}>
                  <TD className={i === 0 ? 'font-semibold' : 'text-ink-tertiary'}>
                    {i === 0 ? `${area} (${rows.length})` : ''}
                  </TD>
                  <TD>
                    <span className="tnum font-semibold">#{r.employee_number}</span>{' '}
                    <span className="font-medium">{r.full_name}</span>
                  </TD>
                  <TD>
                    <span className="inline-flex gap-1.5">
                      <StatusBadge status={r.calc.state === 'meal' ? 'comida' : 'adentro'} />
                      {r.calc.late && <StatusBadge status="retardo" />}
                    </span>
                  </TD>
                  <TD num>{fmtTime(r.calc.shift_in)}</TD>
                </TRow>
              ))
            )}
          </tbody>
        </Table>
      )}

      {(lates.length > 0 || anomalies.length > 0) && (
        <div className="mt-6 grid gap-4 lg:grid-cols-2">
          {lates.length > 0 && (
            <div className="rounded-card border border-line bg-raised p-5 shadow-card">
              <h3 className="mb-2 text-14 font-semibold">Retardos del día</h3>
              <ul className="divide-y divide-line">
                {lates.map((r) => (
                  <li key={r.employee_id} className="flex items-center justify-between py-2 text-14">
                    <span>
                      <span className="tnum font-semibold">#{r.employee_number}</span> {r.full_name}
                    </span>
                    <span className="tnum text-ink-secondary">
                      {fmtTime(r.calc.shift_in)} <span className="text-warning">(+{r.calc.late_minutes} min)</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {anomalies.length > 0 && (
            <div className="rounded-card border border-line bg-raised p-5 shadow-card">
              <h3 className="mb-2 text-14 font-semibold">Anomalías pendientes</h3>
              <ul className="divide-y divide-line">
                {anomalies.map((r) => (
                  <li key={r.employee_id} className="py-2 text-14">
                    <span className="tnum font-semibold">#{r.employee_number}</span>{' '}
                    <span className="font-medium">{r.full_name}</span>
                    <span className="block text-13 text-ink-secondary">
                      {r.calc.anomalies.map((a) => a.detail).join('; ')}
                    </span>
                  </li>
                ))}
              </ul>
              <button
                onClick={() => navigate('/attendance')}
                className="mt-2 text-13 font-medium text-accent hover:text-accent-hover"
              >
                Corregir en Asistencia →
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function scrollToTable(): void {
  document.getElementById('live-table')?.scrollIntoView({ block: 'start' });
}

function Kpi({
  label,
  value,
  tone,
  onClick,
}: {
  label: string;
  value: number;
  tone: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="rounded-card border border-line bg-raised p-5 text-left shadow-card transition-colors duration-150 hover:border-line-strong"
    >
      <span className={`block font-display text-40 font-bold tnum ${tone}`}>{value}</span>
      <span className="mt-1 block text-13 font-medium text-ink-secondary">{label}</span>
    </button>
  );
}
