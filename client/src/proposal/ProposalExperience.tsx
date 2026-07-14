import { useState } from 'react';
import {
  AlertTriangle, ArrowDown, ArrowRight, Building2, Check, CheckCircle2, ChevronRight,
  ClipboardCheck, Clock3, CloudOff, Download, FileSpreadsheet, Gauge, History,
  Laptop, Menu, MonitorCheck, Printer, ShieldCheck, UserCheck, Users,
  Wifi, WifiOff, X,
} from 'lucide-react';
import type { PunchType } from '@clockai/shared';
import type { ProposalPayload } from './types';
import { calculateProposalTotals, usd } from './pricing';
import {
  DEMO_ACTIONS, DEMO_EMPLOYEES, findDemoEmployeeByNumber, getDemoActionLabel,
  type LocalDemoPunch, WEEK_EVENTS,
} from './demoData';
import { PrintableProposal } from './print';

const CAPABILITIES = [
  ['Kiosco', 'Entrada, comida, regreso y salida · español e inglés · PWA instalable'],
  ['Sin conexión', 'Cola local, reintentos ordenados, prevención de duplicados y excepciones visibles'],
  ['Control', 'Plantas, empleados, turnos, tasas, dispositivos, usuarios y permisos'],
  ['Auditoría', 'Correcciones con motivo, originales preservados, horas manuales e historial'],
  ['Supervisión', 'Personal trabajando, incidencias, salud de estaciones y alertas de overtime'],
  ['Cierre', 'Revisión, bloqueadores, versiones congeladas y portal limitado de contadora'],
] as const;

const IMPLEMENTATION_ITEMS = [
  'Configuración de hasta tres plantas y 80 empleados', 'Turnos, tasas, usuarios y permisos',
  'Preparación de estaciones', 'Capacitación y piloto', 'Salida a producción y estabilización',
] as const;

const PLATFORM_ITEMS = ['Software e infraestructura', 'Monitoreo y backups', 'Actualizaciones y seguridad', 'Soporte remoto y almacenamiento privado'] as const;
const STATION_ITEMS = ['Tableta y cargador', 'Kiosco y soporte físico definido', 'Administración y monitoreo remoto', 'Soporte y reemplazo por falla cubierta según términos'] as const;

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
  const { proposal } = payload;
  const [mobileNav, setMobileNav] = useState(false);

  return <div className="proposal-page">
    <PrintableProposal proposal={proposal} />
    <header className="proposal-topbar">
      <a href="#inicio" className="proposal-brand" aria-label="Leader Solutions, inicio"><span>LS</span><span>NODO Clock-In</span></a>
      <button className="proposal-nav-toggle" onClick={() => setMobileNav((value) => !value)} aria-label="Abrir navegación" aria-expanded={mobileNav}>{mobileNav ? <X /> : <Menu />}</button>
      <nav className={mobileNav ? 'is-open' : ''} aria-label="Propuesta">
        <a href="#recorrido">Cómo funciona</a><a href="#demo">Demo</a><a href="#inversion">Inversión</a><a href="#implementacion">Implementación</a>
      </nav>
      <span className="proposal-private">Leader Solutions · v{proposal.version}</span>
    </header>

    <main>
      <section id="inicio" className="proposal-hero">
        <div className="proposal-hero-main">
          <p className="proposal-eyebrow">PROPUESTA PARA {proposal.commercialName.toLocaleUpperCase('es')}</p>
          <h1>De la checada de las 5:00 AM al cierre verificable del domingo.</h1>
          <p className="proposal-lead">NODO Clock-In concentra asistencia, correcciones y cierre semanal en un flujo directo y auditable para plantas de empaque.</p>
          <div className="proposal-actions"><a className="proposal-button primary" href="#recorrido">Ver cómo funciona <ArrowDown size={17} /></a><a className="proposal-button secondary" href="#inversion">Revisar inversión</a></div>
        </div>
        <aside className="proposal-brief">
          <div className="proposal-client-monogram" aria-hidden="true">{proposal.commercialName.slice(0, 2).toUpperCase()}</div>
          <h2>{proposal.commercialName}</h2>
          <dl><div><dt>Plantas</dt><dd>{proposal.initialPlants}</dd></div><div><dt>Empleados aprox.</dt><dd>{proposal.initialEmployees}</dd></div><div><dt>Estaciones</dt><dd>{proposal.initialStations}</dd></div><div><dt>Vigencia</dt><dd>{proposal.validUntil}</dd></div></dl>
        </aside>
      </section>

      <section className="proposal-section proposal-problem">
        <SectionHeading eyebrow="UN FLUJO MÁS SIMPLE" title="Menos traspasos. Más control."><p>La información deja de viajar entre hojas, mensajes y archivos separados.</p></SectionHeading>
        <div className="proposal-flow comparison"><Flow title="Hoy" items={['Checador', 'Mensajes', 'Correcciones', 'Archivo', 'Contadora']} muted /><Flow title="Con NODO" items={['Empleado', 'Estación', 'Foreman', 'Cierre', 'Contadora']} /></div>
        <div className="proposal-risk-grid compact">{['Sin duplicados', 'Correcciones explicadas', 'Operación offline', 'Cierre versionado'].map((item) => <span key={item}><CheckCircle2 size={15} />{item}</span>)}</div>
      </section>

      <WeekTour />
      <IsolatedDemo />
      <ProductViews />

      <section id="capacidades" className="proposal-section proposal-capabilities-short">
        <SectionHeading eyebrow="CAPACIDADES CLAVE" title="Lo necesario para operar y cerrar la semana" />
        <div className="proposal-capability-grid">{CAPABILITIES.map(([title, text]) => <article key={title}><CheckCircle2 size={20} /><h3>{title}</h3><p>{text}</p></article>)}</div>
        <aside className="proposal-legal-note"><ShieldCheck size={20} /><p>Las reglas laborales, tasas y clasificación aplicable deben validarse con el asesor del cliente. La comparación facial requiere revisión humana y no se presenta como prueba de vida.</p></aside>
      </section>

      <PricingSection payload={payload} />
      <ImplementationPlan />
      <TrustCenter />
    </main>

    <footer className="proposal-footer"><div><strong>{proposal.provider.name}</strong><span>{proposal.provider.email}</span><span>{proposal.provider.phone}</span></div><div><span>Válida hasta {proposal.validUntil}</span><button type="button" onClick={() => window.print()}><Printer size={15} /> Imprimir / guardar PDF</button></div></footer>
  </div>;
}

