# Contrato: la interfaz del chat web ante un fallo inesperado

**Feature**: 016-db-outage-resilience · Cubre FR-009 y FR-013.

Amplía `specs/004-web-channel/contracts/web-chat-http.md`. Lo que ya estaba no cambia: la API, los
códigos, el objeto `unavailable` y la garantía de que la interfaz nunca construye HTML a partir de
texto (todo se pinta con `textContent`).

---

## 1 · El contacto viaja en la página (FR-013)

`GET /chat/frame` añade a la vista el contacto que la interfaz debe mostrar si el servidor no
contesta.

| Situación al servir la página | Contacto que viaja |
|---|---|
| Se pudo leer la información del negocio y tiene canales de contacto | el bloque de contacto del negocio |
| No se pudo leer la información del negocio | el **teléfono de emergencia de la instancia** |
| La instancia no tiene teléfono de emergencia ni contacto legible | ninguno (`null`) |

- Viaja como atributo de datos en `<html>`, escapado por la plantilla.
- `frame.js` lo lee de `document.documentElement.dataset` **al arrancar**, antes de cualquier
  petición, y lo guarda en su estado.
- `GET /chat/api/state` sigue pudiendo refinarlo cuando responde; si no responde, vale el de la
  página.
- La página no lleva nada más: ni dirección de base de datos, ni host, ni credenciales (FR-012).

---

## 2 · Fin del «escribiendo…» eterno (FR-009)

Al enviar un mensaje, la interfaz indica espera. Esa indicación se retira **siempre**:

| Respuesta al envío | Antes | Ahora |
|---|---|---|
| `202` aceptado | sondea la respuesta | sin cambios |
| `400` mensaje inválido | aviso de longitud | sin cambios |
| `401` sesión caducada | pide otra sesión | sin cambios |
| `429` límite alcanzado | aviso con contacto | sin cambios |
| `200` con `unavailable` | «no disponible» con contacto | sin cambios |
| `503` con `unavailable` (base de datos caída) | «no disponible» con contacto | sin cambios |
| **`500`, `502`, `504` o cualquier cuerpo que no se entiende** | **se queda indicando espera para siempre** | **deja de indicar espera y añade el aviso con el contacto** |
| Fallo de red antes de recibir nada | aviso de «no se ha podido enviar» | igual, más el contacto |
| 45 s esperando respuesta sin que llegue | aviso con contacto | sin cambios |

**Reglas del aviso.**

- El contacto que se muestra es el de la página (§1): no depende de ninguna respuesta del
  servidor en ese momento.
- El aviso se añade como mensaje del propio chat y **no esconde el formulario**: el cliente puede
  volver a escribir, y si el servicio ya funciona la conversación sigue con normalidad (US3-2).
- No se repite en bucle: un aviso por fallo.
- Se pinta con `textContent`; nada de HTML construido a partir de texto.

**Garantía comprobable (SC-005).** No existe camino en el que la interfaz quede indicando espera
indefinidamente: todos los casos del envío y del sondeo terminan en una respuesta pintada o en un
aviso con contacto.
