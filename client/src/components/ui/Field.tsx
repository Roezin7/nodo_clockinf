import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';

/** Estilo único de controles de formulario: 40px, fondo sunken, borde → accent en focus. */
const CONTROL =
  'h-10 w-full rounded-control border border-line bg-sunken px-3 text-14 text-ink placeholder:text-ink-tertiary transition-colors duration-150 focus:border-accent focus:bg-raised focus:outline-none disabled:cursor-not-allowed disabled:opacity-45';

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  const { className = '', ...rest } = props;
  return <input className={`${CONTROL} ${className}`} {...rest} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  const { className = '', ...rest } = props;
  return <select className={`${CONTROL} ${className}`} {...rest} />;
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const { className = '', ...rest } = props;
  return <textarea className={`${CONTROL} h-auto min-h-16 py-2 ${className}`} {...rest} />;
}

/**
 * Campo con label arriba y espacio de error RESERVADO: el layout no brinca
 * cuando aparece el mensaje.
 */
export function Field({
  label,
  required,
  error,
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  error?: string | null;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-13 font-medium text-ink">
        {label}
        {required && (
          <span className="text-danger" aria-hidden>
            {' '}
            *
          </span>
        )}
      </span>
      {children}
      <span className={`block h-5 pt-0.5 text-12 ${error ? 'text-danger' : 'text-ink-tertiary'}`} role={error ? 'alert' : undefined}>
        {error ?? hint ?? ''}
      </span>
    </label>
  );
}