function Flow({ title, items, muted = false }: { title: string; items: string[]; muted?: boolean }) {
  return <article className={muted ? 'muted' : ''}><h3>{title}</h3><div>{items.map((item, index) => <span key={item}>{item}{index < items.length - 1 && <ArrowRight size={14} />}</span>)}</div></article>;
}

function WeekTour() {
  const [active, setActive] = useState(0);
  const event = WEEK_EVENTS[active]!;
  return <section id="recorrido" className="proposal-section proposal-week">
    <SectionHeading eyebrow="UNA SEMANA EN 5 PASOS" title="De la primera entrada al archivo final"><p>Escenario demostrativo; no modifica información real.</p></SectionHeading>
    <div className="proposal-week-layout"><ol>{WEEK_EVENTS.map((item, index) => <li key={item[0]} className={index === active ? 'active' : index < active ? 'done' : ''}><button onClick={() => setActive(index)} aria-current={index === active ? 'step' : undefined}><span>{index + 1}</span><small>{item[0]}</small><strong>{item[1]}</strong></button></li>)}</ol><article aria-live="polite"><span>PASO {active + 1} DE {WEEK_EVENTS.length}</span>{active === 2 ? <CloudOff size={34} /> : active >= 3 ? <ClipboardCheck size={34} /> : <Clock3 size={34} />}<h3>{event[1]}</h3><p>{event[2]}</p><div className="proposal-actions"><button className="proposal-button secondary" disabled={active === 0} onClick={() => setActive((value) => Math.max(0, value - 1))}>Anterior</button><button className="proposal-button primary" disabled={active === WEEK_EVENTS.length - 1} onClick={() => setActive((value) => Math.min(WEEK_EVENTS.length - 1, value + 1))}>Siguiente <ChevronRight size={16} /></button></div></article></div>
  </section>;
}

