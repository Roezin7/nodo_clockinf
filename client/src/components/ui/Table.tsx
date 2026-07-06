import type { ReactNode, ThHTMLAttributes, TdHTMLAttributes } from 'react';
import { ChevronUp, ChevronDown } from 'lucide-react';
import type { BadgeTone } from './Badge';

/**
 * Tabla de datos — el componente más importante de la app.
 * Header sticky sobre sunken, filas de 44px, numéricos a la derecha con
 * tabular-nums, filas con estado marcadas con fondo subtle (nunca la fila
 * entera pintada del semántico).
 */
export function Table({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`overflow-x-auto rounded-card border border-line bg-raised shadow-card ${className}`}>
      <table className="w-full border-collapse text-14">{children}</table>
    </div>
  );
}

export function THead({ children }: { children: ReactNode }) {
  return <thead className="sticky top-0 z-10 bg-sunken">{children}</thead>;
}

export type SortDir = 'asc' | 'desc' | null;

interface THProps extends ThHTMLAttributes<HTMLTableCellElement> {
  num?: boolean;
  sortable?: boolean;
  sorted?: SortDir;
  onSort?: () => void;
}

export function TH({ num, sortable, sorted, onSort, children, className = '', ...rest }: THProps) {
  const content = (
    <span className={`inline-flex items-center gap-1 ${num ? 'flex-row-reverse' : ''}`}>
      {children}
      {sortable && (
        <span className="text-ink-tertiary" aria-hidden>
          {sorted === 'asc' ? (
            <ChevronUp size={14} strokeWidth={2} />
          ) : sorted === 'desc' ? (
            <ChevronDown size={14} strokeWidth={2} />
          ) : (
            <ChevronDown size={14} strokeWidth={2} className="opacity-0" />
          )}
        </span>
      )}
    </span>
  );
  return (
    <th
      aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : undefined}
      className={`whitespace-nowrap px-4 py-2.5 text-12 font-semibold uppercase tracking-wide text-ink-secondary ${num ? 'text-right' : 'text-left'} ${className}`}
      {...rest}
    >
      {sortable ? (
        // Los <button> resetean text-transform del UA: se reaplica aquí
        <button
          onClick={onSort}
          className="cursor-pointer select-none uppercase tracking-wide hover:text-ink"
        >
          {content}
        </button>
      ) : (
        content
      )}
    </th>
  );
}

interface TRowProps {
  children: ReactNode;
  /** Fila con estado: fondo subtle discreto. El punto de color lo pone la celda. */
  flag?: Extract<BadgeTone, 'warning' | 'danger'> | null;
  className?: string;
}

export function TRow({ children, flag, className = '' }: TRowProps) {
  const flagCls = flag === 'danger' ? 'bg-danger-subtle/50' : flag === 'warning' ? 'bg-warning-subtle/50' : '';
  return (
    <tr
      className={`h-11 border-b border-line transition-colors duration-150 last:border-0 hover:bg-sunken ${flagCls} ${className}`}
    >
      {children}
    </tr>
  );
}

interface TDProps extends TdHTMLAttributes<HTMLTableCellElement> {
  num?: boolean;
}

export function TD({ num, children, className = '', ...rest }: TDProps) {
  // nowrap por default: fechas, horas y acciones no se parten; una celda que
  // deba envolver (ej. chips de checadas) pasa whitespace-normal explícito
  return (
    <td className={`whitespace-nowrap px-4 py-2.5 ${num ? 'tnum text-right' : ''} ${className}`} {...rest}>
      {children}
    </td>
  );
}

/** Fila de totales para el footer de la tabla. */
export function TFootRow({ children }: { children: ReactNode }) {
  return <tr className="h-11 border-t border-line-strong bg-sunken font-semibold">{children}</tr>;
}

/** Paginación simple para tablas de más de ~100 filas. */
export function Pagination({
  page,
  pageCount,
  onPage,
}: {
  page: number;
  pageCount: number;
  onPage: (p: number) => void;
}) {
  if (pageCount <= 1) return null;
  return (
    <div className="flex items-center justify-end gap-3 px-4 py-2 text-13 text-ink-secondary">
      <span className="tnum">
        Página {page} de {pageCount}
      </span>
      <div className="flex gap-1">
        <button
          onClick={() => onPage(page - 1)}
          disabled={page <= 1}
          className="rounded-control border border-line bg-raised px-2 py-1 hover:bg-sunken disabled:cursor-not-allowed disabled:opacity-45"
        >
          Anterior
        </button>
        <button
          onClick={() => onPage(page + 1)}
          disabled={page >= pageCount}
          className="rounded-control border border-line bg-raised px-2 py-1 hover:bg-sunken disabled:cursor-not-allowed disabled:opacity-45"
        >
          Siguiente
        </button>
      </div>
    </div>
  );
}
