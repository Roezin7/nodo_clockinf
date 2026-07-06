# NODO CLOCK-IN

Sistema de control de asistencia para empacadora (kiosco PIN + foto, horas y overtime, reportes semanales para el contador).

## Estructura

- `server/` — API Node + TypeScript + Express 5 + Postgres (migraciones con node-pg-migrate)
- `client/` — React + Vite + TailwindCSS (panel admin + kiosco `/kiosk`)
- `shared/` — tipos TypeScript compartidos

## Desarrollo local

```bash
createdb clockai_dev
cp server/.env.example server/.env   # ajustar credenciales
npm install
npm run migrate
npm run seed        # áreas, turnos placeholder, admin admin@nodo.local/admin1234
npm run dev         # server :3001 + client :5173
```

⚠️ Los horarios de turnos del seed (Mañana 07:00–17:00, Cleaning 17:00–23:00) son **placeholder**; confirmar con la planta y ajustarlos en Configuración.

## Principios

1. `punches` es un log inmutable (trigger en DB lo garantiza); correcciones = registros nuevos con auditoría.
2. La ingesta de checadas es agnóstica al dispositivo; la verificación facial (Fase 7) es asíncrona y nunca bloquea.
3. Las horas son siempre un cálculo derivado de las checadas crudas; los reportes se pueden regenerar.
