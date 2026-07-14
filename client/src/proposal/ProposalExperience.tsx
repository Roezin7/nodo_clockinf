import { FormEvent, useMemo, useState } from 'react';
import {
  AlertTriangle, ArrowDown, ArrowRight, Building2, Check, CheckCircle2,
  ChevronRight, ClipboardCheck, Clock3, CloudOff, Download, FileCheck2,
  FileSpreadsheet, Gauge, History, Laptop, LockKeyhole, Menu, MonitorCheck, Printer,
  ShieldCheck, Tablet, UserCheck, Users, Wifi, WifiOff, X,
} from 'lucide-react';
import type { PunchType } from '@clockai/shared';
import type { AcceptanceErrors } from './validation';
import type { AcceptanceInput, ProposalPayload } from './types';
import { calculateProposalTotals, usd } from './pricing';
import { validateAcceptance } from './validation';
import { DEMO_ACTIONS, DEMO_EMPLOYEES, type LocalDemoPunch, WEEK_EVENTS } from './demoData';
import { PrintableProposal } from './print';

const IMPLEMENTATION = [
  'Configuración inicial del sistema', 'Alta de hasta tres plantas', 'Onboarding de empleados',
  'Configuración de turnos', 'Tasas y reglas operativas', 'Usuarios y permisos',
  'Preparación inicial de estaciones', 'Capacitación', 'Piloto', 'Ajustes iniciales',
  'Acompañamiento en salida a producción', 'Periodo inicial de estabilización',
];
const PLATFORM = ['Acceso al software', 'Infraestructura del servidor', 'Monitoreo', 'Backups', 'Actualizaciones', 'Mantenimiento técnico', 'Seguridad', 'Soporte remoto', 'Supervisión de salud', 'Almacenamiento privado', 'Verificación periódica de respaldos'];
const STATION = ['Tableta preparada', 'Kiosco configurado', 'Cargador', 'Base, soporte o carcasa definida', 'Administración remota', 'Monitoreo', 'Soporte técnico', 'Reemplazo por falla cubierta sujeto a disponibilidad y términos'];
const STATION_EXCLUSIONS = ['Robo o pérdida', 'Daño intencional o uso indebido', 'Líquidos o condiciones no autorizadas sin cobertura específica', 'Internet y electricidad', 'Instalaciones eléctricas u obras físicas', 'Reemplazo inmediato en sitio fuera del alcance contratado'];
const CAPABILITIES = [
  ['Configuración', 'Plantas · empleados · tasas efectivas · turnos · áreas · dispositivos · usuarios · roles'],
  ['Roles', 'Administrador · foreman limitado por planta · contadora de solo lectura · operador de plataforma'],
  ['Kiosco', 'Entrada · comida · regreso · salida · español e inglés · PWA instalable'],
  ['Operación offline', 'Cola local · reintentos · sincronización ordenada · prevención de duplicados · excepciones visibles'],
  ['Identidad y evidencia', 'Evidencia fotográfica · enrolamiento versionado · comparación 1:1 asistida · revisión humana'],
  ['Asistencia', 'Correcciones sin borrar originales · motivos obligatorios · horas manuales · auditoría'],
  ['Reglas de California', 'Regular · overtime 1.5x · doble tiempo · más de 40 semanales · séptimo día configurado'],
  ['Supervisión', 'Personal por planta · secuencias abiertas · incidencias · salud de estaciones · alertas'],
  ['Costos', 'Tasas históricas · costo directo estimado · proximidad a overtime · tendencias'],
  ['Cierre semanal', 'Revisión · bloqueadores · overrides documentados · reapertura · versiones · archivos congelados'],
  ['Contadora', 'Portal limitado · detalle diario · XLSX · CSV · versiones verificables · sin biometría administrativa'],
  ['Seguridad técnica', 'Aislamiento por organización y planta · sesiones revocables · cifrado · enlaces temporales · health checks · backups'],
];
const LIMITS = ['Nómina', 'Impuestos', 'Depósitos', 'PTO', 'Vacaciones', 'Scheduling avanzado', 'Recursos humanos completos', 'Reclutamiento', 'Producción por pieza', 'Producción por lote', 'Clasificación legal automática', 'Asesoría laboral o jurídica', 'Reconocimiento facial autónomo con prueba de vida'];
const IMPLEMENTATION_STEPS = ['Descubrimiento y recolección de información', 'Importación de empleados', 'Configuración de plantas, turnos y tasas', 'Configuración de usuarios y permisos', 'Preparación de estaciones', 'Capacitación', 'Piloto paralelo', 'Validación del primer cierre', 'Salida a producción', 'Ajustes y estabilización inicial'];

