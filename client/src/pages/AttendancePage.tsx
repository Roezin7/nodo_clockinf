import { useCallback, useEffect, useState } from 'react';
import type { AttendanceDayResponse, DayDetailPunch, DayDetailRow, PunchType } from '@clockai/shared';
import { api, ApiError } from '../api';
import { useAuth } from '../hooks/useAuth';
import { Modal } from './EmployeesPage';
import { PUNCH_TYPE_LABELS } from '../components/PunchHistoryModal';

function todayLocal(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(new Date());
}

function timeOf(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('es-MX', {
    timeZone: 'America/Mexico_City',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function fmtMinutes(min: number): string {
  return `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`;
}

interface CorrectionState {
  row: DayDetailRow;
  /** Checada a anular (opcional: una corrección puede solo agregar). */
  target?: DayDetailPunch;
}

export default function AttendancePage() {
  const user = useAuth();
  const isAdmin = user?.role === 'admin';
  const [date, setDate] = useState(todayLocal());
  const [data, setData] = useState<AttendanceDayResponse | null>(null);
  const [correction, setCorrection] = useState<CorrectionState | null>(null);

  const load = useCallback(async () => {
    setData(await api<AttendanceDayResponse>(`/api/attendance/day/${date}`));
  }, [date]);

  useEffect(() => {
    setData(null);
    void load();
  }, [load]);

  return (
    <div className="p-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold">Asistencia diaria</h1>
        <div className="flex-1" />
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="rounded-lg border border-line bg-card px-3 py-2 text-sm outline-none focus:border-wine-500"
        />
      </div>

      {!data ? (
        <p className="mt-6 text-ink-soft">Cargando…</p>
      ) : !data.rows.length ? (
        <p className="mt-6 text-ink-soft">Sin checadas el {date}.</p>
      ) : (
        <div className="mt-4 overflow-x-auto rounded-xl border border-line bg-card">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs font-bold uppercase tracking-wide text-ink-soft">
                <th className="px-4 py-3">Empleado</th>
                <th className="px-4 py-3">Turno / Área</th>
                <th className="px-4 py-3">Checadas</th>
                <th className="px-4 py-3">Comida</th>
                <th className="px-4 py-3">Horas</th>
                <th className="px-4 py-3">Flags</th>
                {isAdmin && <th className="px-4 py-3 text-right">Corregir</th>}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row) => (
                <tr key={row.employee_id} className="border-b border-line align-top last:border-0 hover:bg-surface">
                  <td className="px-4 py-3">
                    <span className="font-bold tabular-nums">#{row.employee_number}</span>{' '}
                    <span className="font-semibold">{row.full_name}</span>
                  </td>
                  <td className="px-4 py-3 text-ink-soft">
                    {row.shift_name ?? '—'}
                    {row.area_name ? ` · ${row.area_name}` : ''}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1.5">
                      {row.punches.map((p) => (
                        <span
                          key={p.id}
                          title={p.correction_reason ?? undefined}
                          className={`rounded-lg border px-2 py-0.5 text-xs font-semibold tabular-nums ${
                            p.voided
                              ? 'border-line text-ink-soft line-through opacity-50'
                              : p.source === 'manual'
                                ? 'border-wine-500 bg-wine-50 text-wine-700'
                                : 'border-line bg-surface'
                          }`}
                        >
                          {PUNCH_TYPE_LABELS[p.punch_type]} {timeOf(p.punched_at)}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-4 py-3 tabular-nums">{row.calc.meal_minutes} min</td>
                  <td className="px-4 py-3 font-bold tabular-nums">{fmtMinutes(row.calc.worked_minutes)}</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {row.calc.late && (
                        <span className="rounded-full bg-bad/10 px-2 py-0.5 text-xs font-bold text-bad">
                          Retardo +{row.calc.late_minutes}m
                        </span>
                      )}
                      {!row.calc.complete && (
                        <span className="rounded-full bg-warn/10 px-2 py-0.5 text-xs font-bold text-warn">
                          Incompleto
                        </span>
                      )}
                      {row.calc.anomalies.map((a, i) => (
                        <span key={i} title={a.detail} className="rounded-full bg-bad/10 px-2 py-0.5 text-xs font-bold text-bad">
                          {a.type}
                        </span>
                      ))}
                    </div>
                  </td>
                  {isAdmin && (
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => setCorrection({ row })}
                        className="rounded-lg border border-line px-2.5 py-1 text-xs font-semibold hover:bg-surface"
                      >
                        Corregir
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {correction && (
        <CorrectionModal
          state={correction}
          date={date}
          onDone={() => {
            setCorrection(null);
            void load();
          }}
          onClose={() => setCorrection(null)}
        />
      )}
    </div>
  );
}

function CorrectionModal({
  state,
  date,
  onDone,
  onClose,
}: {
  state: CorrectionState;
  date: string;
  onDone: () => void;
  onClose: () => void;
}) {
  const { row } = state;
  const [mode, setMode] = useState<'add' | 'void'>('add');
  const [punchType, setPunchType] = useState<PunchType>('shift_out');
  const [time, setTime] = useState('17:00');
  const [targetId, setTargetId] = useState<string>('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const activePunches = row.punches.filter((p) => !p.voided);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      if (mode === 'add') {
        await api('/api/punches/manual', {
          method: 'POST',
          body: JSON.stringify({
            employee_id: row.employee_id,
            punch_type: punchType,
            punched_at: `${date}T${time}:00-06:00`,
            reason,
            correction_of: targetId || null,
          }),
        });
      } else {
        await api(`/api/punches/${targetId}/void`, { method: 'POST', body: JSON.stringify({ reason }) });
      }
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Error al guardar');
      setBusy(false);
    }
  }

  const inputCls = 'w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-wine-500';

  return (
    <Modal title={`Corrección — #${row.employee_number} ${row.full_name} (${date})`} onClose={onClose}>
      <div className="grid gap-3">
        <div className="flex gap-2">
          <button
            onClick={() => setMode('add')}
            className={`flex-1 rounded-lg border px-3 py-2 text-sm font-bold ${mode === 'add' ? 'border-wine-500 bg-wine-50 text-wine-700' : 'border-line'}`}
          >
            Agregar checada
          </button>
          <button
            onClick={() => {
              setMode('void');
              setTargetId(activePunches[0]?.id ?? '');
            }}
            className={`flex-1 rounded-lg border px-3 py-2 text-sm font-bold ${mode === 'void' ? 'border-wine-500 bg-wine-50 text-wine-700' : 'border-line'}`}
          >
            Anular checada
          </button>
        </div>

        {mode === 'add' ? (
          <>
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="mb-1 block text-sm font-semibold">Tipo</span>
                <select className={inputCls} value={punchType} onChange={(e) => setPunchType(e.target.value as PunchType)}>
                  {Object.entries(PUNCH_TYPE_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-sm font-semibold">Hora (local planta)</span>
                <input type="time" className={inputCls} value={time} onChange={(e) => setTime(e.target.value)} />
              </label>
            </div>
            <label className="block">
              <span className="mb-1 block text-sm font-semibold">Anular también una checada existente (opcional)</span>
              <select className={inputCls} value={targetId} onChange={(e) => setTargetId(e.target.value)}>
                <option value="">— No anular ninguna —</option>
                {activePunches.map((p) => (
                  <option key={p.id} value={p.id}>
                    {PUNCH_TYPE_LABELS[p.punch_type]} {timeOf(p.punched_at)}
                  </option>
                ))}
              </select>
            </label>
          </>
        ) : (
          <label className="block">
            <span className="mb-1 block text-sm font-semibold">Checada a anular</span>
            <select className={inputCls} value={targetId} onChange={(e) => setTargetId(e.target.value)}>
              {activePunches.map((p) => (
                <option key={p.id} value={p.id}>
                  {PUNCH_TYPE_LABELS[p.punch_type]} {timeOf(p.punched_at)}
                </option>
              ))}
            </select>
          </label>
        )}

        <label className="block">
          <span className="mb-1 block text-sm font-semibold">Razón (obligatoria)</span>
          <textarea
            className={inputCls}
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Ej.: Empleado olvidó checar salida; confirmado con supervisor"
          />
        </label>

        {error && <p className="text-sm font-semibold text-bad">{error}</p>}
        <div className="mt-1 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg border border-line px-4 py-2 text-sm font-semibold hover:bg-surface">
            Cancelar
          </button>
          <button
            onClick={() => void submit()}
            disabled={busy || reason.trim().length < 3 || (mode === 'void' && !targetId)}
            className="rounded-lg bg-wine-600 px-4 py-2 text-sm font-bold text-white hover:bg-wine-700 disabled:opacity-50"
          >
            {busy ? 'Guardando…' : 'Guardar corrección'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
