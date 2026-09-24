# Contrato: composición de respuestas y mensajes fijos

**Feature**: `002-whatsapp-faq-bot` | Fuente: FR-004a, FR-016 – FR-021, FR-028, FR-028a, FR-029 | Research: R9

El código compone cada respuesta. El modelo solo aporta el cuerpo (`ModelReply.body`,
[chat-model.md](chat-model.md)). Todas las plantillas son genéricas (sin sector ni cliente),
en español y con variante tú/usted según `snapshot.tone.addressForm` (null → tú).

## Estructura de una respuesta

```text
[SALUDO]            solo si la conversación no tiene `greeted` (FR-020, FR-021)
[CUERPO]            del modelo, o un mensaje fijo
[AVISO DE ARCHIVO]  si en el lote hay algún mensaje `other` (FR-028a)
[CONTACTO]          una sola vez, si aplica (FR-016)
```

Separados por una línea en blanco. Un único mensaje de WhatsApp por respuesta.

## Árbol de decisión por lote de mensajes pendientes

| Situación del lote | Cuerpo | Contacto |
|--------------------|--------|----------|
| Snapshot ilegible (fallo de BD) | R-ERR | CONTACTO-EMERGENCIA (el del snapshot no se conoce) |
| Negocio no activo | — no se responde, se borran (FR-002) | — |
| Fuera de ventana 24 h | — no se responde, `discarded` (FR-002a) | — |
| Solo `other` sin pie | R-MEDIA | no |
| Solo audios no entendidos (audios activados) | R-AUDIO | no |
| Resto | modelo (con los no entendidos y los `other` anotados en `pending`) | según reglas de abajo |
| Modelo falla o se agota el plazo | R-ERR | sí |
| Verificador rechaza dos veces | R-SAFE | sí |

**Se añade el bloque de contacto** si se cumple cualquiera: `handoffRequested`,
`offerContact`, `bookingRequested`; algún `mentionedServiceIds` con precio `on_request` o
`missing`; el detector determinista de petición de persona encuentra una expresión en algún
mensaje del lote; el cuerpo es R-SAFE o R-ERR con snapshot legible.

Si `needsRephrase` es true, el cuerpo del modelo ya pide reformular y no se añade CONTACTO por
`offerContact`, `bookingRequested` ni por los precios. **Sí se añade** si `handoffRequested` es
true o si el detector determinista encuentra una petición de persona (Principio V).

## Plantillas

`{negocio}` = `snapshot.business.name`. Se muestran en tú; la variante usted cambia las formas
verbales y pronombres.

| Id | Texto (tú) |
|----|------------|
| SALUDO | ¡Hola! Soy el asistente automático de {negocio}. Puedo informarte sobre horario, ubicación, servicios, precios y dudas frecuentes. |
| CONTACTO | Para hablar con una persona de {negocio}: {canales}.{ Horario de atención: {horario}.} |
| R-MEDIA (audios desactivados, por defecto) | Solo puedo atender mensajes de texto. ¿Me escribes tu consulta? |
| R-MEDIA (audios activados) | Solo puedo atender mensajes de texto y audios. ¿Me escribes o me grabas tu consulta? |
| AVISO DE ARCHIVO (audios desactivados) | No puedo ver archivos, imágenes, stickers ni escuchar audios; solo leo mensajes de texto. |
| AVISO DE ARCHIVO (audios activados) | No puedo ver archivos, imágenes ni stickers; solo leo texto y escucho audios. |
| R-AUDIO | No he podido entender el audio. ¿Puedes repetirlo o escribirme tu consulta? |
| R-SAFE | No dispongo de esa información. |
| R-ERR | Ahora mismo no puedo responder. Por favor, vuelve a escribirme en unos minutos. |
| R-LIMIT | Has enviado muchos mensajes seguidos y voy a dejar de responder durante un rato. {CONTACTO} |
| CONTACTO-EMERGENCIA | Si necesitas hablar con una persona: teléfono {EMERGENCY_CONTACT_PHONE}. |

- `{canales}`: canales de `snapshot.handoff.channels` en su orden, con etiqueta genérica
  ("teléfono", "WhatsApp", "correo") y el valor tal cual (teléfonos en formato
  internacional legible).
- `{horario}`: `snapshot.handoff.hours` agrupadas por días con el mismo horario
  ("lunes a viernes de 9:00 a 14:00"). Sin horario registrado, se omite la frase.
- R-LIMIT se envía una sola vez por ventana (R6) y no lleva saludo.
- CONTACTO-EMERGENCIA solo acompaña a R-ERR cuando el snapshot no se pudo leer. No lleva
  nombre de negocio, horario ni variante tú/usted, porque nada de eso se conoce; el teléfono
  sale de `EMERGENCY_CONTACT_PHONE` en formato internacional legible.
- Las respuestas R-MEDIA y R-AUDIO sí llevan saludo si abren conversación.

## Detector determinista de petición de persona

Función pura sobre el texto normalizado (minúsculas, sin tildes) que busca expresiones
genéricas: "hablar con (una persona|alguien|un humano|el encargado|la encargada|el
responsable)", "persona real", "atencion (al cliente|personal)", "que me llame(n)",
"no quiero hablar con un bot", "pasame con", etc. La lista vive en el núcleo, es de uso
general y no contiene términos de sector (test de neutralidad).

## Garantías verificables (tests unitarios)

1. Toda respuesta a un lote que contiene una petición de persona incluye el bloque CONTACTO
   (SC-008), aunque el modelo no la marque y aunque marque `needsRephrase`.
2. La primera respuesta de cada conversación empieza por SALUDO y ninguna otra lo contiene
   (SC-005).
3. CONTACTO aparece como máximo una vez por respuesta (FR-023).
4. Ninguna plantilla contiene cifras del negocio que no salgan del snapshot.
5. En un negocio activo, CONTACTO nunca queda vacío (la 001 garantiza
   `handoff.source ≠ "none"`).
6. Ninguna respuesta queda sin forma de contactar con una persona: si el snapshot no se pudo
   leer, R-ERR lleva CONTACTO-EMERGENCIA (FR-029).
