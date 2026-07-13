# Phase 10 — aceptación, piloto y salida a producción

ClockAI sustituye sólo la captura, revisión y entrega de **horas**. No ejecuta
nómina, impuestos, depósitos ni decide la clasificación laboral. La semana es
domingo–sábado; la contadora recibe el cierre listo a más tardar el domingo y
puede entrar al portal de solo lectura para revisar los detalles.

## Criterio de salida

No se corta ADP hasta que un administrador, el foreman responsable y la
contadora firmen esta lista. Cada resultado se anota con fecha, planta,
dispositivo, operador y evidencia (ID de auditoría o captura). Un fallo crítico
detiene el corte y se conserva ADP como referencia durante el piloto.

| Prueba en las 3 plantas | Resultado que debe aprobarse |
|---|---|
| Inicio de turno 05:00 con 50–80 personas | Las checadas se confirman sin duplicados; el dashboard muestra por planta quién está dentro y quién requiere atención. |
| Entrada, salida a lunch, regreso automático a las 09:30 y salida 13:30 | La secuencia y el descanso se derivan correctamente; cualquier desviación se vuelve excepción visible. |
| Empleado que cambia de planta en días distintos | La hora queda atribuida a la planta de su dispositivo sin que el empleado pueda escoger otra. |
| Wi‑Fi cortado, reinicio de tablet y reconexión | La fila cifrada sigue presente, se sincroniza en orden y el reintento no crea una segunda checada. |
| Tres intentos faciales fallidos/cámara no disponible | La checada **no se pierde**: se toma evidencia, queda alerta de identidad y un humano la revisa. No se promete prueba de vida hasta integrar y validar un proveedor específico. |
| Corrección del foreman | Sólo sus plantas, motivo obligatorio, antes/después, autor y fecha en auditoría; no se reescribe la checada original. |
| Horas y reglas CA | Casos de más de 8/12 horas diarias, más de 40 semanales y séptimo día consecutivo se comparan contra cálculo manual aprobado por asesor laboral. Las “horas-bono” siguen siendo horas y se ven separadas por la contadora. |
| Cierre sábado y reporte domingo | No se finaliza con eventos pendientes, dispositivo sin sincronizar o revisiones bloqueantes salvo override documentado de admin. El XLSX/CSV final conserva hash y versiones. |
| Accesos | Contadora: nombres, horas y exportes finales; foreman: correcciones con motivo; admin: configuración y costos. Intentar cada permiso ajeno devuelve 403/oculta la ruta. |
| Recuperación | Restaurar una copia de Postgres en entorno aislado, verificar checksum y abrir un reporte final conocido. |

Las pruebas automatizadas actuales cubren cálculos CA, cierre, sincronización,
identidad, permisos, reportes, dashboard, seguridad y privacidad. La prueba de
campo anterior no puede simular la iluminación, cámaras y Wi‑Fi de las tres
plantas: por eso esta matriz es una puerta operativa obligatoria, no una
afirmación de que una prueba de escritorio la reemplaza.

## Plan de transición

1. **Dos semanas antes.** Inventariar empleados activos, tasas por hora, tres
   plantas, usuarios y dispositivos. Crear un dispositivo nominal por planta,
   instalar tablet, base cerrada, alimentación continua y red Wi‑Fi. Importar
   datos, pero nunca contraseñas ni fotos desde ADP sin autorización escrita.
2. **Semana piloto.** ClockAI y ADP corren en paralelo. Cada día el admin
   compara empleados, entrada/salida, horas regulares, 1.5x y 2x; investiga la
   diferencia antes de las 14:30. La contadora compara el total semanal y el
   archivo final con su cálculo independiente.
3. **Domingo de corte.** Respaldar ADP y ClockAI, congelar catálogos/tasas,
   confirmar que el reporte sábado está finalizado y que los tres kioscos están
   saludables. El admin activa ClockAI como registro primario y conserva ADP
   en lectura por el periodo contractual necesario.
4. **Primeras cuatro semanas.** Reunión de 15 minutos diaria durante la
   primera semana y revisión cada domingo. Métricas: filas offline, checadas
   manuales, alertas faciales, excepciones no resueltas, horas corregidas y
   tiempo de preparación de la contadora.

## Runbook del operador

- A las 04:45, cada foreman confirma energía, cámara, conexión y etiqueta de
  planta del kiosco; no comparte códigos de enrolamiento ni tokens.
- Si la tablet se traba, el empleado vuelve a intentar una vez; si sigue
  fallando, la evidencia y la checada se capturan en el flujo de contingencia
  del kiosco y el foreman abre excepción. No se manda una lista informal por
  WhatsApp.
- Si falla internet, seguir checando. No borrar datos del navegador ni cambiar
  de dispositivo; al volver la red, comprobar que la cola quede en cero.
- El foreman corrige desde el sistema y explica el motivo. Un “bono” solicitado
  como horas se agrega como ajuste de horas con motivo; la contadora lo ve
  separado y decide el pago, no ClockAI.
- El domingo el admin resuelve primero alertas de identidad, eventos offline y
  correcciones; luego genera/finaliza el reporte. La contadora revisa y exporta
  directamente, sin intermediario en México.

## Despliegue y recuperación

Antes de publicar, ejecutar build, pruebas, migraciones en una base nueva y
`docker build`. Después de publicar, desde una red autorizada ejecutar:

```bash
scripts/release-smoke.sh https://tu-dominio
```

El endpoint de disponibilidad comprueba Postgres y almacenamiento de fotos;
el de vida sólo confirma que el proceso está arriba. Hacer respaldo diario con
`scripts/backup-postgres.sh`, retener copias cifradas fuera del servidor y
practicar mensualmente `scripts/restore-verify.sh` en una base vacía. En un
incidente: pausar cambios de horas, preservar auditoría y logs, restaurar sólo
en un entorno aislado para validar, y documentar el momento de vuelta a
operación.

## Límites legales que requieren validación humana

La operación parece encajar en la Wage Order 8 por manejo de producto después
de cosecha, pero el empleador y abogado laboral deben confirmar clasificación,
exenciones, descansos y la regla exacta aplicable antes del corte. California
generalmente usa overtime diario (más de 8/12) y semanal (más de 40), no la
política anterior de 40/60 solicitada inicialmente. El sistema mantiene el
cálculo California configurado; el abogado debe aprobar casos reales y las
horas-bono, pues una compensación no discrecional puede afectar la tasa regular.

Antes de enrolar caras, entregar aviso de privacidad bilingüe, definir finalidad,
retención, controles de acceso, proveedor y proceso de solicitud/borrado;
obtener la revisión de counsel sobre CCPA/CPRA y la regulación de biometría
aplicable. Esta documentación es operativa, no asesoría legal.
