# Propuestas comerciales privadas de NODO Clock-In

La experiencia vive en `/proposal/:clientSlug` dentro del mismo artefacto de
Vite/Express, pero está separada de las rutas autenticadas de Clock-In y de sus
datos operativos. La propuesta sólo llama a `/api/proposals/*`.

## Crear una propuesta

1. Duplica el objeto `empacadora-demo` en
   `server/src/proposals/registry.ts`.
2. Cambia `slug`, `version`, cliente, nombre comercial, alcance inicial,
   contacto, fechas, vigencia, mensaje, notas, logo opcional y contacto Nod3.
   El logo debe usar HTTPS o una ruta pública relativa. No pongas secretos en
   este objeto.
3. Genera un código largo y único en un gestor de contraseñas. Guarda sólo su
   SHA-256 en el entorno:

   ```bash
   printf %s 'codigo-largo-unico' | shasum -a 256
   ```

4. Agrega el hash a `PROPOSAL_ACCESS_CODES`, que es un objeto JSON de
   `slug -> hash`. No guardes el código en texto claro, ni el hash real, en Git.
5. Incrementa `version` cuando cambien alcance, precios, vigencia, términos o
   contenido material. Una aceptación conserva esa versión y la configuración
   aceptada.
6. Ejecuta `npm run build && npm test` y abre
   `http://localhost:5173/proposal/<slug>`.

Ejemplo estructural (hash ficticio, no utilizable):

```dotenv
PROPOSAL_ACCESS_CODES={"cliente-a":"<sha256-de-64-caracteres>"}
```

## Seguridad y aislamiento

- El código se compara mediante hash SHA-256 en tiempo constante.
- La sesión es un JWT firmado, dura ocho horas y viaja en cookie `HttpOnly`,
  `SameSite=Strict` y `Secure` en producción.
- La configuración se entrega únicamente después de validar esa sesión.
- La demo comercial usa nombres e identificadores ficticios, funciona en
  memoria y no llama a empleados, checadas, identidad, dashboard o reportes.
- Los mockups se rotulan como demostrativos y no reciben datos de PostgreSQL.
- Las aceptaciones viven en `proposal_acceptances`, tabla independiente e
  inmutable. Se guardan versión, configuración, precios recalculados por el
  servidor, fecha, sesión, consentimiento y solicitud de kickoff.
- No se guarda IP por defecto. Añadirla exige necesidad documentada, aviso de
  privacidad y revisión legal.
- La acción solicita contrato; no constituye cobro ni reemplaza el contrato.

## Desarrollo local

Configura las variables normales del servidor y el hash de la propuesta en
`server/.env`. Inicia PostgreSQL, aplica migraciones y ejecuta:

```bash
npm run migrate
npm run dev
```

La ruta de ejemplo es `/proposal/empacadora-demo`. La propuesta requiere API y
PostgreSQL sólo para guardar la aceptación; el acceso y la configuración pasan
por la API, por lo que tampoco se expone el registro en el bundle del cliente.

## Coolify

1. Despliega con el `Dockerfile` raíz, puerto `3001` y health check
   `/api/health`, igual que Clock-In.
2. Añade `PROPOSAL_ACCESS_CODES` como variable secreta sólo de runtime. En la
   interfaz de Coolify, evita mostrarla en logs de build.
3. Conserva `JWT_SECRET` estable: rotarlo cierra sesiones de propuesta activas.
4. El arranque aplica automáticamente la migración
   `1751930000000_proposal-acceptances.sql`.
5. Prueba acceso incorrecto/correcto, expiración, impresión, formulario y
   aceptación en un entorno staging antes de compartir el enlace.
6. Para dominio dedicado (`proposal.nod3.studio`), apunta el dominio al mismo
   servicio. La ruta canónica seguirá siendo `/proposal/:clientSlug`. Si se
   desea ocultar el prefijo mediante proxy, conserva internamente esa ruta y
   valida SPA fallback.

## Impresión y PDF

La opción “Imprimir / guardar PDF” usa la misma `ProposalConfig` y las mismas
fórmulas que la pantalla. CSS de impresión muestra portada, resumen, alcance,
capacidades, implementación, inversión, exclusiones, próximos pasos, contacto
y vigencia; no mantiene una segunda fuente de contenido o precios.
