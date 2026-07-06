import { useEffect, useState } from 'react';
import { CalendarCheck } from 'lucide-react';
import type { Employee, Punch, PunchType } from '@clockai/shared';
import { api } from '../api';
import { fmtDateTime, useAppTimezone } from '../time';
import { EmptyState, Modal, Skeleton, StatusBadge } from './ui';

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
    <Modal title={`Checadas — ${employee.full_name} (#${employee.employee_number})`} size="lg" onClose={onClose}>
      <div className="max-h-[55vh] overflow-y-auto">
        {!punches ? (
          <div className="grid gap-2">
            {Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} className="h-11 w-full" />
            ))}
          </div>
        ) : !punches.length ? (
          <EmptyState icon={CalendarCheck} title="Este empleado aún no tiene checadas." />
        ) : (
          <table className="w-full text-14">
            <tbody>
              {punches.map((p) => (
                <tr key={p.id} className={`border-b border-line last:border-0 ${p.voided ? 'opacity-45' : ''}`}>
                  <td className="w-14 py-2 pr-3">
                    {p.photo_url ? (
                      <button onClick={() => setPhotoView(p.photo_url)} aria-label="Ver foto">
                        <img src={p.photo_url} alt="" className="h-10 w-10 rounded-control object-cover" />
                      </button>
                    ) : (
                      <div className="flex h-10 w-10 items-center justify-center rounded-control bg-sunken text-12 text-ink-tertiary">
                        —
                      </div>
                    )}
                  </td>
                  <td className="py-2 pr-3 font-medium">{PUNCH_TYPE_LABELS[p.punch_type]}</td>
                  <td className="tnum py-2 pr-3 text-ink-secondary">{fmtDateTime(p.punched_at)}</td>
                  <td className="py-2 pr-3 text-13 text-ink-secondary">{p.area_name ?? ''}</td>
                  <td className="py-2 text-right">
                    <span className="inline-flex gap-1.5">
                      {p.source === 'manual' && <StatusBadge status="manual" />}
                      {p.voided && <StatusBadge status="anulada" />}
                    </span>
                    {p.correction_reason && (
                      <span className="block text-12 text-ink-tertiary">{p.correction_reason}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {photoView && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-ink/40 p-8"
          onClick={() => setPhotoView(null)}
        >
          <img src={photoView} alt="Foto de checada" className="max-h-full max-w-full rounded-card shadow-overlay" />
        </div>
      )}
    </Modal>
  );
}
