import type { ButtonHTMLAttributes } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
}

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-raised hover:bg-accent-hover',
  secondary: 'border border-line bg-raised text-ink hover:bg-sunken',
  ghost: 'text-ink-secondary hover:bg-sunken hover:text-ink',
  danger: 'bg-danger text-raised hover:opacity-90',
};

const SIZES: Record<Size, string> = {
  sm: 'h-8 px-3 text-13',
  md: 'h-10 px-4 text-14',
};

/**
 * Botón del sistema. Estados: default / hover / focus-visible (ring global) /
 * disabled (opacity + cursor) / loading (spinner, el ancho NO cambia).
 */
export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled,
  className = '',
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={`relative inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-control font-medium transition-colors duration-150 ease-out disabled:cursor-not-allowed disabled:opacity-45 ${VARIANTS[variant]} ${SIZES[size]} ${className}`}
      {...rest}
    >
      <span className={`inline-flex items-center gap-2 ${loading ? 'invisible' : ''}`}>{children}</span>
      {loading && (
        <span className="absolute inset-0 flex items-center justify-center" aria-hidden>
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
        </span>
      )}
    </button>
  );
}
