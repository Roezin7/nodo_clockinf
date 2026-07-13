# Fase 8 — dashboard operativo, costos directos y tasas efectivas

## Resultado

La fase 8 agrega dos vistas deliberadamente separadas:

- una vista operativa para `admin` y `foreman`, sin tasas, costos ni evidencia biométrica;
- una vista financiera para `admin`, con horas clasificadas y costo directo estimado.

El dashboard no calcula nómina ni sustituye la decisión de pago de la contadora. El costo mostrado es únicamente salario directo estimado. Excluye impuestos, cargas patronales, beneficios, primas no modeladas y cualquier otro costo laboral indirecto.

La semana sigue el contrato operativo de California: domingo a sábado y zona `America/Los_Angeles`.

## Autorización y minimización de datos

| Recurso | Admin | Foreman | Accountant |
| --- | --- | --- | --- |
| `GET /api/dashboard/operations` | Todas las plantas del tenant | Solo plantas asignadas | Denegado |
| `GET /api/dashboard/admin/current-week` | Permitido | Denegado | Denegado |
| `GET /api/dashboard/admin/trends` | Permitido | Denegado | Denegado |
| Historial/cambio de tasas | Permitido | Denegado | Denegado |

Todas las consultas se limitan por `organization_id`. El foreman se limita además por la relación exacta `user_plant_access`.

La respuesta operativa nunca contiene:

- tasa o costo;
- SSN, teléfono, PIN o datos de pago;
- foto, clave de objeto, puntaje facial o evidencia biométrica;
- texto libre de una excepción, razón de corrección o razón de revisión.

Una excepción vinculada a varias plantas solo aparece a un foreman que tenga acceso a todas las plantas involucradas. El total de la organización cuenta la excepción una sola vez aunque esté vinculada a más de una planta.

Todas las respuestas del dashboard usan `Cache-Control: private, no-store`.

## Dashboard operativo

`GET /api/dashboard/operations` devuelve por planta:

- empleados realmente dentro y en lonche, basados en la última checada no anulada de cada empleado/planta;
- secuencias abiertas obsoletas separadas después de 16 horas o cuando el empleado está inactivo;
- revisiones de identidad abiertas;
- conteos de excepciones abiertas/acknowledged por severidad;
- estado mínimo de los checadores.

La búsqueda de la última checada no tiene un corte temporal artificial. Una entrada antigua sin salida permanece visible en `stale_open`; no se contabiliza como “adentro ahora” ni desaparece después de 24 horas. La misma separación se aplica a una secuencia abierta de un empleado ya inactivo.

`sync_status` es uno de:

- `healthy`: activo, con comunicación y sin señales de atención;
- `attention`: activo, comunicado, pero con cola, rechazo, cámara, almacenamiento o reloj que requiere atención;
- `offline`: revocado/inactivo o heartbeat de más de 24 horas;
- `unknown`: activo, sin heartbeat ni sincronización observados.

Los flags son códigos cerrados (`queue_pending`, `events_rejected`, `heartbeat_missing`, `heartbeat_stale`, `storage_attention`, `camera_attention`, `clock_skew`). No incluyen `last_error` ni otro texto potencialmente sensible.

El inventario puede mostrar un registro revocado para explicar que el checador ya no está activo, pero solo dispositivos `active`, enrolados y con flags incrementan `devices_attention`. Un dispositivo revocado o nunca enrolado no crea una falsa alarma operativa ni bloquea por sí solo este total.

## Costo directo exacto

El flujo de cálculo es:

1. Los pares de checadas cerrados se convierten en segundos trabajados, descontando lonches.
2. Las horas manuales activas se agregan como tiempo trabajado al final de la fecha seleccionada.
3. El clasificador único de California asigna cada segundo a `regular`, `overtime_1_5` o `double_time` sin pyramiding.
4. Se elige la tasa cuyo intervalo efectivo cubre la fecha de trabajo.
5. El costo se acumula con enteros y `BigInt`; no se usa aritmética binaria de punto flotante para dinero.

La tasa vive en PostgreSQL como `numeric(12,4)`. Internamente se transforma en unidades de 1/10000 de dólar. Los multiplicadores son exactamente 1, 3/2 y 2, con denominador común 7200 al multiplicar segundos. Solo se redondea al publicar, a cuatro decimales y half-up.

Una tasa ausente nunca se interpreta como cero. Cada métrica informa:

- `seconds.costed` y `seconds.uncosted`;
- `coverage_ratio`;
- `direct_cost_costed`, que suma solo los segundos cubiertos;
- `direct_cost_complete`, que es `null` cuando falta al menos una tasa;
- `missing_rates`, con empleado, fechas afectadas y segundos sin costear.

### Invariantes de publicación

En cada semana, y también bajo empates de medio 1/10000 de dólar:

```text
organization.direct_cost_costed
  = sum(organization.direct_cost_by_bucket_costed)
  = sum(plants[*].direct_cost_costed)

plant.direct_cost_costed
  = sum(plant.direct_cost_by_bucket_costed)
```

Primero se redondea el total exacto de organización. El residuo mínimo entre ese total y los buckets redondeados se asigna en orden estable. Después se reconcilia cada bucket entre plantas y el total de cada planta se deriva de sus buckets. Esta regla evita diferencias visuales de 0.0001 sin cambiar segundos, tasa ni clasificación.

El snapshot administrativo conserva además hechos auditables agrupados por empleado, fecha, planta, origen y bucket: tasa decimal, segundos y costo derivado. La tasa, los segundos y el bucket son la evidencia recomputable; el total publicado y sus buckets reconciliados son los importes contables autoritativos de esa versión.

