# Propuestas comerciales de NODO Clock-In

Cada propuesta se publica en `/proposal/:clientSlug`. El contenido comercial
es público para quien tenga el enlace; no requiere contraseña, sesión ni cookie.
La demo usa únicamente personas ficticias y estado local del navegador.

## Crear una propuesta

1. Duplica una entrada en `server/src/proposals/registry.ts`.
2. Cambia `slug`, versión, cliente, alcance, contacto, fechas, mensaje, notas y
   datos de Leader Solutions.
3. Incrementa la versión cuando cambien alcance, precios o vigencia.
4. Ejecuta `npm run lint && npm run typecheck && npm run build && npm test`.
5. Publica y abre `https://tu-dominio/proposal/<slug>`.

No agregues datos personales de empleados, URLs internas, tokens, fotografías,
credenciales ni secretos. La configuración se entrega desde
`GET /api/proposals/:slug`; la página no llama APIs de asistencia, identidad,
dashboard o reportes.

## Coolify

- Build Pack: `Dockerfile` raíz.
- Puerto: `3001`.
- Health check: `/api/health`.
- Las migraciones se ejecutan al arrancar.
- No se requiere una variable especial para propuestas.

La opción “Imprimir / guardar PDF” usa la misma configuración y fórmulas que la
pantalla para evitar precios inconsistentes.
