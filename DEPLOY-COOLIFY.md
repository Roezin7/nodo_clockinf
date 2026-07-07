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
| `KIOSK_DEVICE_TOKEN` | `openssl rand -hex 32` — se configura igual en el kiosco |
| `PLANT_TIMEZONE` | `America/Mexico_City` (la zona operativa real vive en `settings.timezone`, editable en Configuración) |
| `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` | (opcional) credenciales del admin que crea el seed; si no, usa `admin@nodo.local / admin1234` — **cambiar** |

### Fotos (elegir una)

- **Cloudflare R2 (recomendado en producción):** definir `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_REGION=auto`.
- **Disco local del servidor:** no definir ninguna `S3_*` y agregar en Coolify un **volumen persistente** montado en `/app/server/uploads-local` (sin volumen, las fotos se pierden en cada redeploy).

## 3. Primer deploy

1. **Deploy.** El contenedor ejecuta migraciones + seed + server en cada arranque (el seed es idempotente: crea áreas, turnos placeholder, settings y el admin solo si faltan). Verificar en logs `NODO CLOCK-IN server escuchando en :3001`.
2. Entrar con el admin (`admin@nodo.local / admin1234` si no definiste `SEED_ADMIN_*`), **cambiar la contraseña**, ajustar horarios de turnos y zona horaria en Configuración.

## Notas

- `render.yaml` queda solo como referencia del deploy anterior en Render; Coolify no lo usa.
- El servidor confía en un salto de proxy (`trust proxy = 1` en `app.ts`), necesario para el rate limiting detrás del Traefik de Coolify.
- Migraciones corren en cada arranque; son incrementales y seguras de repetir.
