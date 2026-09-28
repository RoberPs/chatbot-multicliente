# Contrato: cambios en el panel del operador

**Feature**: `003-admin-panel-clarity` | Amplía [001 admin-panel.md](../../001-business-knowledge-base/contracts/admin-panel.md)

Se mantienen las reglas comunes de la 001: sesión, CSRF, `303` con flash al guardar (htmx:
`200` + `HX-Location`), `422` con errores por campo, `409` por FR-032 y un guardado por
transacción. Todo funciona sin JavaScript.

## Rutas que cambian

### Datos del negocio

| Método | Ruta | Campos |
|--------|------|--------|
| GET | `/admin/business` | Muestra además el recuadro "Contacto que usa el bot" y, si hay enlace guardado, "Abrir en una pestaña nueva" |
| POST | `/admin/business` | Los de la 001 + `map_url` |

- `map_url` inválido → `422`, error junto al campo, no se guarda nada (FR-012). Mensajes en
  [research R7](../research.md#r7-validación-de-enlace-a-mapa-fr-011-fr-012-fr-015).
- Éxito → `303 → /admin/business` con el flash de la tabla de mensajes de abajo.

### Contacto de derivación

| Método | Ruta | Campos |
|--------|------|--------|
| GET | `/admin/handoff` | Muestra además el texto de registro único y el recuadro "Contacto que usa el bot" |
| POST | `/admin/handoff` | `channels[i].type`, `channels[i].value`, **`channels[i].remove`**, `slots[i]…` |

- Las filas con `remove` no se guardan ni se validan (FR-001, FR-004).
- `422`: se vuelve a pintar con los valores y las marcas del operador.
- `409` (FR-032): se vuelve a pintar con los **medios guardados**, sin marcas, el error
  general de la 001 y el aviso que lo provoca (FR-003).
- Éxito → `303 → /admin/handoff` con el flash de la tabla de abajo.

### Portada

| Método | Ruta | Cambio |
|--------|------|--------|
| GET | `/admin` | En "Secciones", junto a Políticas, Tono y Contacto de derivación, el resumen de [data-model](../data-model.md#resumen-de-sección-derivado-no-se-guarda) |

### Políticas y Tono

`GET /admin/policies` y `GET /admin/tone` muestran el texto de registro único. Los `POST` no
cambian.

## Recuadro "Contacto que usa el bot" (FR-005)

En Datos y en Derivación, calculado con `effectiveHandoff(state)` en cada petición:

| `source` | Texto |
|----------|-------|
| `configured` | **El bot pasa las conversaciones a:** `<medios en orden>`. *Origen: contacto de derivación configurado.* |
| `business_phone` | **El bot pasa las conversaciones a:** `<teléfono>`. *Origen: teléfono del negocio, porque no hay contacto de derivación configurado.* |
| `none` | **El bot no tiene a quién pasar las conversaciones.** *Registra un contacto de derivación o el teléfono del negocio.* |

Cada medio se muestra como `Teléfono +34…`, `WhatsApp +34…` o `Email …`.

## Mensajes del contacto que usa el bot

Flash tras un guardado correcto de Datos o Derivación (FR-006, FR-007, SC-003). Regla de
cuándo sale cada uno en [data-model](../data-model.md#handoffchange-derivado-no-se-guarda).
`<contacto>` es la lista de medios como en el recuadro.

| Caso | Mensaje |
|------|---------|
| Sin cambios en el contacto ni en teléfono o medios | `Guardado` |
| (a) nuevo origen `configured` | `Guardado. A partir de ahora el bot pasa las conversaciones al contacto de derivación configurado: <contacto>.` |
| (a) nuevo origen `business_phone` | `Guardado. No hay contacto de derivación configurado, así que el bot pasa las conversaciones al teléfono del negocio: <teléfono>.` |
| (a) nuevo origen `none`, en preparación | `Guardado. El negocio se ha quedado sin salida a una persona: el bot no tiene a quién pasar las conversaciones. No se podrá activar hasta que registres un contacto de derivación o el teléfono del negocio.` |
| (b) Datos: cambia el teléfono y el origen sigue siendo `configured` | `Guardado. El teléfono del negocio no se usa para pasar conversaciones porque hay un contacto de derivación configurado; el bot sigue pasándolas a: <contacto>.` |
| (b) Derivación: cambian los medios guardados y el contacto del bot no cambia | `Guardado. El bot sigue pasando las conversaciones a: <contacto> (<origen>).` |

El último caso (b) casi no se da (cambiar los medios cambia el contacto), pero se define para
que la regla sea completa.

## Textos fijos

| Dónde | Texto |
|-------|-------|
| Políticas (FR-008) | Cada negocio tiene un único conjunto de políticas. Al guardar, lo que hay en este formulario sustituye a lo anterior. |
| Tono (FR-008) | Cada negocio tiene una única configuración de tono. Al guardar, sustituye a la anterior. |
| Derivación (FR-008) | Cada negocio tiene un único contacto de derivación, con uno o varios medios por orden de preferencia. Para añadir un medio, rellena la fila vacía o pulsa "Añadir medio". Para quitarlo, marca "Quitar" y guarda. Si quitas todos, el bot usará el teléfono del negocio. |
| Cómo llegar (FR-010) | El bot envía este texto tal cual cuando un cliente pregunta dónde estáis o cómo llegar. Ejemplo: "Estamos en la planta baja, junto a la entrada principal del mercado. Autobús: líneas 4 y 12, parada Plaza Mayor. Hay aparcamiento público a 100 m." |
| Enlace a mapa (FR-011) | Opcional. Pega el enlace de "Compartir" de cualquier servicio de mapas; debe empezar por https://. El bot lo enviará junto a la dirección. |

## Fila de medio

```html
<div class="slot-row channel-row">
  <select name="channels[i].type">…</select>
  <input type="text" name="channels[i].value">
  <label class="checkbox remove"><input type="checkbox" name="channels[i].remove"> Quitar</label>
</div>
```

- La fila vacía de reserva y la que añade "Añadir medio" no llevan "Quitar" (no hay nada que
  quitar).
- CSS: `.channel-row:has(.remove input:checked)` atenúa y tacha la fila. Sin JavaScript.
