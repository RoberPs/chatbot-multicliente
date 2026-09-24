# Quickstart: validar la base de conocimiento del negocio

**Feature**: `001-business-knowledge-base` | **Plan**: [plan.md](plan.md)

Guía para comprobar de principio a fin que la feature funciona. Las rutas y campos están en
[contracts/admin-panel.md](contracts/admin-panel.md), los avisos en
[contracts/warnings.md](contracts/warnings.md) y la vista del bot en
[contracts/knowledge-reader.md](contracts/knowledge-reader.md).

## Requisitos previos

- Node.js 22 LTS y pnpm 9
- Docker (PostgreSQL local y Testcontainers)

## Puesta en marcha

```bash
pnpm install
docker compose up -d db                 # PostgreSQL 16 de la instancia de desarrollo
cp .env.example .env                    # DATABASE_URL, OPERATOR_USER, OPERATOR_PASSWORD_HASH,
                                        # SESSION_SECRET, DEFAULT_PHONE_REGION=ES
pnpm operator:hash-password             # genera OPERATOR_PASSWORD_HASH
pnpm db:migrate                         # crea tablas y el negocio vacío en estado "draft"
pnpm dev                                # panel en http://localhost:3000/admin
```

Para ver en cualquier momento lo que recibiría el bot:

```bash
pnpm kb:snapshot                        # imprime el KnowledgeSnapshot en JSON
```

## Pruebas automáticas

```bash
pnpm test                               # unit + contract + integration (levanta Postgres con Testcontainers)
pnpm test:unit                          # validaciones, avisos, reglas temporales
pnpm test:integration                   # transacciones, FR-032, cascadas, activación
pnpm lint && pnpm typecheck
```

Resultado esperado: todas las suites en verde. Existe al menos un test por cada código del
catálogo de avisos (SC-004) y un test de neutralidad sectorial (SC-005, Principio I).

## Escenarios de validación manual

Cada escenario se hace en el panel y se comprueba con `pnpm kb:snapshot` y la lista de avisos.
Ningún paso requiere tocar código ni reiniciar el servicio (SC-002).

### 1. Instancia nueva (US5, FR-028, FR-031)

1. Entra en `/admin` con la instancia recién migrada.
2. **Esperado**: estado "En preparación"; avisos `BUSINESS_HOURS_MISSING` y
   `HANDOFF_UNREACHABLE` (crítico).
3. Pulsa "Activar". **Esperado**: se rechaza y se indica `HANDOFF_UNREACHABLE` como bloqueo.

### 2. Datos, horario y servicios (US1)

1. Registra nombre, dirección, indicaciones, teléfono `600 123 456` y email.
   **Esperado**: el snapshot muestra el teléfono como `+34600123456`; el aviso crítico pasa a
   `HANDOFF_CONTACT_MISSING` (normal) y `handoff.source = "business_phone"`.
2. Define L–V 09:00–14:00 y 16:00–20:00, S 10:00–14:00. **Esperado**: desaparece
   `BUSINESS_HOURS_MISSING`; domingo sin franjas.
3. Intenta guardar una franja 14:00–09:00. **Esperado**: error junto al campo de fin; nada guardado.
4. Añade un cierre de día completo el 25/12 y uno parcial el 24/12 de 14:00 a 20:00.
   **Esperado**: `isOpenAt(24/12, 17:00)` es falso y `isOpenAt(24/12, 10:00)` verdadero.
5. Añade tres servicios: "A" fijo 20 € 30 min reservable, "B" desde 40 € 60 min reservable,
   "C" a consultar no reservable. **Esperado**: en el snapshot, C tiene `price.type = "on_request"`
   sin importe; A y B `bookable = true`.
6. Intenta guardar un precio `-5`. **Esperado**: error en el campo precio.

### 3. Modificar datos (US2, FR-021, SC-003)

1. Cambia el precio de A de 20 € a 25 € y guarda.
2. **Esperado**: la siguiente llamada a `pnpm kb:snapshot` (sin reiniciar) devuelve 2500 céntimos.
3. Elimina B. **Esperado**: B desaparece del snapshot.

### 4. Recursos (US3, FR-011, FR-013, SC-006)

