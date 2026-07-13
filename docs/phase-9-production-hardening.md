# Fase 9 — seguridad y operación de producción

## Sesiones y accesos

- El access token contiene `session_version`; `requireAuth` consulta al usuario activo y su organización en cada petición. Una desactivación, cambio de rol o contraseña invalida el token inmediatamente.
- El refresh token es opaco, de un solo uso, hasheado y rotado dentro de una transacción con bloqueo de fila. Solo viaja en cookie `HttpOnly`, `SameSite=Strict`, con `Secure` en producción. El cliente conserva solamente el access token en memoria; `sessionStorage` contiene solo el perfil mínimo para reanudar la cookie al recargar.
- `POST /api/auth/change-password` exige contraseña actual, mínimo 12 caracteres, incrementa `session_version`, revoca todas las sesiones y registra auditoría. La pantalla **Mi cuenta** está disponible para admin, foreman y contadora.
- El bootstrap ya no crea `admin@nodo.local` ni ninguna contraseña por omisión. Se ejecuta una única vez con `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD` y, en producción, `ALLOW_PRODUCTION_BOOTSTRAP=yes`.

## Privacidad y navegador

- SSN se cifra con AES-256-GCM mediante `PII_ENCRYPTION_KEY`; las lecturas conservan compatibilidad temporal con valores legacy y `node dist/scripts/encryptPii.js` los cifra antes del arranque. Nunca se devuelve una clave interna de foto.
- Respuestas de empleados usan `private, no-store`.
- Helmet activa CSP, `frame-ancestors 'none'`, `nosniff`, referrer policy y cabecera `X-Request-Id`. `CORS_ORIGINS` solo permite orígenes explícitos; el API se sirve normalmente desde el mismo origen.
- Los POST de autenticación rechazan un `Origin` externo. Esto complementa la cookie SameSite y el bearer token en memoria.

## Disponibilidad y operación

- `GET /api/health/live` confirma proceso vivo; `GET /api/health` verifica PostgreSQL y el bucket de fotos. El health check del contenedor usa el segundo.
- El servidor apaga timers, deja de aceptar conexiones y cierra el pool al recibir `SIGTERM`/`SIGINT`. Retención de fotos usa advisory lock de PostgreSQL; los otros workers ya usan locks/`SKIP LOCKED` en sus colas.
- Docker corre como usuario `node`, no ejecuta seed y usa `exec` para recibir señales correctamente.
- GitHub Actions ejecuta migraciones, build y las pruebas de integración contra PostgreSQL 16 en cada push/PR.

## Respaldo y restauración

1. Programar `scripts/backup-postgres.sh` diariamente desde un job con `DATABASE_URL`, almacenando el `.dump` y su `.sha256` fuera del host de aplicación.
2. Retener al menos 35 copias diarias y una copia mensual fuera de la cuenta operativa.
3. Cada mes restaurar en una base aislada con `scripts/restore-verify.sh`; exige `RESTORE_VERIFY_DATABASE_URL` y `ALLOW_RESTORE_VERIFY=yes` para evitar restauraciones accidentales.
4. Registrar fecha, hash, duración, conteo de `pgmigrations` y `organizations`. Un backup no se considera válido hasta completar esa restauración.

## Variables obligatorias en producción

`DATABASE_URL`, `JWT_SECRET`, `JWT_REFRESH_SECRET`, `PII_ENCRYPTION_KEY` y almacenamiento S3/R2. Los dos secretos JWT deben ser distintos y de al menos 32 caracteres; la clave PII debe codificar exactamente 32 bytes (hex de 64 caracteres o base64 de 32 bytes).

## Pruebas de fase

La integración comprueba cookie HttpOnly/Strict, rotación concurrente, invalidación instantánea por `session_version`, cambio de contraseña y cifrado de SSN. La migración `1751910000000_production-security.sql` se prueba en UP/DOWN junto con el resto del esquema.
