export type BadgeTone = 'success' | 'info' | 'warning' | 'danger' | 'neutral' | 'accent';

const TONES: Record<BadgeTone, string> = {
  success: 'bg-success-subtle text-success',
  info: 'bg-info-subtle text-info',
  warning: 'bg-warning-subtle text-warning',
  danger: 'bg-danger-subtle text-danger',
  neutral: 'bg-sunken text-ink-secondary',
  accent: 'bg-accent-subtle text-accent',
};

/** Pill de estado: fondo subtle + texto semántico + punto de 6px. */
export function Badge({ tone, children }: { tone: BadgeTone; children: React.ReactNode }) {
  return (
    <span
      className={`inline-flex h-5 items-center gap-1.5 whitespace-nowrap rounded-full px-2 text-12 font-medium ${TONES[tone]}`}
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" aria-hidden />
      {children}
    </span>
  );
}

/**
 * Vocabulario fijo de estados en toda la app — siempre estos términos,
 * siempre estos tonos. No inventar variantes por pantalla.
 */
export const STATUS = {
  adentro: { label: 'Adentro', tone: 'success' } as const,
  comida: { label: 'En comida', tone: 'info' } as const,
  retardo: { label: 'Retardo', tone: 'warning' } as const,
  incompleto: { label: 'Incompleto', tone: 'warning' } as const,
  falta: { label: 'Falta', tone: 'danger' } as const,
  salio: { label: 'Salió', tone: 'neutral' } as const,
  cerrada: { label: 'Semana cerrada', tone: 'success' } as const,
  borrador: { label: 'Borrador', tone: 'warning' } as const,
  anomalia: { label: 'Anomalía', tone: 'danger' } as const,
  activo: { label: 'Activo', tone: 'success' } as const,
  inactivo: { label: 'Inactivo', tone: 'neutral' } as const,
  anulada: { label: 'Anulada', tone: 'neutral' } as const,
  manual: { label: 'Manual', tone: 'accent' } as const,
};

export function StatusBadge({ status }: { status: keyof typeof STATUS }) {
  const s = STATUS[status];
  return <Badge tone={s.tone}>{s.label}</Badge>;
}