function SectionHeading({ eyebrow, title, children }: { eyebrow: string; title: string; children?: React.ReactNode }) {
  return <header className="proposal-section-heading"><p>{eyebrow}</p><h2>{title}</h2>{children && <div>{children}</div>}</header>;
}
function CheckList({ items }: { items: readonly string[] }) {
  return <ul className="proposal-check-list">{items.map((item) => <li key={item}><Check size={16} aria-hidden="true" />{item}</li>)}</ul>;
}
function Metric({ label, value, note }: { label: string; value: string; note?: string }) {
  return <div className="proposal-metric"><span>{label}</span><strong className="tnum">{value}</strong>{note && <small>{note}</small>}</div>;
}

export function ProposalExperience({ payload }: { payload: ProposalPayload }) {
  const { proposal, pricing } = payload;
  const [mobileNav, setMobileNav] = useState(false);
  return <div className="proposal-page">
    <PrintableProposal proposal={proposal} />
    <header className="proposal-topbar">
      <a href="#inicio" className="proposal-brand" aria-label="Nod3 Studio, inicio"><span>N3</span><span>NODO Clock-In</span></a>
      <button className="proposal-nav-toggle" onClick={() => setMobileNav((value) => !value)} aria-label="Abrir navegación" aria-expanded={mobileNav}>{mobileNav ? <X /> : <Menu />}</button>
      <nav className={mobileNav ? 'is-open' : ''} aria-label="Propuesta">
        <a href="#recorrido">Recorrido</a><a href="#demo">Demo</a><a href="#capacidades">Capacidades</a><a href="#inversion">Inversión</a><a href="#aceptacion">Aceptación</a>
      </nav>
      <span className="proposal-private"><LockKeyhole size={14} /> Privada · v{proposal.version}</span>
    </header>
    <main>
      <section id="inicio" className="proposal-hero">
        <div className="proposal-hero-main">
          <p className="proposal-eyebrow">PROPUESTA PARA {proposal.commercialName.toLocaleUpperCase('es')}</p>
          <h1>De la checada de las 5:00 AM al cierre verificable del domingo.</h1>
          <p className="proposal-lead">NODO Clock-In convierte un proceso manual de asistencia, correcciones y preparación de horas en un flujo directo, auditable y preparado para múltiples plantas.</p>
          <p>{proposal.openingMessage}</p>
          <div className="proposal-actions"><a className="proposal-button primary" href="#recorrido">Comenzar el recorrido <ArrowDown size={17} /></a><a className="proposal-button secondary" href="#inversion">Revisar inversión</a></div>
        </div>
        <aside className="proposal-brief">
          {proposal.logoUrl ? <img src={proposal.logoUrl} alt={`Logotipo de ${proposal.commercialName}`} /> : <div className="proposal-client-monogram" aria-hidden="true">{proposal.commercialName.slice(0, 2).toUpperCase()}</div>}
          <h2>{proposal.commercialName}</h2><p>Atención: {proposal.contactName}</p>
          <dl><div><dt>Plantas iniciales</dt><dd>{proposal.initialPlants}</dd></div><div><dt>Empleados aprox.</dt><dd>{proposal.initialEmployees}</dd></div><div><dt>Estaciones iniciales</dt><dd>{proposal.initialStations}</dd></div><div><dt>Fecha</dt><dd>{proposal.proposalDate}</dd></div><div><dt>Vigencia</dt><dd>{proposal.validUntil}</dd></div></dl>
        </aside>
      </section>

      <section className="proposal-section proposal-problem" id="problema">
        <SectionHeading eyebrow="EL PROBLEMA OPERATIVO" title="Menos traspasos. Más claridad sobre lo ocurrido."><p>El riesgo no está sólo en registrar una hora; aparece cuando la información cruza personas, mensajes y archivos sin una historia verificable.</p></SectionHeading>
        <div className="proposal-flow comparison"><Flow title="Flujo tradicional" items={['Checador', 'Hojas o mensajes', 'Correcciones manuales', 'Consolidación externa', 'Contadora', 'Nómina']} muted /><Flow title="Con NODO" items={['Empleado', 'Estación', 'Foreman', 'Cierre semanal', 'Contadora']} /></div>
        <div className="proposal-risk-grid">{['Información fragmentada', 'Errores de captura', 'Horas sin explicación', 'Cambios sin historial', 'Retrasos de cierre', 'Dependencia de una persona', 'Difícil comprobar lo ocurrido', 'Tiempo perdido sin internet'].map((risk) => <span key={risk}><AlertTriangle size={15} />{risk}</span>)}</div>
      </section>

      <WeekTour />
      <IsolatedDemo />
      <ProductViews />

      <section id="capacidades" className="proposal-section">
        <SectionHeading eyebrow="CAPACIDADES RESPALDADAS" title="Un sistema enfocado en asistencia y cierre operativo"><p>Cada área corresponde a funciones y contratos existentes en NODO Clock-In.</p></SectionHeading>
        <div className="proposal-capability-grid">{CAPABILITIES.map(([title, text]) => <article key={title}><CheckCircle2 size={20} /><h3>{title}</h3><p>{text}</p></article>)}</div>
        <aside className="proposal-legal-note"><ShieldCheck size={22} /><p><strong>Validación humana obligatoria.</strong> La identidad facial actual no es prueba de vida ni reconocimiento autónomo infalible. La Wage Order aplicable, clasificación legal, comidas, primas y tasas deben validarse con el abogado, contador o asesor laboral del cliente.</p></aside>
      </section>

      <PricingCalculator payload={payload} />
      <ValueSimulator />
      <ImplementationPlan />
      <TrustCenter />

      <section id="limites" className="proposal-section proposal-limits">
        <SectionHeading eyebrow="LÍMITES ACTUALES" title="Qué no hace NODO Clock-In"><p>La contadora utiliza las horas finales aprobadas para procesar el pago en su sistema actual.</p></SectionHeading>
        <div>{LIMITS.map((item) => <span key={item}><X size={14} />{item}</span>)}</div>
      </section>

      <Investment pricing={pricing} taxesIncluded={proposal.taxesIncluded} />
      <Acceptance payload={payload} />
    </main>
    <footer className="proposal-footer"><div><strong>{proposal.nod3.name}</strong><span>{proposal.nod3.email}</span><span>{proposal.nod3.phone}</span></div><div><span>Propuesta v{proposal.version}</span><span>Válida hasta {proposal.validUntil}</span><button type="button" onClick={() => window.print()}><Printer size={15} /> Imprimir / guardar PDF</button></div></footer>
  </div>;
}

