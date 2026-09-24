# Data Model: Base de conocimiento del negocio

**Feature**: `001-business-knowledge-base` | **Fecha**: 2026-09-24 | **Plan**: [plan.md](plan.md)

Una base de datos PostgreSQL por instancia ([research.md R3](research.md#r3-almacenamiento-y-aislamiento-entre-instancias)),
así que ninguna tabla lleva `tenant_id`: todo lo que hay en la BD pertenece al único negocio
de la instancia. Nombres de tablas y columnas en inglés (código); los conceptos en español
siguen la spec.

Convenciones comunes a todas las tablas:

- `id`: `uuid` generado (`gen_random_uuid()`), salvo las tablas singleton (ver abajo).
- `updated_at`: `timestamptz`, se actualiza en cada modificación (supuesto "fecha de última
  modificación de cada elemento"). No hay historial de versiones.
- Textos libres: `text`, sin espacios al inicio/fin; los obligatorios no pueden quedar vacíos.
- Horas: `time` con precisión de minutos (`HH:MM`), hora local de pared en la zona del negocio.
- Fechas: `date`, rangos inclusivos.

## Diagrama de relaciones

```text
business (1, singleton)
 ├── business_hours           (0..n franjas semanales)
 ├── closure                  (0..n cierres puntuales)
 ├── service                  (0..n)
 │     └──< resource_service >──┐   (n:m, sin precio ni duración propios)
 ├── resource                 (0..n)
 │     ├── resource_hours     (0..n franjas semanales)
 │     └── resource_absence   (0..n ausencias)
 ├── faq                      (0..n)
 ├── policies                 (0..1, singleton)
 ├── tone                     (0..1, singleton)
 └── handoff_contact          (0..1, singleton)
       ├── handoff_channel    (1..n medios, si existe el contacto)
       └── handoff_hours      (0..n franjas semanales)

Warning: calculado, no persistido.
```

---

## Entidades

### business (Negocio) — singleton

Una sola fila por instancia (`id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1)`), creada por
la migración inicial con `status = 'draft'`.

| Campo | Tipo | Req. | Reglas |
|-------|------|------|--------|
| name | text | Sí* | 1–200 caracteres |
| address | text | No | ≤ 500 |
| directions | text | No | Indicaciones para llegar, ≤ 2000 |
| phone | text | No | E.164 normalizado (FR-002) |
| email | text | No | Email válido, en minúsculas (FR-002) |
| timezone | text | Sí | IANA válida; por defecto `Europe/Madrid` (configurable por instancia) |
| currency | char(3) | Sí | ISO 4217; por defecto `EUR` |
| status | enum `draft` \| `active` | Sí | Inicial `draft` ("en preparación") (FR-029) |
| updated_at | timestamptz | Sí | |

\* `name` puede estar vacío mientras la instancia se prepara (fila creada por la migración); el
formulario lo exige al guardar.

**Transiciones de estado** (FR-029 – FR-032):

```text
            activate (solo operador, sin avisos críticos)
  draft ─────────────────────────────────────────────▶ active
    ▲                                                     │
    └──────────────── deactivate (solo operador) ─────────┘
```

- `draft → active`: se rechaza si `computeWarnings` devuelve algún aviso `critical`; la
  respuesta enumera los avisos que bloquean (FR-031). Los avisos `normal` no bloquean.
- `active → draft`: siempre permitido.
- Mientras `status = active`, cualquier escritura cuyo estado resultante tenga un aviso
  crítico se revierte (FR-032, [research R6](research.md#r6-bloqueo-de-cambios-que-dejan-un-negocio-activo-sin-salida-a-una-persona-fr-032)).
- El bot solo atiende a clientes finales con `status = active` (el snapshot expone el estado).

### business_hours (Horario de apertura)

| Campo | Tipo | Req. | Reglas |
|-------|------|------|--------|
| id | uuid | Sí | |
| weekday | smallint | Sí | 1 (lunes) … 7 (domingo) |
| start_time | time | Sí | |
| end_time | time | Sí | `end_time > start_time` (FR-006) |
| updated_at | timestamptz | Sí | |

- Un día sin filas = cerrado ese día (FR-003).
- Las franjas de un mismo día no pueden solaparse (se rechazan; research R8).
- El formulario edita la semana completa y la guarda como reemplazo atómico de todas las filas.

### closure (Cierre puntual)

| Campo | Tipo | Req. | Reglas |
|-------|------|------|--------|
| id | uuid | Sí | |
| start_date | date | Sí | |
| end_date | date | Sí | `end_date >= start_date` (FR-006); igual para un solo día |
| start_time | time | No | Ambos o ninguno |
| end_time | time | No | Si hay horas: `end_time > start_time` |
| reason | text | No | ≤ 200 |
| updated_at | timestamptz | Sí | |

- Sin horas: cierre de día completo en cada fecha del rango. Con horas: el negocio no atiende
  en ese rango horario en cada fecha del rango (FR-004).
- Prevalece sobre `business_hours` (FR-005). Cierres solapados: se aplica su unión.

### service (Servicio)

| Campo | Tipo | Req. | Reglas |
|-------|------|------|--------|
| id | uuid | Sí | |
| name | text | Sí | 1–200; único entre servicios (sin distinguir mayúsculas) |
| description | text | No | ≤ 4000 |
| price_type | enum `fixed` \| `from` \| `on_request` | Sí | (FR-008) |
| price_cents | integer | No | `>= 0` (FR-008). Si `price_type = on_request` se fuerza a `NULL` al guardar |
| duration_minutes | integer | No | `> 0`, ≤ 1440 |
| bookable | boolean | Sí | Por defecto `false` |
| active | boolean | Sí | Por defecto `true` (FR-011b) |
| sort_order | integer | Sí | Orden de presentación |
| updated_at | timestamptz | Sí | |

- Precio fijo o "desde" sin importe **se permite guardar** y genera aviso `SERVICE_PRICE_MISSING`.
- Reservable sin duración **se permite guardar**, genera aviso `SERVICE_DURATION_MISSING`
  y el servicio no es *reservable efectivo* (FR-009).
- Borrar un servicio borra sus filas de `resource_service` (`ON DELETE CASCADE`).

**Derivado — reservable efectivo** (lo que el bot puede ofrecer para reserva):

```text
bookable_effective(s) =
    s.active AND s.bookable AND s.duration_minutes IS NOT NULL
    AND ( no hay ningún recurso registrado           -- agenda única (FR-013)
          OR existe un recurso activo que presta s )
```

"No hay ningún recurso registrado" cuenta recursos activos e inactivos: si todos están
inactivos, el negocio **no** pasa a agenda única (edge case de la spec).

### resource (Recurso)

| Campo | Tipo | Req. | Reglas |
|-------|------|------|--------|
| id | uuid | Sí | |
| name | text | Sí | 1–200; único entre recursos (sin distinguir mayúsculas) |
| active | boolean | Sí | Por defecto `true` (FR-011b) |
| sort_order | integer | Sí | |
| updated_at | timestamptz | Sí | |

- Borrar un recurso borra sus `resource_service`, `resource_hours` y `resource_absence`.
- Desactivarlo conserva todo; para el bot deja de existir.

### resource_service (Asociación recurso ↔ servicio)

| Campo | Tipo | Req. | Reglas |
|-------|------|------|--------|
| resource_id | uuid FK → resource | Sí | `ON DELETE CASCADE` |
| service_id | uuid FK → service | Sí | `ON DELETE CASCADE` |

- PK compuesta `(resource_id, service_id)`. **Sin columnas de precio ni duración** (FR-011a).
- Un recurso solo presta los servicios que tiene aquí (FR-011, SC-006).

### resource_hours (Horario del recurso)

Mismas columnas y reglas que `business_hours` más `resource_id` (FK, `ON DELETE CASCADE`).
Independiente del horario de otros recursos. Un recurso sin filas no atiende ningún día.

### resource_absence (Ausencia del recurso)

Mismas columnas y reglas que `closure` más `resource_id` (FK, `ON DELETE CASCADE`).
Prevalece sobre `resource_hours` (FR-012).

### faq (Pregunta frecuente)

| Campo | Tipo | Req. | Reglas |
|-------|------|------|--------|
| id | uuid | Sí | |
| question | text | Sí | 1–500 |
| answer | text | Sí | 1–4000 |
| sort_order | integer | Sí | |
| updated_at | timestamptz | Sí | |

Los datos estructurados prevalecen sobre el texto de las FAQ (FR-014a). No se detectan
contradicciones.

### policies (Políticas) — singleton

| Campo | Tipo | Req. | Reglas |
|-------|------|------|--------|
| id | smallint | Sí | `= 1` |
| cancellation_text | text | No | ≤ 4000 |
| cancellation_notice_minutes | integer | No | `>= 0`; plazo mínimo para cancelar sin penalización |
| min_advance_minutes | integer | No | `>= 0` |
| max_advance_minutes | integer | No | `> 0` |
| payment_methods | text[] | Sí | Lista de texto libre, sin duplicados; puede estar vacía |
| updated_at | timestamptz | Sí | |

- Si ambas antelaciones existen: `min_advance_minutes <= max_advance_minutes`; si no, se
  rechaza (FR-016).
- Formas de pago en texto libre (p. ej. "Efectivo", "Tarjeta", "Bizum") para no fijar una
  lista propia de un país o sector (FR-024).

### tone (Tono) — singleton

| Campo | Tipo | Req. | Reglas |
|-------|------|------|--------|
| id | smallint | Sí | `= 1` |
| address_form | enum `informal` \| `formal` | Sí | Tú / usted (FR-017) |
| style_description | text | No | ≤ 2000 |
| updated_at | timestamptz | Sí | |

### handoff_contact (Contacto de derivación) — singleton

| Campo | Tipo | Req. | Reglas |
|-------|------|------|--------|
| id | smallint | Sí | `= 1` |
| updated_at | timestamptz | Sí | |

### handoff_channel (Medio de derivación)

| Campo | Tipo | Req. | Reglas |
|-------|------|------|--------|
| id | uuid | Sí | |
| type | enum `phone` \| `whatsapp` \| `email` | Sí | |
| value | text | Sí | E.164 para `phone`/`whatsapp`; email válido para `email` |
| sort_order | integer | Sí | Orden de preferencia |

- Único por `(type, value)`. El contacto existe si tiene al menos un medio (FR-018); guardar
  el formulario sin medios elimina el contacto.

### handoff_hours (Horario de atención de la derivación)

Mismas columnas y reglas que `business_hours`. Opcional: sin filas significa que no se ha
indicado horario (no que no se atienda nunca).

**Derivado — contacto de derivación efectivo** (FR-018, FR-019):

```text
si existe handoff_contact con ≥ 1 medio → esos medios + handoff_hours (source = "configured")
si no, y business.phone existe          → [{ type: phone, value: business.phone }] (source = "business_phone")
si no                                   → ninguno  → aviso crítico HANDOFF_UNREACHABLE
```

---

## Warning (Aviso) — calculado

No se persiste; lo produce `computeWarnings(state)` ([research R5](research.md#r5-avisos-calculados-no-almacenados)).
Solo considera elementos activos (FR-011b).

| Campo | Tipo | Descripción |
|-------|------|-------------|
| code | string | Código estable del catálogo |
| severity | `normal` \| `critical` | |
| target | `{ kind, id?, label }` | Elemento afectado: `business`, `service`, `resource`, `handoff` (FR-026) |
| field | string? | Dato que falta o es incoherente |
| message | string | Texto para el operador |

Catálogo completo, condiciones y ejemplos: [contracts/warnings.md](contracts/warnings.md).

---

## Resumen de validaciones (rechazo al guardar)

| Regla | Requisito | Campo señalado |
|-------|-----------|----------------|
| Teléfono no parseable | FR-002 | `phone` / `channels[i].value` |
| Email mal formado | FR-002 | `email` / `channels[i].value` |
| Franja con fin ≤ inicio | FR-006 | `slots[i].end` |
| Franjas solapadas en el mismo día | research R8 | `slots[i]` |
| Cierre/ausencia con fecha fin < inicio | FR-006 | `end_date` |
| Cierre/ausencia parcial con fin ≤ inicio | FR-006 | `end_time` |
| Solo una de las dos horas en un cierre | FR-004 | `start_time` / `end_time` |
| Importe negativo | FR-008 | `price` |
| Duración ≤ 0 | FR-007 | `duration` |
| Nombre de servicio/recurso vacío o duplicado | FR-007, FR-010 | `name` |
| Asignar a un recurso un servicio inexistente | FR-011 | `service_ids` |
| Antelación mínima > máxima | FR-016 | `min_advance` |
| Zona horaria desconocida | Supuestos | `timezone` |
| Cambio que deja un negocio activo con aviso crítico | FR-032 | error general del formulario + aviso |

Lo que **no** se rechaza (solo genera aviso): servicio reservable sin duración, precio fijo o
"desde" sin importe, falta de horario, falta de contacto de derivación (salvo FR-032),
servicio reservable sin recurso, franja de recurso fuera del horario del negocio.
