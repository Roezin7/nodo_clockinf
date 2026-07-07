import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

const WIDTHS = { sm: 'max-w-[480px]', md: 'max-w-[560px]', lg: 'max-w-[640px]' } as const;

/**
 * Modal del sistema: overlay 40%, panel 480–640px, header con título y X,
 * footer con acciones a la derecha. Focus trap y cierre con Esc.
 */
export function Modal({
  title,
  onClose,
  footer,
  size = 'md',
  children,
}: {
  title: string;
  onClose: () => void;
  footer?: ReactNode;
  size?: keyof typeof WIDTHS;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  // onClose suele ser una arrow function nueva en cada render del padre; va en un
  // ref para que el efecto de foco corra SOLO al montar — si se re-ejecutara,
  // robaría el foco del input activo en cada tecleo.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();

    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab' || !panelRef.current) return;
      // Focus trap: Tab cicla dentro del panel
      const focusables = panelRef.current.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      if (!focusables.length) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previous?.focus();
    };
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`w-full ${WIDTHS[size]} max-h-[85vh] overflow-y-auto rounded-card border border-line bg-raised shadow-overlay outline-none transition-opacity duration-200`}
      >
        <div className="flex items-center justify-between border-b border-line px-6 py-4">
          <h2 className="text-16 font-semibold">{title}</h2>
          <button
            onClick={onClose}
            aria-label="Cerrar"
            className="rounded-control p-1 text-ink-tertiary transition-colors duration-150 hover:bg-sunken hover:text-ink"
          >
            <X size={18} strokeWidth={1.5} />
          </button>
        </div>
        <div className="px-6 py-5">{children}</div>
        {footer && (
          <div className="flex items-center justify-end gap-2 border-t border-line px-6 py-4">{footer}</div>
        )}
      </div>
    </div>
  );
}
