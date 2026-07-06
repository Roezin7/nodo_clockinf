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

## Deploy (Render)

`render.yaml` define un web service (API + cliente estático servido por Express) y el Postgres managed. Pasos:

1. Sube el repo a GitHub y crea un Blueprint en Render apuntando a `render.yaml`.
2. Crea un bucket en Cloudflare R2 y llena `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` en el dashboard (sin esto, las fotos caen a disco local: solo aceptable en dev).
3. Corre el seed una vez desde un shell de Render: `cd server && npm run seed` (usa `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` para no dejar el default).
4. Configura la tablet: abre `https://<tu-app>/kiosk?token=<KIOSK_DEVICE_TOKEN>` una vez; el token queda en la tablet.

Variables de entorno documentadas en `server/.env.example`.

### Seguridad / hardening incluidos

- Rate limiting en `/api/punches/ingest` (60/min) y `/api/auth/login` (10/min)
- Lockout de PIN: 3 intentos fallidos → 60 s por número de empleado
- Refresh tokens rotados y revocables; revocación al desactivar usuarios
- Job de retención: borra fotos de checada con más de N semanas (configurable);
  la foto de enrolamiento se borra al dar de baja al empleado
- Triggers de Postgres que impiden UPDATE/DELETE del log de checadas

## Principios

1. `punches` es un log inmutable (trigger en DB lo garantiza); correcciones = registros nuevos con auditoría.
2. La ingesta de checadas es agnóstica al dispositivo; la verificación facial (Fase 7) es asíncrona y nunca bloquea.
3. Las horas son siempre un cálculo derivado de las checadas crudas; los reportes se pueden regenerar.