function Flow({ title, items, muted = false }: { title: string; items: string[]; muted?: boolean }) {
  return <article className={muted ? 'muted' : ''}><h3>{title}</h3><div>{items.map((item, index) => <span key={item}>{item}{index < items.length - 1 && <ArrowRight size={14} aria-hidden="true" />}</span>)}</div></article>;
}

function WeekTour() {
  const [active, setActive] = useState(0);
  const event = WEEK_EVENTS[active]!;
  return <section id="recorrido" className="proposal-section proposal-week">
    <SectionHeading eyebrow="UNA SEMANA REAL" title="Avanza por la operación, evento por evento"><p>Escenario demostrativo. No crea ni modifica información real.</p></SectionHeading>
    <div className="proposal-week-layout"><ol>{WEEK_EVENTS.map((item, index) => <li key={item[0]} className={index === active ? 'active' : index < active ? 'done' : ''}><button onClick={() => setActive(index)} aria-current={index === active ? 'step' : undefined}><span>{index + 1}</span><small>{item[0]}</small><strong>{item[1]}</strong></button></li>)}</ol><article aria-live="polite"><span>PASO {active + 1} DE {WEEK_EVENTS.length}</span>{active === 4 ? <CloudOff size={34} /> : active === 5 ? <Wifi size={34} /> : active >= 6 ? <ClipboardCheck size={34} /> : <Clock3 size={34} />}<h3>{event[1]}</h3><p>{event[2]}</p><div className="proposal-actions"><button className="proposal-button secondary" disabled={active === 0} onClick={() => setActive((value) => Math.max(0, value - 1))}>Anterior</button><button className="proposal-button primary" disabled={active === WEEK_EVENTS.length - 1} onClick={() => setActive((value) => Math.min(WEEK_EVENTS.length - 1, value + 1))}>Siguiente <ChevronRight size={16} /></button></div></article></div>
  </section>;
}