1. Antes de crear recursos, comprueba `scheduling.mode = "single_agenda"`.
2. Crea "Profesional 1" con A y horario L–X 09:00–14:00, y "Profesional 2" sin servicios.
   **Esperado**: `scheduling.mode = "resources"`; A lista solo a Profesional 1; aparece
   `SERVICE_WITHOUT_RESOURCE` para cualquier otro servicio reservable.
3. Añade a Profesional 1 una franja sábado 16:00–18:00. **Esperado**:
   `RESOURCE_HOURS_OUTSIDE_BUSINESS` indicando esa franja.
4. Añade una ausencia de una semana a Profesional 1. **Esperado**: aparece en `absences`.
5. Desactiva Profesional 1. **Esperado**: desaparece del snapshot, A pasa a `bookable = false`
   y aparece `SERVICE_WITHOUT_RESOURCE` para A; el modo sigue siendo `resources`.
   Reactívalo: recupera servicios, horario y ausencias.

### 5. FAQ, políticas, tono y derivación (US4)

1. Añade dos FAQ; define cancelación con 24 h de aviso, antelación mínima 2 h y máxima 30 días,
   formas de pago "Efectivo" y "Tarjeta"; tono "usted" con una descripción.
2. Intenta antelación mínima 31 días. **Esperado**: error en antelación mínima.
3. Registra un contacto de derivación WhatsApp con horario L–V 10:00–13:00. **Esperado**:
   `handoff.source = "configured"` y desaparece `HANDOFF_CONTACT_MISSING`.

### 6. Activación y protección de la salida a una persona (FR-029 – FR-032, Principio V)

1. Activa el negocio. **Esperado**: estado "Activo" aunque queden avisos normales.
2. Elimina el contacto de derivación. **Esperado**: se guarda (queda el teléfono) y aparece
   `HANDOFF_CONTACT_MISSING`.
3. Borra el teléfono del negocio. **Esperado**: `409`, el teléfono sigue guardado y el mensaje
   explica que el negocio activo se quedaría sin salida a una persona.
4. Desactiva el negocio y repite el paso 3. **Esperado**: se guarda y aparece `HANDOFF_UNREACHABLE`.

### 7. Neutralidad sectorial (SC-005, FR-024)

```bash
pnpm test -- sector-neutrality
```

**Esperado**: los fixtures de clínica, peluquería y taller se cargan con el mismo modelo sin
campos adicionales, y la búsqueda de nombres de sector o cliente en `src/` no encuentra lógica
condicional.

### 8. Tiempo de alta (SC-001)

Registra un negocio típico (datos, horario, 10 servicios, 3 recursos, 10 FAQ, políticas, tono
y contacto) cronometrando. **Esperado**: menos de 30 minutos.

## Resultado de la validación (2026-09-24)

Escenarios 1–6 recorridos contra `pnpm dev` con un script que envía los formularios del panel
como un navegador sin JavaScript y comprueba cada paso con `pnpm kb:snapshot` y la portada:
29/29 comprobaciones correctas.

| Escenario | Resultado |
|-----------|-----------|
| 1. Instancia nueva | Correcto: "En preparación", dos avisos, activación rechazada con `409` |
| 2. Datos, horario y servicios | Correcto: `+34600123456`, errores en `slots[0].end` y `price`, C "a consultar" |
| 3. Modificar datos | Correcto: 2500 céntimos y B eliminado sin reiniciar |
| 4. Recursos | Correcto: modos, `RESOURCE_HOURS_OUTSIDE_BUSINESS` (sáb 16:00–18:00), desactivar y reactivar |
| 5. FAQ, políticas, tono y derivación | Correcto: antelación 31 días rechazada en `min_advance` |
| 6. Activación y protección | Correcto: `409` al borrar el teléfono con el negocio activo; tras desactivar, `HANDOFF_UNREACHABLE` |
| 7. Neutralidad sectorial | Correcto: `pnpm test -- sector-neutrality` en verde |
| 8. Tiempo de alta (SC-001) | Pendiente: lo tiene que cronometrar una persona en el panel |

Rendimiento medido con `tests/integration/performance.test.ts` (Docker Desktop en Windows):
`getSnapshot()` p95 ≈ 25–31 ms con la suite completa en paralelo (objetivo < 50 ms; el estado se carga en una sola consulta) y guardado de servicio p95 ≈ 60–70 ms
(objetivo < 300 ms).