function IsolatedDemo() {
  const [step, setStep] = useState<'number' | 'action' | 'confirmation'>('number');
  const [language, setLanguage] = useState<'es' | 'en'>('es');
  const [employeeNumber, setEmployeeNumber] = useState('');
  const [employeeId, setEmployeeId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [online, setOnline] = useState(true);
  const [punches, setPunches] = useState<LocalDemoPunch[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [latestPunch, setLatestPunch] = useState<LocalDemoPunch | null>(null);

  const employee = DEMO_EMPLOYEES.find((candidate) => candidate.id === employeeId);

  function enterDigit(digit: string): void {
    setError('');
    setEmployeeNumber((value) => value.length < 6 ? `${value}${digit}` : value);
  }

  function identify(): void {
    const match = findDemoEmployeeByNumber(employeeNumber);
    if (!match) {
      setError(language === 'es' ? 'Número no encontrado en esta demostración.' : 'Number not found in this demo.');
      return;
    }
    setEmployeeId(match.id);
    setError('');
    setStep('action');
  }

  function punch(action: PunchType): void {
    if (!employeeId) return;
    const next: LocalDemoPunch = { id: crypto.randomUUID(), employeeId, action, capturedAt: new Date().toISOString(), state: online ? 'synced' : 'pending' };
    setPunches((items) => [next, ...items].slice(0, 5));
    setLatestPunch(next);
    setStep('confirmation');
  }

  function reconnect(): void {
    setOnline(true); setSyncing(true);
    window.setTimeout(() => {
      setPunches((items) => items.map((item) => ({ ...item, state: 'synced' })));
      setLatestPunch((item) => item ? { ...item, state: 'synced' } : item);
      setSyncing(false);
    }, 650);
  }

  function finish(): void {
    setEmployeeNumber('');
    setEmployeeId(null);
    setLatestPunch(null);
    setError('');
    setStep('number');
  }

  const pending = punches.filter((item) => item.state === 'pending').length;
  return <section id="demo" className="proposal-section proposal-demo">
    <SectionHeading eyebrow="PRUÉBALO" title="Haz una checada de demostración"><p>Kiosco local con personas ficticias. No usa cámara, no envía información y se borra al recargar.</p></SectionHeading>
    <div className="proposal-demo-shell">
      <header>
        <div><strong>NODO Clock-In</strong><span>Planta Demo · datos locales</span></div>
        <div className="proposal-kiosk-toolbar">
          <div className="proposal-language" aria-label="Idioma"><button className={language === 'es' ? 'active' : ''} onClick={() => setLanguage('es')}>ES</button><button className={language === 'en' ? 'active' : ''} onClick={() => setLanguage('en')}>EN</button></div>
          <span className={online ? 'online' : 'offline'}>{online ? <Wifi size={15} /> : <WifiOff size={15} />}{online ? (language === 'es' ? 'En línea' : 'Online') : (language === 'es' ? 'Sin conexión' : 'Offline')}</span>
        </div>
      </header>
      <div className="proposal-demo-body">
        <div className="proposal-kiosk-screen">
          {step === 'number' && <div className="proposal-kiosk-number">
            <span className="proposal-demo-label">{language === 'es' ? 'IDENTIFICACIÓN' : 'IDENTIFICATION'}</span>
            <h3>{language === 'es' ? 'Ingresa tu número' : 'Enter your number'}</h3>
            <p>{language === 'es' ? 'Para probar usa 1042, 1071 o 1088.' : 'For this demo use 1042, 1071, or 1088.'}</p>
            <output className="proposal-kiosk-display" aria-live="polite">{employeeNumber || '— — — —'}</output>
            {error && <p className="proposal-kiosk-error" role="alert">{error}</p>}
            <div className="proposal-keypad">{['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => <button key={digit} onClick={() => enterDigit(digit)}>{digit}</button>)}<button className="utility" onClick={() => { setError(''); setEmployeeNumber((value) => value.slice(0, -1)); }}>{language === 'es' ? 'Borrar' : 'Delete'}</button><button onClick={() => enterDigit('0')}>0</button><button className="continue" disabled={!employeeNumber} onClick={identify}>{language === 'es' ? 'Continuar' : 'Continue'} <ChevronRight size={17} /></button></div>
          </div>}

          {step === 'action' && employee && <div className="proposal-kiosk-action-step">
            <span className="proposal-demo-label">{language === 'es' ? 'EMPLEADO IDENTIFICADO' : 'EMPLOYEE IDENTIFIED'}</span>
            <h3>{language === 'es' ? `Hola, ${employee.name}` : `Hello, ${employee.name}`}</h3>
            <p>#{employee.number} · {language === 'es' ? 'Selecciona una acción' : 'Choose an action'}</p>
            <div className="proposal-demo-actions">{DEMO_ACTIONS.map((action) => <button key={action.type} onClick={() => punch(action.type)}><Clock3 size={20} />{language === 'en' ? action.labelEn : action.label}</button>)}</div>
            <button className="proposal-kiosk-back" onClick={finish}>{language === 'es' ? 'Cambiar empleado' : 'Change employee'}</button>
          </div>}

          {step === 'confirmation' && employee && latestPunch && <div className={`proposal-kiosk-confirmation ${latestPunch.state}`} aria-live="polite">
            {latestPunch.state === 'synced' ? <CheckCircle2 size={54} /> : <CloudOff size={54} />}
            <span className="proposal-demo-label">{latestPunch.state === 'synced' ? (language === 'es' ? 'REGISTRO COMPLETADO' : 'PUNCH COMPLETE') : (language === 'es' ? 'GUARDADO EN EL DISPOSITIVO' : 'SAVED ON DEVICE')}</span>
            <h3>{getDemoActionLabel(latestPunch.action, language)}</h3>
            <p>{employee.name} · {new Date(latestPunch.capturedAt).toLocaleTimeString(language === 'es' ? 'es-MX' : 'en-US', { hour: 'numeric', minute: '2-digit' })}</p>
            <small>{latestPunch.state === 'synced' ? (language === 'es' ? 'Sincronizado correctamente.' : 'Synced successfully.') : (language === 'es' ? 'Se sincronizará al recuperar internet.' : 'It will sync when internet returns.')}</small>
            <button className="proposal-kiosk-finish" onClick={finish}>{language === 'es' ? 'Terminar' : 'Finish'}</button>
          </div>}

          <button className="proposal-network-button" onClick={() => online ? setOnline(false) : reconnect()} disabled={syncing}>{online ? <><WifiOff size={17} /> {language === 'es' ? 'Simular pérdida de conexión' : 'Simulate connection loss'}</> : <><Wifi size={17} /> {syncing ? (language === 'es' ? 'Sincronizando…' : 'Syncing…') : (language === 'es' ? 'Reconectar y sincronizar' : 'Reconnect and sync')}</>}</button>
        </div>
        <aside><div className="proposal-queue"><span>Cola local</span><strong>{pending}</strong><small>{syncing ? 'Sincronizando…' : pending ? 'Pendiente' : 'Sin pendientes'}</small></div><h3>Actividad de prueba</h3>{punches.length === 0 ? <p>Las checadas aparecerán aquí.</p> : <ul>{punches.map((item) => { const itemEmployee = DEMO_EMPLOYEES.find((candidate) => candidate.id === item.employeeId)!; return <li key={item.id}><span className={item.state}></span><div><strong>{itemEmployee.name}</strong><small>{getDemoActionLabel(item.action, language)}</small></div><em>{item.state === 'synced' ? 'Listo' : 'Pendiente'}</em></li>; })}</ul>}<p className="proposal-demo-disclaimer"><ShieldCheck size={15} /> Demo aislada: no afecta horas reales.</p></aside>
      </div>
    </div>
  </section>;
}

function ProductViews() {
  const tabs = ['Dashboard', 'Incidencias', 'Estaciones', 'Cierre', 'Contadora'] as const;
  const [tab, setTab] = useState<(typeof tabs)[number]>('Dashboard');
  return <section className="proposal-section proposal-product-views"><SectionHeading eyebrow="VISTAS DEL SISTEMA" title="Cada persona ve lo que necesita"><p>Datos ficticios sobre vistas respaldadas por el sistema real.</p></SectionHeading><div className="proposal-view-tabs" role="tablist">{tabs.map((item) => <button role="tab" aria-selected={tab === item} key={item} onClick={() => setTab(item)}>{item}</button>)}</div><div className="proposal-view-frame" role="tabpanel"><aside><strong>NODO</strong>{tabs.map((item) => <span className={tab === item ? 'active' : ''} key={item}>{item}</span>)}</aside><MockView tab={tab} /></div></section>;
}

function MockView({ tab }: { tab: string }) {
  if (tab === 'Dashboard') return <div className="mock-dashboard"><header><div><h3>Operación actual</h3><p>Datos demostrativos</p></div><span>Actualizado ahora</span></header><div className="mock-metrics"><Metric label="Trabajando" value="47" /><Metric label="En comida" value="6" /><Metric label="Abiertas" value="2" /><Metric label="Atención" value="1" /></div><div className="mock-panels"><article><h4>Por planta</h4><p>Planta Norte <strong>24</strong></p><p>Planta Sur <strong>23</strong></p></article><article><h4>Próximos a overtime</h4><p>Ana Rivera <strong>39.2 h</strong></p><p>Luis Vega <strong>38.6 h</strong></p></article></div></div>;
  if (tab === 'Incidencias') return <div className="mock-dashboard"><header><div><h3>Incidencias</h3><p>Cola para revisión</p></div><span>3 abiertas</span></header><div className="mock-list"><p><AlertTriangle /> Regreso de comida faltante <span>María Soto · Planta Norte</span><b>Revisar</b></p><p><History /> Corrección documentada <span>Ana Rivera · motivo registrado</span><b>Auditable</b></p></div></div>;
  if (tab === 'Estaciones') return <div className="mock-dashboard"><header><div><h3>Salud de estaciones</h3><p>Sin evidencia personal</p></div><span>2 de 2 operativas</span></header><div className="mock-device"><MonitorCheck /><div><strong>Norte 01</strong><span>Conectada · cola 0</span></div><b>Saludable</b></div><div className="mock-device"><Gauge /><div><strong>Sur 01</strong><span>Conectada · sincronizada</span></div><b>Saludable</b></div></div>;
  if (tab === 'Cierre') return <div className="mock-dashboard"><header><div><h3>Semana 5–11 de julio</h3><p>Lista para revisión</p></div><span>Versión v1</span></header><div className="mock-metrics"><Metric label="Regular" value="612.0 h" /><Metric label="OT 1.5" value="18.5 h" /><Metric label="Doble" value="1.0 h" /><Metric label="Manual" value="3.5 h" /></div><div className="mock-close"><CheckCircle2 /><div><strong>Sin bloqueadores</strong><span>Se congelará una versión verificable.</span></div></div></div>;
  return <div className="mock-dashboard"><header><div><h3>Portal de contadora</h3><p>Solo lectura · versión final</p></div><span>FINAL v1</span></header><div className="mock-table"><div><b>Empleado</b><b>Regular</b><b>OT</b><b>Total</b></div><div><span>Ana Rivera</span><span>40.00</span><span>2.50</span><span>42.50</span></div><div><span>Luis Vega</span><span>40.00</span><span>4.00</span><span>44.00</span></div></div><div className="proposal-actions"><button className="proposal-button secondary"><FileSpreadsheet size={16} /> XLSX</button><button className="proposal-button secondary"><Download size={16} /> CSV</button></div></div>;
}

function PricingSection({ payload }: { payload: ProposalPayload }) {
  const [plants, setPlants] = useState(payload.proposal.initialPlants);
  const [stations, setStations] = useState(payload.proposal.initialStations);
  const [employees, setEmployees] = useState(payload.proposal.initialEmployees);
  const totals = calculateProposalTotals(stations, plants, employees, payload.pricing);
  return <section id="inversion" className="proposal-section proposal-pricing">
    <SectionHeading eyebrow="INVERSIÓN" title="Precios claros, calculados en tiempo real"><p>USD {payload.proposal.taxesIncluded ? 'con tratamiento fiscal según esta propuesta.' : 'antes de impuestos.'} El primer mes de estaciones está incluido durante el piloto.</p></SectionHeading>
    <div className="proposal-price-cards compact"><article><span>PAGO ÚNICO</span><h3>Implementación y puesta en operación</h3><strong>{usd(payload.pricing.implementationCents)}</strong><details><summary>Qué incluye</summary><CheckList items={IMPLEMENTATION_ITEMS} /></details></article><article><span>MENSUAL</span><h3>Plataforma NODO Clock-In</h3><strong>{usd(payload.pricing.platformMonthlyCents)} <small>/ mes</small></strong><details><summary>Qué incluye</summary><CheckList items={PLATFORM_ITEMS} /></details></article><article className="featured"><span>MES 1 INCLUIDO</span><h3>Estación NODO administrada</h3><strong>{usd(payload.pricing.stationMonthlyCents)} <small>/ mes</small></strong><details><summary>Qué incluye</summary><CheckList items={STATION_ITEMS} /></details></article></div>
    <div className="proposal-pricing-calculator"><form><h3>Ajustar alcance</h3><label>Plantas <input aria-label="Número de plantas" type="number" min="1" value={plants} onChange={(event) => setPlants(Math.max(1, Number(event.target.value)))} /></label><label>Estaciones <input aria-label="Número de estaciones" type="number" min="1" value={stations} onChange={(event) => setStations(Math.max(1, Number(event.target.value)))} /></label><label>Empleados <input aria-label="Número de empleados" type="number" min="1" value={employees} onChange={(event) => setEmployees(Math.max(1, Number(event.target.value)))} /></label>{totals.expansionQuoteRequired && <p><AlertTriangle size={17} /> Este alcance requiere cotización de expansión.</p>}</form><div className="proposal-totals"><Metric label="Primer mes" value={usd(totals.firstMonthCents)} note="Estaciones: $0 durante el piloto" /><Metric label="Desde el mes 2" value={`${usd(totals.normalMonthlyCents)} / mes`} /><Metric label="Primer año" value={usd(totals.firstYearCents)} /><Metric label="A partir del segundo año" value={`${usd(totals.secondYearCents)} / año`} /></div></div>
    <p className="proposal-price-note">Implementación: 50% al firmar y 50% al salir a producción. Personalizaciones, integraciones, visitas adicionales y cambios de alcance se cotizan por separado. Internet, electricidad, robo, pérdida, mal uso y daños no cubiertos quedan fuera.</p>
  </section>;
}

function ImplementationPlan() {
  const steps = ['Descubrimiento y datos', 'Configuración', 'Estaciones y capacitación', 'Piloto y primer cierre', 'Producción y estabilización'];
  return <section id="implementacion" className="proposal-section"><SectionHeading eyebrow="IMPLEMENTACIÓN" title="Cinco etapas para entrar en operación" /><ol className="proposal-implementation-steps compact">{steps.map((step, index) => <li key={step}><span>{String(index + 1).padStart(2, '0')}</span><p>{step}</p></li>)}</ol><div className="proposal-responsibilities"><article><h3><Building2 /> Leader Solutions</h3><p>Configura plataforma y estaciones, capacita y acompaña el piloto y la estabilización.</p></article><article><h3><Users /> Cliente</h3><p>Entrega datos correctos, valida reglas, provee internet y energía, y autoriza el cierre.</p></article></div></section>;
}

function TrustCenter() {
  const items = [
    ['¿Qué pasa sin internet?', 'La estación conserva las checadas y sincroniza en orden al recuperar conexión.'],
    ['¿Se borra una checada corregida?', 'No. El original, el motivo, la fecha y el responsable permanecen en auditoría.'],
    ['¿Qué ve la contadora?', 'Sólo horas finales, detalle diario y exportes; no ve biometría ni configuración sensible.'],
    ['¿NODO procesa la nómina?', 'No. Entrega horas aprobadas para que la contadora procese el pago en su sistema actual.'],
  ];
  return <section id="confianza" className="proposal-section proposal-trust"><SectionHeading eyebrow="PREGUNTAS CLAVE" title="Lo esencial antes de comenzar" /><div className="proposal-faq compact">{items.map(([question, answer]) => <details key={question}><summary>{question}<ChevronRight size={17} /></summary><p>{answer}</p></details>)}</div><div className="proposal-trust-strip"><span><WifiOff /> Operación offline</span><span><History /> Auditoría</span><span><UserCheck /> Acceso limitado</span><span><Laptop /> Backups y monitoreo</span></div></section>;
}
