import { useCallback, useEffect, useState } from 'react';
import { CalendarCheck } from 'lucide-react';
import type { AttendanceDayResponse, DayDetailPunch, DayDetailRow, Plant, PunchType } from '@clockai/shared';
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

const fmtDuration = (seconds: number): string => `${(seconds / 3600).toFixed(2)} h`;

interface CorrectionState {
  row: DayDetailRow;
}

type PlantPunch = DayDetailPunch & {
  plant_id: string | null;
  plant_name: string | null;
};

function punchesWithPlant(row: DayDetailRow): PlantPunch[] {
  return row.punches as PlantPunch[];
}

function plantsWorked(row: DayDetailRow): string {
  const names = new Set(
    punchesWithPlant(row)
      .filter((p) => !p.voided && p.plant_name)
      .map((p) => p.plant_name as string)
  );
  for (const entry of row.manual_time) {
    if (!entry.voided_at && entry.plant_name) names.add(entry.plant_name);
  }
  return [...names].join(', ') || '—';
}

export default function AttendancePage() {
  useAppTimezone(); // re-render si cambia la zona de la planta
  const user = useAuth();
  const canCorrect = user?.role === 'admin' || user?.role === 'foreman';
  const [date, setDate] = useState(todayLocal());
  const [data, setData] = useState<AttendanceDayResponse | null>(null);
  const [plants, setPlants] = useState<Plant[]>([]);
  const [correction, setCorrection] = useState<CorrectionState | null>(null);

  const load = useCallback(async () => {
    setData(await api<AttendanceDayResponse>(`/api/attendance/day/${date}`));
  }, [date]);

  useEffect(() => {
    setData(null);
    void load();
  }, [load]);

  useEffect(() => {
    void api<Plant[]>('/api/plants').then(setPlants);
  }, []);

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
              <TH>Planta(s)</TH>
              <TH>Checadas</TH>
              <TH num>Comida</TH>
              <TH num>Horas</TH>
              <TH>Estado</TH>
              {canCorrect && <TH className="text-right">Corrección</TH>}
            </tr>
          </THead>
          <tbody>
            {data.rows.map((row) => (
              <TRow
                key={row.employee_id}
                flag={!row.calc.complete || row.calc.anomalies.length ? 'danger' : null}
              >
                <TD>
                  <span className="tnum font-semibold">#{row.employee_number}</span>{' '}
                  <span className="font-medium">{row.full_name}</span>
                </TD>
                <TD className="text-ink-secondary">
                  {plantsWorked(row)}
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
                    {row.manual_time.map((entry) => (
                      <span
                        key={entry.id}
                        title={entry.reason}
                        className={`tnum inline-flex items-center rounded-control border px-1.5 py-0.5 text-12 font-medium ${
                          entry.voided_at
                            ? 'border-line text-ink-tertiary line-through'
                            : 'border-accent-subtle bg-accent-subtle text-accent'
                        }`}
                      >
                        +{fmtDuration(entry.duration_seconds)} manual
                      </span>
                    ))}
                  </div>
                </TD>
                <TD num className="text-ink-secondary">{(row.calc.meal_seconds / 60).toFixed(0)} min</TD>
                <TD num className="font-semibold">{fmtDuration(row.total_seconds)}</TD>
                <TD>
                  <span className="inline-flex flex-wrap gap-1.5">
                    {!row.calc.complete && <StatusBadge status="incompleto" />}
                    {row.calc.anomalies.length > 0 && <StatusBadge status="anomalia" />}
                    {row.calc.complete && row.calc.state === 'out' && (
                      <StatusBadge status="salio" />
                    )}
                    {row.calc.state === 'in' && <StatusBadge status="adentro" />}
                    {row.calc.state === 'meal' && <StatusBadge status="comida" />}
                  </span>
                </TD>
                {canCorrect && (
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
          plants={plants}
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
  plants,
  onDone,
  onClose,
}: {
  state: CorrectionState;
  date: string;
  plants: Plant[];
  onDone: () => void;
  onClose: () => void;
}) {
  const toast = useToast();
  const { row } = state;
  const activePunches = punchesWithPlant(row).filter((p) => !p.voided);
  const activeManualTime = row.manual_time.filter((entry) => !entry.voided_at);
  const [mode, setMode] = useState<'add' | 'void' | 'hours' | 'void_hours'>('add');
  const [punchType, setPunchType] = useState<PunchType>('shift_out');
  const [time, setTime] = useState('17:00');
  const [targetId, setTargetId] = useState<string>('');
  const [plantId, setPlantId] = useState(
    activePunches.find((p) => p.plant_id)?.plant_id ?? plants.find((p) => p.active)?.id ?? ''
  );
  const [hours, setHours] = useState('');
  const [manualTargetId, setManualTargetId] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const selectedTarget = activePunches.find((p) => p.id === targetId);
  const effectivePlantId = selectedTarget?.plant_id ?? plantId;
  const numericHours = Number(hours);

  useEffect(() => {
    if (!plantId) {
      const firstPlantId = activePunches.find((p) => p.plant_id)?.plant_id ?? plants.find((p) => p.active)?.id;
      if (firstPlantId) setPlantId(firstPlantId);
    }
  }, [activePunches, plantId, plants]);

  function selectTarget(id: string): void {
    setTargetId(id);
    const target = activePunches.find((p) => p.id === id);
    if (target?.plant_id) setPlantId(target.plant_id);
  }

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      if (mode === 'add') {
        await api('/api/punches/manual', {
          method: 'POST',
          body: JSON.stringify({
            employee_id: row.employee_id,
            plant_id: effectivePlantId,
            punch_type: punchType,
            // Hora LOCAL de planta: el servidor la convierte con su propia zona
            punched_at_local: `${date}T${time}`,
            reason,
            correction_of: targetId || null,
          }),
        });
        toast('Checada manual agregada');
      } else if (mode === 'void') {
        await api(`/api/punches/${targetId}/void`, { method: 'POST', body: JSON.stringify({ reason }) });
        toast('Checada anulada');
      } else if (mode === 'hours') {
        await api('/api/manual-time', {
          method: 'POST',
          body: JSON.stringify({
            employee_id: row.employee_id,
            plant_id: effectivePlantId,
            work_date: date,
            hours: numericHours,
            reason,
          }),
        });
        toast('Horas manuales agregadas');
      } else {
        await api(`/api/manual-time/${manualTargetId}/void`, {
          method: 'POST',
          body: JSON.stringify({ reason }),
        });
        toast('Horas manuales anuladas');
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
            disabled={
              reason.trim().length < 3 ||
              (mode === 'add' && (!effectivePlantId || !time)) ||
              (mode === 'void' && !targetId) ||
              (mode === 'hours' && (!effectivePlantId || !Number.isFinite(numericHours) || numericHours <= 0)) ||
              (mode === 'void_hours' && !manualTargetId)
            }
          >
            {mode === 'hours' ? 'Agregar horas' : mode === 'void_hours' ? 'Anular horas' : 'Guardar corrección'}
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
              selectTarget(activePunches[0]?.id ?? '');
            }}
            role="tab"
            aria-selected={mode === 'void'}
          >
            Anular checada
          </Button>
          <Button
            variant={mode === 'hours' ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => {
              setMode('hours');
              setTargetId('');
            }}
            role="tab"
            aria-selected={mode === 'hours'}
          >
            Agregar horas
          </Button>
          {activeManualTime.length > 0 && (
            <Button
              variant={mode === 'void_hours' ? 'primary' : 'secondary'}
              size="sm"
              onClick={() => {
                setMode('void_hours');
                setManualTargetId(activeManualTime[0]?.id ?? '');
              }}
              role="tab"
              aria-selected={mode === 'void_hours'}
            >
              Anular horas
            </Button>
          )}
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
              <Select value={targetId} onChange={(e) => selectTarget(e.target.value)}>
                <option value="">— No anular ninguna —</option>
                {activePunches.map((p) => (
                  <option key={p.id} value={p.id}>
                    {PUNCH_TYPE_LABELS[p.punch_type]} {fmtTime(p.punched_at)}
                    {p.plant_name ? ` · ${p.plant_name}` : ''}
                  </option>
                ))}
              </Select>
            </Field>
          </>
        ) : mode === 'void' ? (
          <Field label="Checada a anular" required>
            <Select value={targetId} onChange={(e) => selectTarget(e.target.value)}>
              {activePunches.map((p) => (
                <option key={p.id} value={p.id}>
                  {PUNCH_TYPE_LABELS[p.punch_type]} {fmtTime(p.punched_at)}
                  {p.plant_name ? ` · ${p.plant_name}` : ''}
                </option>
              ))}
            </Select>
          </Field>
        ) : mode === 'hours' ? (
          <Field label="Horas a agregar" required hint="Se clasificarán automáticamente bajo las reglas de California">
            <Input
              type="number"
              min="0.01"
              step="0.01"
              value={hours}
              onChange={(e) => setHours(e.target.value)}
              placeholder="Ej.: 2.50"
            />
          </Field>
        ) : (
          <Field label="Horas manuales a anular" required>
            <Select value={manualTargetId} onChange={(e) => setManualTargetId(e.target.value)}>
              {activeManualTime.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {fmtDuration(entry.duration_seconds)} · {entry.plant_name} · {entry.reason}
                </option>
              ))}
            </Select>
          </Field>
        )}

        {mode !== 'void' && mode !== 'void_hours' && (
          <Field
            label="Planta"
            required
            hint={selectedTarget?.plant_id ? 'La corrección conserva la planta de la checada original' : undefined}
          >
            <Select
              value={effectivePlantId}
              onChange={(e) => setPlantId(e.target.value)}
              disabled={Boolean(selectedTarget?.plant_id)}
            >
              <option value="">Selecciona una planta…</option>
              {plants.filter((plant) => plant.active).map((plant) => (
                <option key={plant.id} value={plant.id}>
                  {plant.name}
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
