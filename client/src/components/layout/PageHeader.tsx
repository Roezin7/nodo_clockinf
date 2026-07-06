import type { ReactNode } from 'react';

/**
 * Topbar de página: título H1 (22px) a la izquierda, acciones primarias a la
 * derecha. Las acciones viven aquí, no flotando en el contenido.
 */
export function PageHeader({
  title,
  meta,
  actions,
}: {
  title: string;
  /** Badge o metadata junto al título (ej. estado Draft/Final). */
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-center gap-3">
      <h1 className="text-22 font-bold text-ink">{title}</h1>
      {meta}
      <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>
    </div>
  );
}
