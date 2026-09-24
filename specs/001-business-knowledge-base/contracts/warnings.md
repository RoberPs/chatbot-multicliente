# Contrato: catálogo de avisos

**Feature**: `001-business-knowledge-base` | Fuente: FR-025 – FR-028, edge cases de la spec

Los avisos se calculan a partir del estado actual con `computeWarnings(state)` y nunca se
persisten ([research R5](../research.md#r5-avisos-calculados-no-almacenados)). Los códigos
son estables: los tests y el panel dependen de ellos.

Reglas generales:

- Solo se evalúan servicios y recursos **activos**. Un elemento inactivo no genera avisos ni
  cuenta para los de otros (FR-011b).
- Cada aviso identifica el elemento afectado y el dato (FR-026).
- Un aviso desaparece en cuanto su condición deja de cumplirse (FR-027).
- Solo los avisos `critical` bloquean la activación (FR-031) y, con el negocio activo, los
  cambios que los provocan (FR-032).

## Forma

```ts
type WarningSeverity = "normal" | "critical";

interface Warning {
  code: WarningCode;
  severity: WarningSeverity;
  target: {
    kind: "business" | "service" | "resource" | "handoff";
    id?: string;        // uuid del servicio/recurso; ausente en singletons
    label: string;      // nombre visible para el operador
  };
  field?: string;       // dato que falta o es incoherente
  message: string;      // en el idioma de la instancia
  details?: Record<string, unknown>; // p. ej. franjas fuera de horario
}
```

Orden de la lista: primero críticos, después por `target.kind` y `target.label`.

## Catálogo

| Código | Gravedad | Condición | target / field | Req. |
|--------|----------|-----------|----------------|------|
| `SERVICE_DURATION_MISSING` | normal | Servicio activo, `bookable = true` y `duration_minutes IS NULL` | `service` / `duration` | FR-025, FR-009 |
| `BUSINESS_HOURS_MISSING` | normal | No existe ninguna fila en `business_hours` | `business` / `hours` | FR-025 |
| `SERVICE_PRICE_MISSING` | normal | Servicio activo con `price_type ∈ {fixed, from}` y `price_cents IS NULL` | `service` / `price` | FR-025, edge cases |
| `SERVICE_WITHOUT_RESOURCE` | normal | Existe al menos un recurso registrado (activo o inactivo) y un servicio activo con `bookable = true` no lo presta ningún recurso **activo** | `service` / `resources` | FR-025, edge cases |
| `RESOURCE_HOURS_OUTSIDE_BUSINESS` | normal | Recurso activo con alguna franja (o parte de ella) fuera de las franjas del negocio para ese día. `details.slots` lista las partes fuera de horario | `resource` / `hours` | FR-025, edge cases |
| `HANDOFF_CONTACT_MISSING` | normal | No hay contacto de derivación configurado pero sí `business.phone` (se usa como derivación) | `handoff` / `channels` | FR-025, FR-019 |
| `HANDOFF_UNREACHABLE` | **critical** | No hay contacto de derivación configurado **ni** `business.phone` | `handoff` / `channels` | FR-028, Principio V |

Notas:

- `HANDOFF_CONTACT_MISSING` y `HANDOFF_UNREACHABLE` son mutuamente excluyentes: sin contacto
  de derivación se emite exactamente uno de los dos.
- `RESOURCE_HOURS_OUTSIDE_BUSINESS` compara solo franjas semanales. Si el negocio no tiene
  horario, se emite `BUSINESS_HOURS_MISSING` y no se evalúa esta regla (evita avisos en
  cascada).
- No se genera aviso por no tener recursos (FR-013), ni por contradicciones entre FAQ y datos
  estructurados (FR-014a).

## Ejemplos (casos de test mínimos, SC-004)

| Estado | Avisos esperados |
|--------|------------------|
| Instancia recién creada (sin datos) | `BUSINESS_HOURS_MISSING`, `HANDOFF_UNREACHABLE` |
| + teléfono del negocio | `BUSINESS_HOURS_MISSING`, `HANDOFF_CONTACT_MISSING` |
| + horario + contacto de derivación | ninguno |
| + servicio "Corte" reservable sin duración | `SERVICE_DURATION_MISSING` (Corte) |
| + servicio "Revisión" precio fijo sin importe | `SERVICE_PRICE_MISSING` (Revisión) |
| + servicio "Presupuesto" a consultar sin importe | ninguno nuevo |
| + recurso "Profesional 1" que no presta "Corte" | `SERVICE_WITHOUT_RESOURCE` (Corte) |
| "Profesional 1" con franja sábado 16:00–18:00 y negocio cerrado sábado tarde | `RESOURCE_HOURS_OUTSIDE_BUSINESS` (Profesional 1, sáb 16:00–18:00) |
| Se desactiva "Corte" | desaparecen sus avisos |
| Todos los recursos desactivados, "Corte" reservable activo | `SERVICE_WITHOUT_RESOURCE` (Corte) — no pasa a agenda única |
