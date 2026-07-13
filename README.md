# ClockAI

Control de asistencia para plantas de empaque: kioscos con evidencia facial,
operación sin conexión, horas y overtime de California, cierres semanales y
reportes auditables para la contadora. ClockAI calcula y exporta horas; no
ejecuta nómina, impuestos ni pagos.

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
npm run seed        # datos de desarrollo y admin local
npm run dev         # server :3001 + client :5173
```

Las credenciales predeterminadas del seed son sólo para desarrollo. Para otro
entorno define `SEED_ADMIN_EMAIL` y `SEED_ADMIN_PASSWORD` antes de ejecutarlo.

## Deploy (Render)

`render.yaml` define un web service (API + cliente estático servido por Express) y el Postgres managed. Pasos:

1. Sube el repo a GitHub y crea un Blueprint en Render apuntando a `render.yaml`.
2. Crea un bucket privado en Cloudflare R2/S3 y llena `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`. Producción no arranca sin almacenamiento duradero.
3. Opcionalmente genera una identidad VAPID y configura las tres variables `VAPID_*` para avisos Web Push. Sin ellas, la bandeja de notificaciones dentro de la app continúa funcionando.
4. Corre el seed una vez desde un shell de Render: `cd server && npm run seed` (usa `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` para no dejar el default).
5. Da de alta cada dispositivo desde Configuración y usa su código de enrolamiento de un solo uso en `/kiosk`. No distribuyas un token global entre tablets.

Variables de entorno documentadas en `server/.env.example`.

### Seguridad / hardening incluidos

- Rate limiting en autenticación, ingesta e identidad, con límite de identidad por dispositivo
- Refresh tokens rotados y revocables; revocación al desactivar usuarios
- Fotografías cifradas en la cola local y enlaces de evidencia firmados por 15 minutos
- Versiones de enrolamiento inmutables; desactivar al empleado retira el enrolamiento actual sin borrar evidencia histórica
- Job de retención de fotos con registro inmutable del purgado
- Triggers de Postgres que impiden UPDATE/DELETE del log de checadas

## Principios

1. `punches` es un log inmutable (trigger en DB lo garantiza); correcciones = registros nuevos con auditoría.
2. La identidad nunca bloquea ni retrasa la hora pagable: un fallo biométrico, técnico u offline acepta la checada y abre revisión.
3. Las horas son siempre un cálculo derivado de las checadas crudas; los reportes se pueden regenerar.

## Documentación por fase

- [Especificación operativa](docs/phase-0-spec.md)
- [Wireframes y flujos](docs/phase-0-wireframes.md)
- [Kiosco y sincronización offline](docs/phase-4-kiosk-reliability.md)
- [Identidad facial y revisión humana](docs/phase-5-facial-identity.md)
- [Incidencias operativas y notificaciones](docs/phase-6-operational-exceptions.md)
