import { useCallback, useEffect, useState } from 'react';
import { CalendarCheck } from 'lucide-react';
import type { AttendanceDayResponse, DayDetailPunch, DayDetailRow, PunchType } from '@clockai/shared';
import { api, ApiError } from '../api';
import { useAuth } from '../hooks/useAuth';
import { PUNCH_TYPE_LABELS } from '../components/PunchHistoryModal';
import { fmtTime, todayLocal, useAppTimezone } from '../time';
import { PageHeader } from '../components/layout/PageHeader';
import {
  Button,
  EmptyState,
  Field,
  Input,
  Modal,
  Select,
  StatusBadge,
  Table,
  TableSkeleton,
  TD,
  Textarea,
  TH,
  THead,
  TRow,
  useToast,
} from '../components/ui';

function fmtMinutes(min: number): string {
  return `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`;
}

interface CorrectionState {
  row: DayDetailRow;
}

export default function AttendancePage() {
  useAppTimezone(); // re-render si cambia la zona de la planta
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
    <div>
      <PageHeader
        title="Asistencia diaria"
        actions={
          <Input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="w-44"
            aria-label="Fecha"
          />
        }
      />

      {!data ? (
        <TableSkeleton rows={8} cols={6} />
      ) : !data.rows.length ? (
        <div className="rounded-card border border-line bg-raised shadow-card">
          <EmptyState icon={CalendarCheck} title={`Sin checadas el ${date}.`} />
        </div>
      ) : (
        <Table>
          <THead>
            <tr>
              <TH>Empleado</TH>
              <TH>Turno / Área</TH>
              <TH>Checadas</TH>
              <TH num>Comida</TH>
              <TH num>Horas</TH>
              <TH>Estado</TH>
              {isAdmin && <TH className="text-right">Corrección</TH>}
            </tr>
          </THead>
          <tbody>
            {data.rows.map((row) => (
              <TRow
                key={row.employee_id}
                flag={!row.calc.complete ? 'danger' : row.calc.late ? 'warning' : null}
              >
                <TD>
                  <span className="tnum font-semibold">#{row.employee_number}</span>{' '}
                  <span className="font-medium">{row.full_name}</span>
                </TD>
                <TD className="text-ink-secondary">
                  {row.shift_name ?? '—'}
                  {row.area_name ? ` · ${row.area_name}` : ''}
                </TD>
                <TD className="whitespace-normal">
                  <div className="flex max-w-md flex-wrap gap-1.5 py-0.5">
                    {row.punches.map((p) => (
                      <span
                        key={p.id}
                        title={p.correction_reason ?? undefined}
                        className={`tnum inline-flex items-center rounded-control border px-1.5 py-0.5 text-12 font-medium ${
                          p.voided
                            ? 'border-line text-ink-tertiary line-through'
                            : p.source === 'manual'
                              ? 'border-accent-subtle bg-accent-subtle text-accent'
                              : 'border-line bg-sunken text-ink-secondary'
                        }`}
                      >
                        {PUNCH_TYPE_LABELS[p.punch_type]} {fmtTime(p.punched_at)}
                      </span>
                    ))}
                  </div>
                </TD>
                <TD num className="text-ink-secondary">{row.calc.meal_minutes} min</TD>
                <TD num className="font-semibold">{fmtMinutes(row.calc.worked_minutes)}</TD>
                <TD>
                  <span className="inline-flex flex-wrap gap-1.5">
                    {row.calc.late && <StatusBadge status="retardo" />}
                    {!row.calc.complete && <StatusBadge status="incompleto" />}
                    {row.calc.complete && !row.calc.late && row.calc.state === 'out' && (
                      <StatusBadge status="salio" />
                    )}
                    {row.calc.state === 'in' && <StatusBadge status="adentro" />}
                    {row.calc.state === 'meal' && <StatusBadge status="comida" />}
                  </span>
                </TD>
                {isAdmin && (
                  <TD className="text-right">
                    <Button variant="secondary" size="sm" onClick={() => setCorrection({ row })}>
                      Corregir
                    </Button>
                  </TD>
                )}
              </TRow>
            ))}
          </tbody>
        </Table>
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
  const toast = useToast();
  const { row } = state;
  const [mode, setMode] = useState<'add' | 'void'>('add');
  const [punchType, setPunchType] = useState<PunchType>('shift_out');
  const [time, setTime] = useState('17:00');
  const [targetId, setTargetId] = useState<string>('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const activePunches = row.punches.filter((p: DayDetailPunch) => !p.voided);

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      if (mode === 'add') {
        await api('/api/punches/manual', {
          method: 'POST',
          body: JSON.stringify({
            employee_id: row.employee_id,
            punch_type: punchType,
            // Hora LOCAL de planta: el servidor la convierte con su propia zona
            punched_at_local: `${date}T${time}`,
            reason,
            correction_of: targetId || null,
          }),
        });
        toast('Checada manual agregada');
      } else {
        await api(`/api/punches/${targetId}/void`, { method: 'POST', body: JSON.stringify({ reason }) });
        toast('Checada anulada');
      }
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Error al guardar');
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Corrección — #${row.employee_number} ${row.full_name} (${date})`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            onClick={() => void submit()}
            loading={busy}
            disabled={reason.trim().length < 3 || (mode === 'void' && !targetId)}
          >
            Guardar corrección
          </Button>
        </>
      }
    >
      <div className="grid gap-1">
        <div className="mb-3 flex gap-2" role="tablist">
          <Button
            variant={mode === 'add' ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => setMode('add')}
            role="tab"
            aria-selected={mode === 'add'}
          >
            Agregar checada
          </Button>
          <Button
            variant={mode === 'void' ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => {
              setMode('void');
              setTargetId(activePunches[0]?.id ?? '');
            }}
            role="tab"
            aria-selected={mode === 'void'}
          >
            Anular checada
          </Button>
        </div>

        {mode === 'add' ? (
          <>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Tipo" required>
                <Select value={punchType} onChange={(e) => setPunchType(e.target.value as PunchType)}>
                  {Object.entries(PUNCH_TYPE_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Hora (local planta)" required>
                <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
              </Field>
            </div>
            <Field label="Anular también una checada existente" hint="Opcional">
              <Select value={targetId} onChange={(e) => setTargetId(e.target.value)}>
                <option value="">— No anular ninguna —</option>
                {activePunches.map((p) => (
                  <option key={p.id} value={p.id}>
                    {PUNCH_TYPE_LABELS[p.punch_type]} {fmtTime(p.punched_at)}
                  </option>
                ))}
              </Select>
            </Field>
          </>
        ) : (
          <Field label="Checada a anular" required>
            <Select value={targetId} onChange={(e) => setTargetId(e.target.value)}>
              {activePunches.map((p) => (
                <option key={p.id} value={p.id}>
                  {PUNCH_TYPE_LABELS[p.punch_type]} {fmtTime(p.punched_at)}
                </option>
              ))}
            </Select>
          </Field>
        )}

        <Field label="Razón" required error={error}>
          <Textarea
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Ej.: Empleado olvidó checar salida; confirmado con supervisor"
          />
        </Field>
      </div>
    </Modal>
  );
}