function IsolatedDemo() {
  const [employeeId, setEmployeeId] = useState(DEMO_EMPLOYEES[0]!.id);
  const [online, setOnline] = useState(true);
  const [punches, setPunches] = useState<LocalDemoPunch[]>([]);
  const [syncing, setSyncing] = useState(false);
  function punch(action: PunchType): void {
    const next: LocalDemoPunch = {
      id: crypto.randomUUID(), employeeId, action, capturedAt: new Date().toISOString(),
      state: online ? 'synced' : 'pending',
    };
    setPunches((items) => [next, ...items].slice(0, 8));
  }
  function reconnect(): void {
    setOnline(true); setSyncing(true);
    window.setTimeout(() => { setPunches((items) => items.map((item) => ({ ...item, state: 'synced' }))); setSyncing(false); }, 650);
  }
  const pending = punches.filter((item) => item.state === 'pending').length;
  return <section id="demo" className="proposal-section proposal-demo">
    <SectionHeading eyebrow="DEMO FUNCIONAL AISLADA" title="Prueba la secuencia de una estación"><p>Personas ficticias · memoria local · sin fotografías · sin endpoints productivos · se borra al recargar.</p></SectionHeading>
    <div className="proposal-demo-shell"><header><div><strong>NODO Clock-In</strong><span>Estación de propuesta · Planta Demo</span></div><span className={online ? 'online' : 'offline'}>{online ? <Wifi size={15} /> : <WifiOff size={15} />}{online ? 'En línea' : 'Sin conexión'}</span></header><div className="proposal-demo-body"><div><label htmlFor="demo-employee">Empleado de demostración</label><select id="demo-employee" value={employeeId} onChange={(event) => setEmployeeId(event.target.value)}>{DEMO_EMPLOYEES.map((employee) => <option key={employee.id} value={employee.id}>#{employee.number} · {employee.name}</option>)}</select><div className="proposal-demo-actions">{DEMO_ACTIONS.map((action) => <button key={action.type} onClick={() => punch(action.type)}>{action.label}</button>)}</div><button className="proposal-network-button" onClick={() => online ? setOnline(false) : reconnect()}>{online ? <><WifiOff size={17} /> Simular pérdida de conexión</> : <><Wifi size={17} /> Recuperar conexión y sincronizar</>}</button></div><aside><div className="proposal-queue"><span>Cola local</span><strong>{pending}</strong><small>{syncing ? 'Sincronizando en orden…' : pending ? 'Pendiente de sincronización' : 'Sin eventos pendientes'}</small></div><h3>Actividad demostrativa</h3>{punches.length === 0 ? <p>Selecciona una acción para comenzar.</p> : <ul>{punches.map((item) => { const employee = DEMO_EMPLOYEES.find((candidate) => candidate.id === item.employeeId)!; return <li key={item.id}><span className={item.state}></span><div><strong>{employee.name}</strong><small>{DEMO_ACTIONS.find((action) => action.type === item.action)?.label} · {new Date(item.capturedAt).toLocaleTimeString('es-US', { hour: 'numeric', minute: '2-digit' })}</small></div><em>{item.state === 'synced' ? 'Sincronizado' : 'Pendiente'}</em></li>; })}</ul>}</aside></div></div>
  </section>;
}

function ProductViews() {
  const tabs = ['Dashboard', 'Incidencias', 'Salud', 'Cierre semanal', 'Contadora'] as const;
  const [tab, setTab] = useState<(typeof tabs)[number]>('Dashboard');
  return <section className="proposal-section proposal-product-views"><SectionHeading eyebrow="VISTAS DEL SISTEMA" title="La información adecuada para cada responsabilidad"><p>Mockup fiel con datos ficticios. Las capacidades corresponden a vistas reales; no es una sesión productiva.</p></SectionHeading><div className="proposal-view-tabs" role="tablist">{tabs.map((item) => <button role="tab" aria-selected={tab === item} key={item} onClick={() => setTab(item)}>{item}</button>)}</div><div className="proposal-view-frame" role="tabpanel"><aside><strong>NODO</strong>{tabs.map((item) => <span className={tab === item ? 'active' : ''} key={item}>{item}</span>)}</aside><MockView tab={tab} /></div></section>;
}

function MockView({ tab }: { tab: string }) {
  if (tab === 'Dashboard') return <div className="mock-dashboard"><header><div><h3>Operación actual</h3><p>Datos demostrativos · martes 7:42 AM</p></div><span>Actualizado ahora</span></header><div className="mock-metrics"><Metric label="Trabajando" value="47" /><Metric label="En comida" value="6" /><Metric label="Secuencias abiertas" value="2" /><Metric label="Atención" value="1" /></div><div className="mock-panels"><article><h4>Por planta</h4><p>Planta Norte <strong>24 dentro</strong></p><p>Planta Sur <strong>23 dentro</strong></p></article><article><h4>Próximos a overtime</h4><p>Ana Rivera <strong>39.2 h</strong></p><p>Luis Vega <strong>38.6 h</strong></p></article></div></div>;
  if (tab === 'Incidencias') return <div className="mock-dashboard"><header><div><h3>Incidencias operativas</h3><p>Cola durable para revisión</p></div><span>3 abiertas</span></header><div className="mock-list"><p><AlertTriangle /> Regreso de comida faltante <span>María Soto · Planta Norte</span><b>Bloqueante</b></p><p><History /> Corrección pendiente de revisión <span>Ana Rivera · motivo registrado</span><b>Revisar</b></p><p><WifiOff /> Evento sincronizado después de conexión <span>Estación Norte 01</span><b>Informativo</b></p></div></div>;
  if (tab === 'Salud') return <div className="mock-dashboard"><header><div><h3>Salud de estaciones</h3><p>Estado mínimo, sin evidencia personal</p></div><span>2 de 2 operativas</span></header><div className="mock-device"><MonitorCheck /><div><strong>Estación Norte 01</strong><span>Conectada · cola 0 · almacenamiento disponible</span></div><b>Saludable</b></div><div className="mock-device"><Gauge /><div><strong>Estación Sur 01</strong><span>Conectada · 1 evento ya sincronizado</span></div><b>Atención resuelta</b></div></div>;
  if (tab === 'Cierre semanal') return <div className="mock-dashboard"><header><div><h3>Semana 5–11 de julio</h3><p>Estado: listo para revisión</p></div><span>Versión próxima: v1</span></header><div className="mock-metrics"><Metric label="Regular" value="612.0 h" /><Metric label="OT 1.5" value="18.5 h" /><Metric label="Doble" value="1.0 h" /><Metric label="Manual" value="3.5 h" /></div><div className="mock-close"><CheckCircle2 /><div><strong>Sin bloqueadores</strong><span>Al finalizar se congela una nueva versión y sus archivos.</span></div><button>Finalizar versión 1</button></div></div>;
  return <div className="mock-dashboard"><header><div><h3>Portal de contadora</h3><p>Solo lectura · versión final</p></div><span>FINAL v1</span></header><div className="mock-table"><div><b>Empleado</b><b>Regular</b><b>OT 1.5</b><b>Total</b></div><div><span>Ana Rivera</span><span>40.00</span><span>2.50</span><span>42.50</span></div><div><span>Luis Vega</span><span>40.00</span><span>4.00</span><span>44.00</span></div></div><div className="proposal-actions"><button className="proposal-button secondary"><FileSpreadsheet size={16} /> XLSX</button><button className="proposal-button secondary"><Download size={16} /> CSV</button></div></div>;
}

function PricingCalculator({ payload }: { payload: ProposalPayload }) {
  const [plants, setPlants] = useState(payload.proposal.initialPlants);
  const [stations, setStations] = useState(payload.proposal.initialStations);
  const [employees, setEmployees] = useState(payload.proposal.initialEmployees);
  const totals = calculateProposalTotals(stations, plants, employees, payload.pricing);
  return <section id="calculadora" className="proposal-section proposal-calculator"><SectionHeading eyebrow="CALCULADORA TRANSPARENTE" title="Ajusta el alcance y revisa cada total"><p>Precios en dólares estadounidenses {payload.proposal.taxesIncluded ? 'con el tratamiento fiscal indicado en esta propuesta.' : 'antes de impuestos.'}</p></SectionHeading><div className="proposal-calculator-layout"><form><label>Plantas <input aria-label="Número de plantas" type="number" min="1" max="20" value={plants} onChange={(event) => setPlants(Math.max(1, Number(event.target.value)))} /></label><label>Estaciones <input aria-label="Número de estaciones" type="number" min="1" max="100" value={stations} onChange={(event) => setStations(Math.max(1, Number(event.target.value)))} /></label><label>Empleados aproximados <input aria-label="Número aproximado de empleados" type="number" min="1" max="100000" value={employees} onChange={(event) => setEmployees(Math.max(1, Number(event.target.value)))} /></label><p><Tablet size={17} /> {stations} estación(es) administrada(s)</p>{totals.expansionQuoteRequired && <div role="status"><AlertTriangle size={18} /><strong>Este alcance requiere una cotización de expansión.</strong><span>El precio base de implementación cubre hasta 80 empleados y tres plantas; no se ha inventado un cargo adicional.</span></div>}</form><div className="proposal-totals"><Metric label="Implementación" value={usd(totals.implementationCents)} /><Metric label="Plataforma mensual" value={usd(totals.platformMonthlyCents)} /><Metric label={`Estaciones desde mes 2 (${stations} × ${usd(payload.pricing.stationMonthlyCents)})`} value={usd(totals.stationsMonthlyCents)} /><Metric label="Total del primer mes" value={usd(totals.firstMonthCents)} note="Las estaciones no se cobran durante el piloto" /><Metric label="Desde el segundo mes" value={usd(totals.normalMonthlyCents)} /><Metric label="Primer año estimado" value={usd(totals.firstYearCents)} /><Metric label="A partir del segundo año" value={usd(totals.secondYearCents)} note="Doce mensualidades normales" /></div></div></section>;
}

function ValueSimulator() {
  const [review, setReview] = useState(5), [correction, setCorrection] = useState(3), [accountant, setAccountant] = useState(2), [hourly, setHourly] = useState(28), [closes, setCloses] = useState(52);
  const hours = (review + correction + accountant) * closes;
  const cost = hours * hourly;
  return <section className="proposal-section proposal-value"><SectionHeading eyebrow="SIMULADOR DE VALOR" title="Haz visible el costo administrativo actual"><p>Escenario ilustrativo. NODO no garantiza estos ahorros; el resultado real depende de la operación y adopción.</p></SectionHeading><div className="proposal-value-layout"><form>{[['Revisar checadas / semana', review, setReview], ['Corregir errores / semana', correction, setCorrection], ['Preparar información / semana', accountant, setAccountant], ['Costo administrativo / hora', hourly, setHourly], ['Cierres por año', closes, setCloses]].map(([label, value, setter]) => <label key={String(label)}>{String(label)}<input type="number" min="0" value={Number(value)} onChange={(event) => (setter as (number: number) => void)(Math.max(0, Number(event.target.value)))} /></label>)}</form><div><Metric label="Horas administrativas anuales actuales" value={`${hours.toLocaleString('en-US')} h`} /><Metric label="Costo administrativo anual estimado" value={usd(cost * 100)} /><h3>Ahorro potencial estimado</h3>{[25, 50, 75].map((percentage) => <p key={percentage}><span>Reducción ilustrativa del {percentage}%</span><strong>{Math.round(hours * percentage / 100)} h · {usd(Math.round(cost * percentage))}</strong></p>)}<small>Estos escenarios no se descuentan del precio ni constituyen una promesa de resultado.</small></div></div></section>;
}

function ImplementationPlan() {
  return <section id="implementacion" className="proposal-section"><SectionHeading eyebrow="PLAN DE IMPLEMENTACIÓN" title="De descubrimiento a una primera semana validada" /><ol className="proposal-implementation-steps">{IMPLEMENTATION_STEPS.map((step, index) => <li key={step}><span>{String(index + 1).padStart(2, '0')}</span><p>{step}</p></li>)}</ol><div className="proposal-responsibilities"><article><h3><Building2 /> Nod3 Studio</h3><CheckList items={['Configurar plataforma, plantas, reglas y permisos', 'Preparar y administrar estaciones', 'Capacitar responsables', 'Acompañar piloto, salida y estabilización', 'Monitorear infraestructura y respaldos']} /></article><article><h3><Users /> Cliente</h3><CheckList items={['Entregar información correcta y actualizada', 'Validar tasas, reglas y clasificación laboral', 'Proporcionar internet y electricidad', 'Designar responsables y participar en capacitación', 'Revisar incidencias y autorizar el cierre', 'Proteger físicamente las estaciones']} /></article></div></section>;
}

function TrustCenter() {
  const faqs = [
    ['¿Qué ocurre si falla internet?', 'La estación conserva el evento en una cola local durable y reintenta en orden cuando regresa la conexión. La operación de campo debe validar el dispositivo y Wi‑Fi reales.'],
    ['¿Se puede borrar una checada original?', 'No. Las correcciones anulan mediante un registro auditado y crean un reemplazo; actor, fecha y motivo permanecen.'],
    ['¿Qué ve la contadora?', 'Versiones finales, horas por categoría, detalle diario y exportes. No ve fotos, biometría, tasas, costos ni configuración administrativa innecesaria.'],
    ['¿Cómo se respaldan los datos?', 'La plataforma incluye backups, verificación periódica y un proceso documentado de restauración en un entorno aislado.'],
    ['¿Qué pasa si falla una estación?', 'Nod3 monitorea y brinda soporte. El reemplazo por falla cubierta está sujeto a disponibilidad y términos; no implica reemplazo inmediato en sitio.'],
    ['¿Qué no debe compartirse?', 'Códigos de enrolamiento, tokens, credenciales, fotografías, datos personales o reportes fuera de los canales autorizados.'],
    ['¿NODO procesa la nómina?', 'No. Congela y exporta las horas aprobadas; la contadora procesa pago, impuestos y depósitos en su sistema actual.'],
  ];
  return <section id="confianza" className="proposal-section proposal-trust"><SectionHeading eyebrow="CENTRO DE CONFIANZA" title="Respuestas operativas, sin letra pequeña"><p>El cliente conserva la responsabilidad sobre datos fuente, reglas laborales, conectividad, energía, autorizaciones y protección física.</p></SectionHeading><div className="proposal-trust-cards"><article><WifiOff /><h3>Sin internet</h3><p>Captura local durable, sincronización ordenada y excepciones visibles.</p></article><article><History /><h3>Correcciones</h3><p>Original preservado, motivo obligatorio e historial auditable.</p></article><article><UserCheck /><h3>Contadora</h3><p>Acceso mínimo a versiones finales y exportes verificables.</p></article><article><ShieldCheck /><h3>Evidencia</h3><p>Acceso limitado, enlaces temporales y retención definida.</p></article><article><Laptop /><h3>Operación técnica</h3><p>Health checks, almacenamiento privado, backups y restauración.</p></article><article><Tablet /><h3>Estación</h3><p>Monitoreo y reemplazo cubierto conforme a contrato.</p></article></div><div className="proposal-faq">{faqs.map(([question, answer]) => <details key={question}><summary>{question}<ChevronRight size={17} /></summary><p>{answer}</p></details>)}</div></section>;
}

function Investment({ pricing, taxesIncluded }: { pricing: ProposalPayload['pricing']; taxesIncluded: boolean }) {
  const three = calculateProposalTotals(3, 1, 80, pricing);
  return <section id="inversion" className="proposal-section proposal-investment"><SectionHeading eyebrow="INVERSIÓN" title="Tres componentes. Sin cargos ocultos."><p>Pago de implementación disponible en 50% al firmar y 50% al salir a producción.</p></SectionHeading><div className="proposal-price-cards"><article><span>PAGO ÚNICO</span><h3>Implementación inicial y puesta en operación</h3><strong>{usd(pricing.implementationCents)} <small>USD</small></strong><CheckList items={IMPLEMENTATION} /><p>Personalizaciones extraordinarias, limpieza manual extensa, visitas adicionales, integraciones no contempladas o cambios posteriores de alcance se cotizan por separado.</p></article><article><span>MENSUAL</span><h3>Plataforma NODO Clock-In</h3><strong>{usd(pricing.platformMonthlyCents)} <small>USD / mes</small></strong><CheckList items={PLATFORM} /></article><article className="featured"><span>PRIMER MES INCLUIDO</span><h3>Estación NODO administrada</h3><strong>{usd(pricing.stationMonthlyCents)} <small>USD / mes por estación</small></strong><p className="proposal-pilot-note">Durante el primer mes no se cobra la mensualidad de las estaciones.</p><CheckList items={STATION} /><h4>No incluido</h4><CheckList items={STATION_EXCLUSIONS} /></article></div><div className="proposal-example"><h3>Ejemplo transparente · tres estaciones</h3><div><Metric label="Primer mes" value={usd(three.firstMonthCents)} /><Metric label="Desde el segundo mes" value={`${usd(three.normalMonthlyCents)} / mes`} /><Metric label="Primer año" value={usd(three.firstYearCents)} /><Metric label="Segundo año" value={usd(three.secondYearCents)} /></div><p>{taxesIncluded ? 'Tratamiento fiscal según la configuración de esta propuesta.' : 'Precios antes de impuestos.'} La propuesta final, cobertura de hardware, visitas presenciales, tiempos de reemplazo y condiciones de servicio se definirán en el contrato.</p></div></section>;
}

function Acceptance({ payload }: { payload: ProposalPayload }) {
  const proposal = payload.proposal;
  const [input, setInput] = useState<AcceptanceInput>({ legalCompanyName: proposal.clientName, representativeName: '', email: '', phone: '', stations: proposal.initialStations, plants: proposal.initialPlants, employees: proposal.initialEmployees, pricingConfirmed: false, termsAccepted: false, signature: '', requestKickoff: true });
  const [errors, setErrors] = useState<AcceptanceErrors>({});
  const [sending, setSending] = useState(false);
  const [accepted, setAccepted] = useState<{ id: string; at: string } | null>(null);
  const [serverError, setServerError] = useState('');
  const totals = useMemo(() => calculateProposalTotals(input.stations, input.plants, input.employees, payload.pricing), [input.stations, input.plants, input.employees, payload.pricing]);
  function set<K extends keyof AcceptanceInput>(key: K, value: AcceptanceInput[K]): void { setInput((current) => ({ ...current, [key]: value })); }
  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault(); const nextErrors = validateAcceptance(input); setErrors(nextErrors); setServerError('');
    if (Object.keys(nextErrors).length) return;
    setSending(true);
    try {
      const response = await fetch(`/api/proposals/${encodeURIComponent(proposal.slug)}/acceptances`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
      const body = await response.json().catch(() => ({})) as { error?: string; acceptance_id?: string; accepted_at?: string };
      if (!response.ok || !body.acceptance_id || !body.accepted_at) throw new Error(body.error ?? 'No fue posible registrar la solicitud.');
      setAccepted({ id: body.acceptance_id, at: body.accepted_at });
    } catch (error) { setServerError(error instanceof Error ? error.message : 'No fue posible registrar la solicitud.'); }
    finally { setSending(false); }
  }
  function downloadSummary(): void {
    const content = [`NODO Clock-In · Solicitud de contrato`, `Propuesta: ${proposal.version}`, `Empresa: ${input.legalCompanyName}`, `Representante: ${input.representativeName}`, `Estaciones: ${input.stations}`, `Primer mes: ${usd(totals.firstMonthCents)}`, `Mensualidad normal: ${usd(totals.normalMonthlyCents)}`, `Primer año: ${usd(totals.firstYearCents)}`, `Registro: ${accepted?.id ?? 'borrador'}`, `Fecha: ${accepted?.at ?? new Date().toISOString()}`].join('\n');
    const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' })); const link = document.createElement('a'); link.href = url; link.download = `resumen-nodo-${proposal.slug}.txt`; link.click(); URL.revokeObjectURL(url);
  }
  return <section id="aceptacion" className="proposal-section proposal-acceptance"><SectionHeading eyebrow="SIGUIENTE PASO" title="Aceptar propuesta y solicitar contrato"><p>Esta acción no procesa pagos ni sustituye el contrato definitivo. Registra la configuración revisada y solicita el kickoff.</p></SectionHeading>{accepted ? <div className="proposal-accepted"><FileCheck2 size={42} /><h3>Solicitud registrada</h3><p>Recibimos la aceptación para preparar el contrato y coordinar el kickoff.</p><dl><dt>Identificador</dt><dd>{accepted.id}</dd><dt>Fecha y hora</dt><dd>{new Date(accepted.at).toLocaleString('es-US')}</dd><dt>Versión</dt><dd>{proposal.version}</dd></dl><div className="proposal-actions"><button className="proposal-button primary" onClick={downloadSummary}><Download size={16} /> Descargar resumen</button><button className="proposal-button secondary" onClick={() => window.print()}><Printer size={16} /> Guardar PDF</button></div></div> : <div className="proposal-acceptance-layout"><form onSubmit={submit} noValidate><div className="proposal-form-grid"><Field label="Nombre legal de la empresa" error={errors.legalCompanyName}><input value={input.legalCompanyName} onChange={(event) => set('legalCompanyName', event.target.value)} /></Field><Field label="Representante" error={errors.representativeName}><input value={input.representativeName} onChange={(event) => set('representativeName', event.target.value)} /></Field><Field label="Correo" error={errors.email}><input type="email" value={input.email} onChange={(event) => set('email', event.target.value)} /></Field><Field label="Teléfono" error={errors.phone}><input type="tel" value={input.phone} onChange={(event) => set('phone', event.target.value)} /></Field><Field label="Número de estaciones" error={errors.stations}><input type="number" min="1" value={input.stations} onChange={(event) => set('stations', Math.max(1, Number(event.target.value)))} /></Field><Field label="Nombre como firma electrónica" error={errors.signature}><input value={input.signature} onChange={(event) => set('signature', event.target.value)} placeholder="Debe coincidir con el representante" /></Field></div><label className="proposal-checkbox"><input type="checkbox" checked={input.pricingConfirmed} onChange={(event) => set('pricingConfirmed', event.target.checked)} /><span>Confirmo implementación de {usd(totals.implementationCents)}, plataforma de {usd(totals.platformMonthlyCents)}/mes y {input.stations} estación(es) a {usd(payload.pricing.stationMonthlyCents)}/mes cada una, con primer mes de estaciones incluido.</span></label>{errors.pricingConfirmed && <p className="proposal-form-error">{errors.pricingConfirmed}</p>}<label className="proposal-checkbox"><input type="checkbox" checked={input.termsAccepted} onChange={(event) => set('termsAccepted', event.target.checked)} /><span>{payload.consent}</span></label>{errors.termsAccepted && <p className="proposal-form-error">{errors.termsAccepted}</p>}<label className="proposal-checkbox"><input type="checkbox" checked={input.requestKickoff} onChange={(event) => set('requestKickoff', event.target.checked)} /><span>Solicitar coordinación de kickoff después de preparar el contrato.</span></label>{serverError && <p className="proposal-form-error" role="alert">{serverError}</p>}<button className="proposal-submit" disabled={sending}>{sending ? 'Registrando solicitud…' : 'Aceptar propuesta y solicitar contrato'} <ArrowRight size={17} /></button><small>Se registra versión, configuración, precios, fecha, identificador de sesión y consentimiento mostrado. No se recopila la dirección IP por defecto.</small></form><aside><h3>Configuración a confirmar</h3><Metric label="Plantas" value={String(input.plants)} /><Metric label="Empleados aprox." value={String(input.employees)} /><Metric label="Estaciones" value={String(input.stations)} /><Metric label="Primer mes" value={usd(totals.firstMonthCents)} /><Metric label="Mensualidad normal" value={usd(totals.normalMonthlyCents)} /><Metric label="Primer año estimado" value={usd(totals.firstYearCents)} />{totals.expansionQuoteRequired && <p><AlertTriangle size={17} /> Alcance sujeto a cotización de expansión.</p>}</aside></div>}</section>;
}

function Field({ label, error, children }: { label: string; error?: string; children: React.ReactElement }) {
  return <label>{label}{children}{error && <span className="proposal-form-error">{error}</span>}</label>;
}
