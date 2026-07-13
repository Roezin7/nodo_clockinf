# Deploy en Coolify

Una sola app (Dockerfile en la raíz: API + cliente estático) + una Postgres local de Coolify.

## 1. Base de datos (Postgres local de Coolify)

1. En Coolify: **+ New → Database → PostgreSQL** (versión 16 o 17), en el mismo *project/environment* donde vivirá la app.
2. Iniciarla y copiar la **URL interna** (`postgres://…@<nombre-del-recurso>:5432/postgres`). Usa la URL **interna**, no la pública: app y DB comparten la red de Docker de Coolify.
3. No hace falta crear tablas: las migraciones (`node-pg-migrate`) corren solas en cada arranque del contenedor.

## 2. Aplicación

1. **+ New → Application → repositorio Git** de este proyecto, rama `main`.
2. **Build Pack: Dockerfile** (raíz del repo).
3. **Port:** `3001`.
4. **Health check path:** `/api/health`.

### Variables de entorno

| Variable | Valor |
|---|---|
| `DATABASE_URL` | URL interna de la Postgres de Coolify (paso 1), p. ej. `postgres://postgres:<password>@lx9hp7sstidgg2k40npad2hv:5432/postgres` — ⚠️ nunca commitear la contraseña real |
| `JWT_SECRET` | `openssl rand -hex 32` |
| `JWT_REFRESH_SECRET` | `openssl rand -hex 32` (distinto al anterior) |
| `PLANT_TIMEZONE` | `America/Los_Angeles` (la zona operativa real vive en cada organización/planta) |
| `FACE_PROVIDER` | `review_only` para el arranque seguro; `aws_rekognition` sólo habilita comparación 1:1 y no equivale a prueba de vida |
| `VAPID_SUBJECT` / `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | (opcional) las tres salidas de una identidad generada con `npx web-push generate-vapid-keys`; dejar las tres ausentes desactiva sólo Web Push |
| `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` | (opcional) credenciales del admin que crea el seed; si no, usa `admin@nodo.local / admin1234` — **cambiar** |

### Fotos

Producción exige almacenamiento S3-compatible duradero. Para Cloudflare R2
define `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`,
`S3_SECRET_ACCESS_KEY`, `S3_REGION=auto`. El disco local sólo está permitido en
desarrollo y pruebas.

Web Push requiere HTTPS y las tres variables `VAPID_*`. La bandeja dentro de
la aplicación funciona aunque Web Push esté desactivado. Después del deploy,
activa los avisos desde un gesto explícito en la campana y valida entrega en
los teléfonos reales del admin y los foremen.

## 3. Primer deploy

1. **Deploy.** El contenedor ejecuta migraciones + seed + server en cada arranque. Verificar en logs `NODO CLOCK-IN server escuchando en :3001`.
2. Entrar con el admin (`admin@nodo.local / admin1234` si no definiste `SEED_ADMIN_*`), **cambiar la contraseña** y validar las tres plantas y el turno 05:00–13:30.

## Notas

- `render.yaml` queda solo como referencia del deploy anterior en Render; Coolify no lo usa.
- El servidor confía en un salto de proxy (`trust proxy = 1` en `app.ts`), necesario para el rate limiting detrás del Traefik de Coolify.
- Migraciones corren en cada arranque; son incrementales y seguras de repetir.
