import { useState } from 'react';
import { Users } from 'lucide-react';
import { PageHeader } from '../components/layout/PageHeader';
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Input,
  KpiSkeleton,
  Modal,
  Select,
  STATUS,
  StatusBadge,
  Table,
  TableSkeleton,
  TD,
  TFootRow,
  TH,
  THead,
  TRow,
  useToast,
} from '../components/ui';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="mb-3 text-18 font-semibold">{title}</h2>
      {children}
    </section>
  );
}

const SWATCHES = [
  ['page', 'bg-page border border-line'],
  ['raised', 'bg-raised border border-line'],
  ['sunken', 'bg-sunken'],
  ['accent', 'bg-accent'],
  ['accent-subtle', 'bg-accent-subtle'],
  ['success', 'bg-success'],
  ['warning', 'bg-warning'],
  ['danger', 'bg-danger'],
  ['info', 'bg-info'],
] as const;

export default function StyleguidePage() {
  const toast = useToast();
  const [modal, setModal] = useState(false);
  const [loading, setLoading] = useState(false);

  return (
    <div>
      <PageHeader title="Styleguide" meta={<Badge tone="neutral">interno</Badge>} />

      <Section title="Color">
        <div className="flex flex-wrap gap-3">
          {SWATCHES.map(([name, cls]) => (
            <div key={name} className="text-center">
              <div className={`h-12 w-20 rounded-control ${cls}`} />
              <span className="text-12 text-ink-tertiary">{name}</span>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Tipografía">
        <div className="rounded-card border border-line bg-raised p-5 shadow-card">
          <p className="font-display text-40 font-bold tnum">1,248.5</p>
          <h1 className="text-22 font-bold">H1 topbar de página — Hanken Grotesk 22</h1>
          <h2 className="text-18 font-semibold">H2 sección — 18</h2>
          <p className="text-14">Body de la app — Inter 14 / 1.45. La densidad es empresarial, no de blog.</p>
          <p className="text-13 text-ink-secondary">Secundario 13 — labels y metadata que sí se lee.</p>
          <p className="text-12 text-ink-tertiary">Terciario 12 — solo metadata, nunca contenido.</p>
          <p className="tnum text-14">Tabular: 08:00 · 13:30 · 17:02 — los números alinean verticalmente.</p>
        </div>
      </Section>

      <Section title="Botones">
        <div className="flex flex-wrap items-center gap-2">
          <Button>Primario</Button>
          <Button variant="secondary">Secundario</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger">Peligro</Button>
          <Button disabled>Deshabilitado</Button>
          <Button
            loading={loading}
            onClick={() => {
              setLoading(true);
              setTimeout(() => setLoading(false), 1500);
            }}
          >
            Cargando…
          </Button>
          <Button size="sm">Compacto 32px</Button>
          <Button size="sm" variant="secondary">
            Compacto sec.
          </Button>
        </div>
      </Section>

      <Section title="Badges de estado (vocabulario fijo)">
        <div className="flex flex-wrap gap-2">
          {(Object.keys(STATUS) as (keyof typeof STATUS)[]).map((k) => (
            <StatusBadge key={k} status={k} />
          ))}
        </div>
      </Section>

      <Section title="Tabla de datos">
        <Table>
          <THead>
            <tr>
              <TH sortable sorted="asc">Empleado</TH>
              <TH>Estado</TH>
              <TH num>Entrada</TH>
              <TH num>Horas</TH>
            </tr>
          </THead>
          <tbody>
            <TRow>
              <TD><span className="tnum font-semibold">#12</span> María González</TD>
              <TD><StatusBadge status="adentro" /></TD>
              <TD num>07:02</TD>
              <TD num>8:15</TD>
            </TRow>
            <TRow flag="warning">
              <TD><span className="tnum font-semibold">#47</span> Pedro Ramírez</TD>
              <TD><StatusBadge status="retardo" /></TD>
              <TD num>07:22</TD>
              <TD num>7:55</TD>
            </TRow>
            <TRow flag="danger">
              <TD><span className="tnum font-semibold">#31</span> Luisa Torres</TD>
              <TD><StatusBadge status="incompleto" /></TD>
              <TD num>07:00</TD>
              <TD num>—</TD>
            </TRow>
          </tbody>
          <tfoot>
            <TFootRow>
              <TD>Total</TD>
              <TD>{''}</TD>
              <TD num>{''}</TD>
              <TD num>16:10</TD>
            </TFootRow>
          </tfoot>
        </Table>
      </Section>

      <Section title="Formularios">
        <div className="grid max-w-lg gap-1 rounded-card border border-line bg-raised p-5 shadow-card">
          <Field label="Nombre completo" required hint="Como aparece en su identificación">
            <Input placeholder="Nombre y apellidos" />
          </Field>
          <Field label="Turno" error="Selecciona un turno">
            <Select defaultValue="">
              <option value="" disabled>— Elegir —</option>
              <option>Mañana</option>
            </Select>
          </Field>
        </div>
      </Section>

      <Section title="Modal, toast, empty y skeleton">
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => setModal(true)}>Abrir modal</Button>
          <Button variant="secondary" onClick={() => toast('Empleado dado de alta')}>Toast éxito</Button>
          <Button variant="secondary" onClick={() => toast('No se pudo cerrar la semana', 'danger')}>Toast error</Button>
        </div>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <div className="rounded-card border border-line bg-raised shadow-card">
            <EmptyState
              icon={Users}
              title="Aún no hay empleados."
              action={{ label: 'Dar de alta al primero', onClick: () => toast('Acción del empty state') }}
            />
          </div>
          <div className="grid gap-3">
            <div className="grid grid-cols-2 gap-3">
              <KpiSkeleton />
              <KpiSkeleton />
            </div>
            <TableSkeleton rows={2} cols={4} />
          </div>
        </div>
        {modal && (
          <Modal
            title="Confirmar acción"
            onClose={() => setModal(false)}
            footer={
              <>
                <Button variant="secondary" onClick={() => setModal(false)}>Cancelar</Button>
                <Button onClick={() => setModal(false)}>Confirmar</Button>
              </>
            }
          >
            <p className="text-14 text-ink-secondary">
              Footer con acciones a la derecha: secundaria primero, primaria al final. Esc cierra, el focus queda
              atrapado adentro.
            </p>
          </Modal>
        )}
      </Section>
    </div>
  );
}
