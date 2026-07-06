import { useEffect, useState } from 'react';
import type { Employee, Punch, PunchType } from '@clockai/shared';
import { api } from '../api';
import { Modal } from '../pages/EmployeesPage';
import { fmtDateTime, useAppTimezone } from '../time';

export const PUNCH_TYPE_LABELS: Record<PunchType, string> = {
  shift_in: 'Entrada',
  shift_out: 'Salida',
  meal_out: 'Salida a comer',
  meal_in: 'Regreso de comer',
};

type PunchWithExtras = Punch & { photo_url: string | null; area_name: string | null };

export default function PunchHistoryModal({ employee, onClose }: { employee: Employee; onClose: () => void }) {
  useAppTimezone(); // re-render si cambia la zona de la planta
  const [punches, setPunches] = useState<PunchWithExtras[] | null>(null);
  const [photoView, setPhotoView] = useState<string | null>(null);

  useEffect(() => {
    void api<PunchWithExtras[]>(`/api/punches?employee=${employee.id}&limit=60&include_voided=true`).then(setPunches);
  }, [employee.id]);

  return (
    <Modal title={`Checadas — ${employee.full_name} (#${employee.employee_number})`} onClose={onClose}>
      <div className="max-h-[60vh] overflow-y-auto">
        {!punches ? (
          <p className="py-8 text-center text-ink-soft">Cargando…</p>
        ) : !punches.length ? (
          <p className="py-8 text-center text-ink-soft">Sin checadas registradas.</p>
        ) : (
          <table className="w-full text-sm">
            <tbody>
              {punches.map((p) => (
                <tr key={p.id} className={`border-b border-line last:border-0 ${p.voided ? 'opacity-40' : ''}`}>
                  <td className="py-2 pr-3">
                    {p.photo_url ? (
                      <button onClick={() => setPhotoView(p.photo_url)}>
                        <img src={p.photo_url} alt="" className="h-12 w-12 rounded-lg object-cover" />
                      </button>
                    ) : (
                      <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-surface text-xs text-ink-soft">
                        {p.source === 'manual' ? 'man.' : 'sin foto'}
                      </div>
                    )}
                  </td>
                  <td className="py-2 pr-3 font-semibold">{PUNCH_TYPE_LABELS[p.punch_type]}</td>
                  <td className="py-2 pr-3 tabular-nums">{fmtDateTime(p.punched_at)}</td>
                  <td className="py-2 pr-3 text-ink-soft">{p.area_name ?? ''}</td>
                  <td className="py-2 text-xs text-ink-soft">
                    {p.voided ? 'ANULADA' : p.source === 'manual' ? 'manual' : ''}
                    {p.correction_reason ? ` · ${p.correction_reason}` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {photoView && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-ink/70 p-8" onClick={() => setPhotoView(null)}>
          <img src={photoView} alt="Foto de checada" className="max-h-full max-w-full rounded-2xl" />
        </div>
      )}
    </Modal>
  );
}
