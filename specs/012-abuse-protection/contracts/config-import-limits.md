# Contrato: límites de la importación de configuración

**Feature**: 012 · US6 · FR-028 – FR-030 · research R15. Amplía
[008 config-file](../../008-config-export-import/contracts/) (el formato no cambia; **no sube
`formatVersion`**).

## Tamaño

5 MB (sin cambios). Mayor → rechazo de sección `file` con «El fichero supera el máximo de 5 MB».

## Listas

| Lista (ruta en el fichero) | Máximo |
|---|---|
| `openingHours` | 70 |
| `closures` | 366 |
| `services` | 300 |
| `resources` | 100 |
| `resources[].services` | 300 |
| `resources[].hours` | 70 |
| `resources[].absences` | 366 |
| `faqs` | 300 |
| `policies.paymentMethods` | 30 |
| `handoff.channels` | 10 |
| `handoff.hours` | 70 |
| `webChat.allowedOrigins` | 10 (ya existe) |

Comprobación previa (antes del esquema completo): si alguna lista supera su máximo, el fichero se
rechaza con `reason: 'invalid'` y **solo** los errores de longitud, uno por lista:
`Hay 412 servicios; el máximo es 300` (sección y elemento como los demás errores). No se valida el
resto ni se aplica nada.

## Errores mostrados

- Como mucho **50**, en el orden del fichero.
- Si hay más: línea final «Y 128 errores más. Corrige estos y vuelve a importar.»
- El registro de la importación (`config_import_rejected`) guarda el total (`issues`), como hoy.

## Coste

- Eliminación de repetidos: `Set` de `ruta|mensaje` (lineal).
- Orden en el fichero: posiciones de clave precalculadas por nodo (sin `indexOf` por comparación).
- Aplicación: pertenencias con `Set` (sin `includes` dentro de bucles).
- SC-007: validar y previsualizar el fichero en su máximo < 5 s (prueba de integración).
