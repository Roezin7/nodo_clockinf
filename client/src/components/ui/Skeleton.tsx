/** Skeletons con shimmer sutil. Prohibido el spinner de página completa. */

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`skeleton rounded-control ${className}`} aria-hidden />;
}

export function KpiSkeleton() {
  return (
    <div className="rounded-card border border-line bg-raised p-5 shadow-card">
      <Skeleton className="h-10 w-16" />
      <Skeleton className="mt-2 h-4 w-24" />
    </div>
  );
}

export function TableSkeleton({ rows = 6, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div className="overflow-hidden rounded-card border border-line bg-raised shadow-card">
      <div className="h-10 bg-sunken" />
      <div className="divide-y divide-line">
        {Array.from({ length: rows }, (_, r) => (
          <div key={r} className="flex h-11 items-center gap-4 px-4">
            {Array.from({ length: cols }, (_, c) => (
              <Skeleton key={c} className={`h-4 ${c === 1 ? 'w-40' : 'w-16'}`} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
