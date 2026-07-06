import type { LucideIcon } from 'lucide-react';
import { Button } from './Button';

/**
 * Empty state: ícono lineal discreto, una línea de qué es, y la acción.
 * Sin ilustraciones caricaturescas.
 */
export function EmptyState({
  icon: Icon,
  title,
  action,
}: {
  icon: LucideIcon;
  title: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center">
      <Icon size={28} strokeWidth={1.5} className="text-ink-tertiary" aria-hidden />
      <p className="text-14 text-ink-secondary">{title}</p>
      {action && (
        <Button variant="secondary" size="sm" onClick={action.onClick}>
          {action.label}
        </Button>
      )}
    </div>
  );
}
