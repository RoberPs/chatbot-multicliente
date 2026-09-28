# Data Model: Claridad del panel del operador y enlace a mapa

**Feature**: `003-admin-panel-clarity` | **Fecha**: 2026-09-28

Parte del modelo de la [001](../001-business-knowledge-base/data-model.md). Solo cambia una
tabla; el resto son valores derivados que se calculan en cada petición y no se guardan.

## Negocio (`business`, ampliado)

| Campo | Columna | Tipo | Reglas |
|-------|---------|------|--------|
| Enlace a mapa | `map_url` | `text`, nulo | Opcional. Solo `https://`, ≤ 500 caracteres, sin espacios, host con dominio, sin usuario ni contraseña ([research R7](research.md#r7-validación-de-enlace-a-mapa-fr-011-fr-012-fr-015)). Vacío → `NULL`. Se guarda recortado, tal como se escribió |

- Migración `0003` (drizzle-kit): `ALTER TABLE "business" ADD COLUMN "map_url" text;`. Sin
  datos que copiar; las instancias existentes quedan con `NULL`.
- Dominio: `BusinessRecord.mapUrl: string | null`, `businessSchema` añade
  `map_url: optionalHttpsUrl(500)`, y `loadKnowledgeState` lo lee.
- Avisos: ninguno nuevo (FR-015). Sin dirección y con enlace es válido.

## Contacto de derivación (sin cambios en la BD)

Sigue siendo un registro único con sus medios en orden (001). Solo cambia la entrada del
formulario:

| Campo del formulario | Tipo | Regla |
|----------------------|------|-------|
| `channels[i].type` | `phone` \| `whatsapp` \| `email` | Como en la 001 |
| `channels[i].value` | texto | Como en la 001; **no se valida** si la fila está marcada para quitar |
| `channels[i].remove` | casilla | Presente = la fila se descarta al guardar (FR-001) |

Sin medios tras quitar → se borra el contacto y se aplica FR-019 (teléfono del negocio). El
guardado sigue protegido por FR-032.

## Contacto que usa el bot (derivado, no se guarda)

Es el `EffectiveHandoff` que ya existe (`effectiveHandoff(state)`, FR-019 de la 001):

| Campo | Valores |
|-------|---------|
| `source` | `configured` (contacto de derivación con medios) · `business_phone` (no hay contacto; hay teléfono) · `none` |
| `channels` | Lista ordenada de `(type, value)` |
| `hours` | Horario de atención; **no cuenta** para decidir si el contacto ha cambiado |

Dos contactos son el mismo si coinciden `source` y la lista ordenada de `(type, value)`.

## HandoffChange (derivado, no se guarda)

Lo devuelven `saveBusiness` y `saveHandoff` tras confirmar el guardado:

```ts
interface HandoffChange {
  before: EffectiveHandoff;
  after: EffectiveHandoff;
  /** El guardado modificó el teléfono del negocio o los medios guardados (FR-006 b). */
  touched: boolean;
  /** Estado del negocio después del guardado. */
  status: BusinessStatus;
}
```

Regla del mensaje (FR-006, FR-007), con `changed = !sameContact(before, after)`:

| `changed` | `touched` | Mensaje |
|-----------|-----------|---------|
| no | no | Solo "Guardado" |
| no | sí | "Guardado." + contacto actual + por qué sigue siendo el mismo (caso b) |
| sí | cualquiera | "Guardado." + contacto nuevo y su origen (caso a) |

Si `after.source === 'none'` y el negocio está en preparación, el mensaje dice que no hay
salida a una persona y que no se podrá activar hasta tenerla (FR-007). Con el negocio activo
ese estado es imposible: FR-032 lo rechaza antes. Textos en
[contracts/admin-panel.md](contracts/admin-panel.md#mensajes-del-contacto-que-usa-el-bot).

## Resumen de sección (derivado, no se guarda)

`sectionSummaries(state)` devuelve un texto por sección para la portada (FR-009):

| Sección | "Sin configurar" si… | Si no |
|---------|----------------------|-------|
| Políticas | no hay fila, o todos sus campos están vacíos | `N formas de pago` (`1 forma de pago`, `sin formas de pago`) + ` · con política de cancelación` o ` · sin política de cancelación` |
| Tono | no hay fila | `trato de tú` o `trato de usted`, + ` · con estilo propio` si hay descripción |
| Derivación | `source = none` | `configured`: `N medios` (`1 medio`) · `business_phone`: `usa el teléfono del negocio` |

## Vista del bot (`KnowledgeSnapshot`, ampliada)

`business.mapUrl: string | null`, junto a `address` y `directions` (FR-014). `null` si no hay
enlace. El resto del snapshot no cambia. Contrato en
[contracts/knowledge-reader.md](contracts/knowledge-reader.md).
