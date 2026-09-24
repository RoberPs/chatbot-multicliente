# Contrato: panel web de administración

**Feature**: `001-business-knowledge-base` | Fuente: FR-001 – FR-032, en especial FR-023 y FR-023a

Panel renderizado en servidor ([research R2](../research.md#r2-tipo-de-proyecto-y-panel-web-de-administración)).
Las rutas devuelven HTML. Los formularios se envían con htmx; sin JavaScript funcionan como
formularios normales (POST + redirección).

## Reglas comunes

- **Autenticación**: todas las rutas bajo `/admin` exigen sesión del operador. Sin sesión:
  `302 → /admin/login` (o `401` con cabecera `HX-Redirect` si la petición es htmx). No existe
  ninguna ruta ni rol para el negocio (FR-023).
- **CSRF**: todo `POST` lleva token; sin token válido, `403`.
- **Método**: los formularios HTML usan `POST`. Las eliminaciones son `POST …/delete` con
  confirmación en la interfaz.
- **Validación** (FR-023a): al guardar se validan los datos con los esquemas del dominio.
  - Éxito: `303 → página del recurso` con mensaje "Guardado" (htmx: `200` con el fragmento
    actualizado y la lista de avisos refrescada).
  - Dato inválido: `422` con el mismo formulario, los valores introducidos y el error junto a
    cada campo afectado. No se guarda nada.
  - Cambio que dejaría un negocio activo con aviso crítico (FR-032): `409` con el formulario,
    un error general que explica el motivo y el aviso que lo provocaría. No se guarda nada.
- **Avisos**: todas las páginas muestran un contador de avisos en la cabecera; la portada del
  panel muestra la lista completa ([warnings.md](warnings.md)). Guardar con avisos `normal`
  siempre es posible (FR-027).
- **Atomicidad**: cada guardado es una transacción; o se guarda todo el formulario o nada.

## Rutas

### Sesión

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/admin/login` | Formulario de acceso |
| POST | `/admin/login` | Usuario + contraseña. Error genérico si fallan. Limitado por IP |
| POST | `/admin/logout` | Cierra la sesión |

### Portada y estado (FR-029 – FR-031)

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/admin` | Estado del negocio, lista de avisos y accesos a cada sección |
| POST | `/admin/status/activate` | `draft → active`. Con avisos críticos: `409` y lista de avisos que bloquean |
| POST | `/admin/status/deactivate` | `active → draft` |

### Datos del negocio (FR-001, FR-002)

| Método | Ruta | Campos |
|--------|------|--------|
| GET | `/admin/business` | |
| POST | `/admin/business` | `name`*, `address`, `directions`, `phone`, `email`, `timezone`*, `currency`* |

### Horario y cierres (FR-003 – FR-006)

| Método | Ruta | Campos |
|--------|------|--------|
| GET | `/admin/hours` | Semana completa y lista de cierres |
| POST | `/admin/hours` | `slots[i].weekday`, `slots[i].start`, `slots[i].end` — reemplaza toda la semana |
| POST | `/admin/closures` | `start_date`*, `end_date`*, `start_time`, `end_time`, `reason` |
| POST | `/admin/closures/:id` | Igual que el alta |
| POST | `/admin/closures/:id/delete` | |

### Servicios (FR-007 – FR-009, FR-011b)

| Método | Ruta | Campos |
|--------|------|--------|
| GET | `/admin/services` | Lista con estado, precio, duración, reservable y avisos por servicio |
| GET | `/admin/services/new` · `/admin/services/:id` | Formulario |
| POST | `/admin/services` | `name`*, `description`, `price_type`*, `price` (decimal en la moneda del negocio), `duration` (minutos), `bookable`, `active` |
| POST | `/admin/services/:id` | Igual que el alta |
| POST | `/admin/services/:id/delete` | Borra el servicio y sus asociaciones con recursos |
| POST | `/admin/services/reorder` | `ids[]` en el nuevo orden |

### Recursos (FR-010 – FR-013)

| Método | Ruta | Campos |
|--------|------|--------|
| GET | `/admin/resources` | Lista con estado y servicios asignados |
| GET | `/admin/resources/new` · `/admin/resources/:id` | Formulario con horario y ausencias |
| POST | `/admin/resources` | `name`*, `service_ids[]`, `active` |
| POST | `/admin/resources/:id` | Igual que el alta |
| POST | `/admin/resources/:id/hours` | `slots[i]…` — reemplaza el horario del recurso |
| POST | `/admin/resources/:id/absences` | Igual que un cierre, sin `reason` |
| POST | `/admin/resources/:id/absences/:absenceId` | |
| POST | `/admin/resources/:id/absences/:absenceId/delete` | |
| POST | `/admin/resources/:id/delete` | Borra el recurso, sus asociaciones, horario y ausencias |

### Preguntas frecuentes (FR-014)

| Método | Ruta | Campos |
|--------|------|--------|
| GET | `/admin/faqs` | |
| POST | `/admin/faqs` | `question`*, `answer`* |
| POST | `/admin/faqs/:id` | |
| POST | `/admin/faqs/:id/delete` | |
| POST | `/admin/faqs/reorder` | `ids[]` |

### Políticas, tono y derivación (FR-015 – FR-019)

| Método | Ruta | Campos |
|--------|------|--------|
| GET/POST | `/admin/policies` | `cancellation_text`, `cancellation_notice` + `_unit`, `min_advance` + `_unit`, `max_advance` + `_unit` (`minutes`/`hours`/`days`), `payment_methods[]` |
| GET/POST | `/admin/tone` | `address_form`* (`informal`/`formal`), `style_description` |
| GET/POST | `/admin/handoff` | `channels[i].type`, `channels[i].value`, `slots[i]…`. Sin medios = se elimina el contacto y se usa el teléfono del negocio (FR-019) |

`*` = obligatorio.

## Casos de contrato a cubrir con tests

| Caso | Esperado |
|------|----------|
| Cualquier ruta `/admin/*` sin sesión | `302 → /admin/login` |
| `POST` sin token CSRF | `403` |
| Franja 14:00–09:00 | `422`, error en `slots[i].end` |
| Precio `-5` | `422`, error en `price` |
| Email `foo@` | `422`, error en `email` |
| Antelación mínima 3 días, máxima 2 días | `422`, error en `min_advance` |
| Servicio reservable sin duración | `303`, guardado, aparece `SERVICE_DURATION_MISSING` |
| Activar con `HANDOFF_UNREACHABLE` | `409`, estado sigue `draft` |
| Negocio activo sin contacto de derivación: borrar el teléfono | `409`, teléfono intacto |
| Negocio activo: borrar el último medio de derivación con teléfono presente | `303`, aparece `HANDOFF_CONTACT_MISSING` |
