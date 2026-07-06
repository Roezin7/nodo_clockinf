import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { CheckCircle2, AlertCircle } from 'lucide-react';

interface ToastItem {
  id: number;
  message: string;
  tone: 'success' | 'danger';
}

const ToastContext = createContext<(message: string, tone?: 'success' | 'danger') => void>(() => {});

/**
 * Toasts: esquina inferior derecha, 4s, verbo de la acción completada
 * ("Empleado dado de alta", "Semana cerrada"). Nunca "¡Éxito!".
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const push = useCallback((message: string, tone: 'success' | 'danger' = 'success') => {
    const id = nextId.current++;
    setToasts((t) => [...t, { id, message, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  }, []);

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed bottom-6 right-6 z-[60] flex flex-col gap-2" aria-live="polite">
        {toasts.map((t) => (
          <div
            key={t.id}
            className="pointer-events-auto flex items-center gap-2 rounded-card border border-line bg-ink px-4 py-3 text-13 font-medium text-page shadow-overlay"
          >
            {t.tone === 'success' ? (
              <CheckCircle2 size={16} strokeWidth={1.5} className="shrink-0 text-success-subtle" />
            ) : (
              <AlertCircle size={16} strokeWidth={1.5} className="shrink-0 text-danger-subtle" />
            )}
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): (message: string, tone?: 'success' | 'danger') => void {
  return useContext(ToastContext);
}