## Semana actual y proyección

`GET /api/dashboard/admin/current-week` incluye:

- horas/costos reales de la organización y por planta;
- cobertura y tasas faltantes explícitas;
- umbrales diarios 7–8, 8–<11, 11–12, 12+ y semanales 36–40, 40+;
- comparación contra la semana anterior;
- relación entre segundos manuales y de reloj;
- hasta 20 cambios manuales recientes con actor y razón;
- una proyección conservadora de jornadas todavía abiertas.

La proyección agrega solamente el tiempo transcurrido de una secuencia abierta, se divide por medianoche civil de Los Ángeles y se limita a 16 horas desde `shift_in`. Cada secuencia tiene una clave estable, por lo que cruzar medianoche no duplica `synthetic_open_sequences` ni `capped_open_sequences`.

La proyección siempre declara:

```json
{
  "method": "actual_plus_open_elapsed_capped_16h",
  "synthetic": true,
  "payable": false
}
```

Los fragmentos sintéticos no se guardan, no alteran checadas, no crean horas manuales y nunca forman parte del reporte pagable. Sirven solo para anticipar exposición a OT/DT y costo.

## Comparaciones y tendencias históricas

`GET /api/dashboard/admin/trends` acepta:

- `grain=week|month`;
- `from` y `to` como fechas ISO;
- `limit` entre 1 y 104;
- `cursor` para paginación descendente.

El rango máximo es 730 días. Los datos del rango se cargan en consultas batch; no existe una consulta por empleado o por semana. En grano mensual se agrupan semanas por su `week_start`, indicado explícitamente por `source=classified_weeks_grouped_by_week_start`.

El origen histórico es visible:

- `live`: periodo abierto/reabierto, calculado de las fuentes actuales;
- `frozen_report_version`: periodo final con snapshot administrativo inmutable;
- `legacy_report_without_cost_snapshot`: versión anterior a fase 8; conserva sus horas históricas, pero el costo aparece como no disponible y nunca se recalcula con una tasa actual.

La comparación de semana actual contra la anterior aplica la misma regla. Si la semana anterior es final, usa su snapshot congelado; una modificación posterior de datos o tasas no reescribe la comparación.

## Snapshot administrativo al cerrar

Cada nueva finalización crea, en la misma transacción que `report_versions`:

- un `report_cost_snapshots` con `schema_version=1`;
- contrato `clockai-admin-direct-cost-v1`;
- periodo, zona, versión y fecha de creación;
- métricas, plantas, tasas faltantes, umbrales y hechos de tasa;
- hash SHA-256 sobre JSON canónico.

El snapshot de costo es administrativo y no se incorpora al contrato mínimo de la contadora. `report_cost_snapshots` no permite `UPDATE` ni `DELETE`. Los `audit_events` también pasan a ser append-only.

Los reportes legacy no se rellenan retroactivamente. Marcar costo histórico como no disponible es preferible a inventarlo con una tasa que no estaba congelada cuando se cerró la semana.

## Tasas efectivas

La creación opcional de un empleado acepta el par completo:

```json
{
  "hourly_rate": "20.1250",
  "rate_effective_from": "2026-01-01"
}
```

Ambos campos se envían juntos y la tasa debe ser string decimal con máximo cuatro posiciones. Empleado, tasa inicial y auditoría se guardan atómicamente.

Endpoints administrativos:

- `GET /api/employees/:id/rates`;
- `POST /api/employees/:id/rates/change` con `hourly_rate`, `effective_from` y `reason`;
- el antiguo `POST /api/employees/:id/rates` devuelve `410 RATE_ENDPOINT_RETIRED`.

El cambio serializa solicitudes concurrentes, cierra el intervalo vigente, preserva razones y before/after auditables y rechaza solapamientos. Un admin puede rellenar un hueco histórico con fecha y motivo explícitos para resolver horas sin tasa. La API calcula la vigencia propuesta hasta la siguiente tasa (o sin fin) y la rechaza si cualquier parte intersecta un periodo `ready_for_review` o `final`; no basta con que la fecha inicial esté en una semana reabierta.

## Migración

`1751900000000_dashboard-costs.sql` agrega:

- razón y límites explícitos a `employee_rates`;
- FK exacta `(created_by, organization_id)`;
- inmutabilidad de `audit_events`;
- `report_cost_snapshots` con FK exacta al tenant, hash y triggers de inmutabilidad.

La migración tiene `UP` y `DOWN` verificados sobre una base limpia.

## Cobertura de pruebas

Las pruebas puras cubren:

- regular, OT 1.5 y DT 2;
- regla semanal de 40 horas y séptimo día consecutivo;
- cambio de tasa a mitad de semana;
- empleado multi-planta y horas manuales;
- tasa ausente y cobertura;
- aritmética decimal exacta;
- reconciliación adversarial total/buckets/plantas;
- proyección nocturna, división por medianoche y límite de 16 horas;
- conteo único de una secuencia sintética con varios fragmentos.

La integración PostgreSQL/API cubre:

- RBAC de admin, foreman y accountant;
- aislamiento entre tenants y scope exacto por planta;
- no fuga de tasas, costo, SSN, evidencia ni razones en operaciones;
- última checada antigua sin cutoff semántico;
- excepción multi-planta sin fuga ni doble conteo;
- estados de checador y exclusión de revocados en alertas;
- costo actual, planta, manual, tasa faltante y proyección;
- snapshot final, hash, hechos de tasa e inmutabilidad;
- comparación anterior y tendencias congeladas aun después de alterar la fuente histórica;
- legacy explícitamente no costeable;
- límites y cursor de tendencias.
