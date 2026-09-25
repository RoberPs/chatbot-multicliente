# Feature Specification: Claridad del panel del operador y enlace a mapa

**Feature Branch**: `003-admin-panel-clarity`

**Created**: 2026-09-24

**Status**: Draft

**Ámbito**: núcleo (genérico, aplica a todos los clientes)

**Input**: User description: "Mejoras de claridad en el panel del operador detectadas al recorrer
la guía de validación de la base de conocimiento: botón para quitar cada medio de derivación;
explicar que Políticas y Derivación son registros únicos; mensaje al borrar el teléfono cuando el
bot va a usar el contacto de derivación; ejemplo y explicación en 'Cómo llegar'; corregir la guía
de validación para que explique cómo eliminar el contacto. Además, un campo opcional 'Enlace a
mapa' en los datos del negocio, que se ofrece al bot junto con la dirección."

## Contexto

Al recorrer la guía de validación de la base de conocimiento (feature 001), el operador encontró
estos problemas. El sistema se comporta según su spec, pero el panel no explica lo que pasa:

- En **Políticas** y **Derivación** solo hay un formulario, sin listado ni botón "Nuevo". Eso
  parece un error, pero cada negocio tiene una sola política y un solo contacto de derivación
  (con uno o varios medios). El panel no lo dice.
- No se puede **quitar** un medio de derivación. La única forma es vaciar el campo y guardar, y
  eso no se explica en ninguna parte. Por eso el paso "elimina el contacto de derivación" de la
  guía no se pudo completar.
- Al borrar el teléfono del negocio con un contacto de derivación configurado, el cambio se
  guarda sin avisar. El comportamiento es correcto, porque el negocio sigue teniendo salida a una
  persona, pero el operador no sabe a quién pasará el bot la conversación a partir de ese momento.
- En **Cómo llegar** no queda claro qué escribir ni cómo lo usará el bot. Tampoco hay forma de
  dar un enlace a un mapa, que es lo habitual cuando alguien pregunta "¿dónde estáis?".

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Quitar medios del contacto de derivación (Priority: P1)

El operador quiere quitar un medio concreto del contacto de derivación (por ejemplo, un teléfono
que ya no se usa) o quitarlos todos para que el bot use el teléfono del negocio. Lo hace desde la
pantalla de Derivación con una acción visible en cada medio, sin tener que vaciar campos.

**Why this priority**: sin esta acción no se puede corregir un contacto de derivación erróneo, que
es lo único que garantiza la salida a una persona (Principio V). Además, la guía de validación
de la feature 001 no se puede completar.

**Independent Test**: se registran dos medios, se quita uno y se guarda. Se comprueba que en la
vista del bot solo queda el otro. Después se quitan todos y se comprueba que el bot usa el
teléfono del negocio.

**Acceptance Scenarios**:

1. **Given** un contacto de derivación con dos medios, **When** el operador quita uno y guarda,
   **Then** el contacto queda solo con el otro medio y se mantiene el orden de preferencia.
2. **Given** un contacto de derivación con medios y un teléfono del negocio registrado, **When**
   el operador quita todos los medios y guarda, **Then** se guarda y el bot pasa a usar el
   teléfono del negocio como contacto de derivación.
3. **Given** un negocio activo sin teléfono y con un único medio de derivación, **When** el
   operador lo quita y guarda, **Then** el cambio se rechaza, el medio sigue guardado y el mensaje
   explica que el negocio activo se quedaría sin salida a una persona (como ya exige FR-032 de
   la feature 001).
4. **Given** el operador ha quitado un medio en el formulario pero todavía no ha guardado,
   **When** abandona la pantalla o recarga, **Then** el medio sigue guardado: quitar solo tiene
   efecto al guardar.

---

### User Story 2 - Saber a quién pasará el bot la conversación (Priority: P1)

Cuando el operador cambia el teléfono del negocio o el contacto de derivación, el panel le dice,
después de guardar, qué contacto usará el bot para pasar la conversación a una persona y le
avisa cuando ese contacto ha cambiado de origen.

**Why this priority**: sin esta información, el operador cree que el sistema ha fallado cuando
borra el teléfono y no aparece ningún aviso. Es justo el problema detectado en el paso 6-3 de la
guía.

**Independent Test**: con un contacto de derivación configurado, se borra el teléfono del negocio
y se guarda. Se comprueba que aparece un mensaje que indica que el bot usará el contacto de
derivación configurado. Después se quita el contacto de derivación y se comprueba que el mensaje
indica que el bot usará el teléfono del negocio.

**Acceptance Scenarios**:

1. **Given** un contacto de derivación configurado y el teléfono del negocio registrado, **When**
   el operador borra el teléfono y guarda, **Then** el cambio se guarda y aparece un mensaje que
   dice que el teléfono ya no se usa y que el bot pasará las conversaciones al contacto de
   derivación configurado.
2. **Given** un negocio sin contacto de derivación configurado y con teléfono, **When** el
   operador cambia el teléfono y guarda, **Then** el mensaje de guardado dice que el bot pasará
   las conversaciones a ese nuevo teléfono.
3. **Given** un negocio en preparación con contacto de derivación configurado y sin teléfono,
   **When** el operador quita todos los medios de derivación y guarda, **Then** el cambio se
   guarda y el mensaje dice que el negocio se queda sin salida a una persona y que no se podrá
   activar hasta que la tenga.
4. **Given** cualquier estado del negocio, **When** el operador abre las pantallas de Datos o de
   Derivación, **Then** ambas muestran qué contacto usa el bot en ese momento para pasar la
   conversación a una persona y de dónde sale (contacto configurado, teléfono del negocio o
   ninguno).

---

### User Story 3 - Entender las pantallas de registro único (Priority: P2)

El operador entra en Políticas, Tono o Derivación y entiende al momento que cada negocio tiene
un único registro de ese tipo, que se edita en esa misma pantalla. Desde la portada ve de un
vistazo si esas secciones están configuradas y cuánto contienen.

**Why this priority**: evita confusiones y consultas de soporte, pero no bloquea ninguna tarea.

**Independent Test**: se abre cada pantalla y se comprueba que tiene el texto explicativo. En la
portada se comprueba que cada sección muestra su resumen y que ese resumen cambia al guardar.

**Acceptance Scenarios**:

1. **Given** la pantalla de Políticas, **When** el operador la abre, **Then** un texto explica
   que el negocio tiene un único conjunto de políticas y que al guardar se sustituye el anterior.
2. **Given** la pantalla de Derivación, **When** el operador la abre, **Then** un texto explica
   que hay un único contacto de derivación, con uno o varios medios por orden de preferencia, y
   cómo añadir y quitar medios.
3. **Given** la portada, **When** el operador la consulta, **Then** junto a Políticas, Tono y
   Derivación aparece un resumen de su estado: "Sin configurar" o lo que está registrado (por
   ejemplo, "3 formas de pago", "trato de usted", "2 medios" o "usa el teléfono del negocio").

---

### User Story 4 - Explicar cómo llegar y enlazar un mapa (Priority: P2)

El operador rellena "Cómo llegar" con ayuda de un ejemplo en el propio formulario y registra,
si quiere, un enlace a un mapa con la ubicación del negocio. Cuando un cliente pregunte dónde
está el negocio, el bot tendrá la dirección, las indicaciones y el enlace.

**Why this priority**: mejora la respuesta de ubicación del bot (feature 002), pero la dirección
y las indicaciones ya bastan para contestar.

**Independent Test**: se registra un enlace a un mapa y se comprueba que aparece en la vista del
bot junto a la dirección. Se intenta guardar un enlace mal formado y se comprueba que se rechaza
con el error junto al campo.

**Acceptance Scenarios**:

1. **Given** la pantalla de Datos, **When** el operador mira el campo "Cómo llegar", **Then** ve
   un texto de ayuda que dice que el bot lo enviará tal cual al preguntar por la ubicación, y un
   ejemplo de indicaciones (referencias cercanas, transporte público, aparcamiento).
2. **Given** la pantalla de Datos, **When** el operador escribe un enlace web válido en "Enlace a
   mapa" y guarda, **Then** el enlace queda guardado y la vista del bot lo incluye junto a la
   dirección y las indicaciones.
3. **Given** la pantalla de Datos, **When** el operador escribe un texto que no es un enlace web
   válido y guarda, **Then** se rechaza, se muestra el error junto al campo y no se guarda nada.
4. **Given** un enlace a mapa guardado, **When** el operador vacía el campo y guarda, **Then** el
   enlace desaparece de la vista del bot.
5. **Given** un enlace a mapa guardado, **When** el operador lo consulta en el panel, **Then**
   puede abrirlo desde el propio formulario para comprobar que lleva al sitio correcto.

---

### User Story 5 - Guía de validación corregida (Priority: P3)

Quien recorre la guía de validación de la feature 001 puede completar el escenario 6 sin
adivinar cómo se elimina el contacto de derivación, y la guía cubre también las comprobaciones
de esta feature.

**Why this priority**: es documentación. No cambia el comportamiento, pero sin ella la
validación manual da falsos fallos, como ocurrió en el paso 6-3.

**Independent Test**: una persona que no conoce el panel sigue la guía paso a paso y obtiene
todos los resultados esperados.

**Acceptance Scenarios**:

1. **Given** la guía de validación, **When** se llega al paso "elimina el contacto de
   derivación", **Then** la guía indica la acción concreta del panel y el mensaje que debe
   aparecer.
2. **Given** la guía de validación, **When** se recorre, **Then** incluye pasos para comprobar
   el enlace a mapa y los mensajes sobre el contacto que usa el bot.

---

### Edge Cases

- **Quitar el único medio y volver a añadir otro sin guardar**: al guardar solo cuenta lo que
  queda en el formulario, así que se guarda el medio nuevo.
- **Quitar todos los medios con el formulario inicial vacío**: si no había contacto
  configurado, guardar sin medios no cambia nada y el mensaje sigue indicando el origen actual.
- **Rechazo por FR-032 al quitar medios**: el formulario vuelve a mostrar los medios tal como
  estaban guardados, no como los dejó el operador, para que no parezca que se han quitado.
- **Navegador sin JavaScript**: quitar un medio MUST funcionar también sin JavaScript, igual que
  el resto del panel, aunque sea con un paso más (por ejemplo, marcar el medio para quitarlo y
  guardar).
- **Enlace a mapa sin dirección**: se permite guardar. La dirección sigue siendo opcional y no
  se genera ningún aviso nuevo.
- **Enlace a mapa sin protocolo** (por ejemplo, `maps.example.com/abc`): se rechaza con un
  mensaje que pide el enlace completo, empezando por `https://`.
- **Enlace a un sitio que no es un mapa**: el sistema no puede comprobarlo y lo guarda. Es
  responsabilidad del operador, que puede abrirlo desde el panel para revisarlo.
- **Mensaje de contacto sin JavaScript**: el mensaje de US2 MUST mostrarse igual con JavaScript
  activado o desactivado.

## Requirements *(mandatory)*

### Functional Requirements

**Derivación**

- **FR-001**: El operador MUST poder quitar cualquier medio del contacto de derivación desde la
  pantalla de Derivación con una acción visible en cada medio. La eliminación se hace efectiva
  al guardar el formulario.
- **FR-002**: Quitar todos los medios MUST dejar el negocio sin contacto de derivación
  configurado, con lo que se aplica FR-019 de la feature 001 (se usa el teléfono del negocio).
- **FR-003**: Quitar medios MUST seguir protegido por FR-032 de la feature 001. Si el cambio se
  rechaza, el formulario MUST mostrar los medios que siguen guardados.
- **FR-004**: La acción de quitar MUST funcionar sin JavaScript.

**Contacto que usa el bot**

- **FR-005**: Las pantallas de Datos y de Derivación MUST mostrar el contacto que usa el bot en
  ese momento para pasar la conversación a una persona y su origen: contacto configurado,
  teléfono del negocio o ninguno.
- **FR-006**: Al guardar Datos o Derivación, si cambia el origen o el valor del contacto que usa
  el bot, el mensaje de confirmación MUST indicarlo. Por ejemplo: "Guardado. El bot pasará las
  conversaciones al contacto de derivación configurado".
- **FR-007**: Si el cambio deja un negocio en preparación sin salida a una persona, el mensaje de
  confirmación MUST decirlo y recordar que el negocio no se podrá activar hasta tenerla.

**Pantallas de registro único y portada**

- **FR-008**: Las pantallas de Políticas, Tono y Derivación MUST incluir un texto que explique que
  el negocio tiene un único registro de ese tipo y que al guardar se sustituye el anterior. La de
  Derivación MUST explicar también cómo añadir y quitar medios.
- **FR-009**: La portada MUST mostrar junto a Políticas, Tono y Derivación un resumen de su
  estado. Si no hay nada registrado, muestra "Sin configurar". Si hay datos, muestra un resumen
  breve de lo registrado: número de formas de pago y si hay política de cancelación; forma de
  trato; número de medios de derivación, o que se usa el teléfono del negocio.

**Ubicación**

- **FR-010**: El campo "Cómo llegar" MUST incluir un texto de ayuda que explique que el bot envía
  su contenido al preguntar por la ubicación, con un ejemplo genérico válido para cualquier
  sector.
- **FR-011**: Los datos del negocio MUST incluir un campo opcional "Enlace a mapa", editable desde
  la pantalla de Datos.
- **FR-012**: El sistema MUST aceptar en "Enlace a mapa" solo enlaces web completos (`http://` o
  `https://`) de 500 caracteres como máximo, y rechazar el resto con el error junto al campo.
  MUST NOT limitarlo a un proveedor de mapas concreto.
- **FR-013**: Cuando hay un enlace guardado, el panel MUST permitir abrirlo en una pestaña nueva
  desde el formulario.
- **FR-014**: La vista de la información que recibe el bot MUST incluir el enlace a mapa junto a
  la dirección y las indicaciones, o indicar que no hay enlace si no está registrado. Cualquier
  cambio MUST aplicarse a la siguiente respuesta del bot, sin reiniciar (FR-021 de la feature
  001).
- **FR-015**: No tener enlace a mapa MUST NOT generar ningún aviso.

**Documentación**

- **FR-016**: La guía de validación de la feature 001 MUST explicar cómo eliminar el contacto de
  derivación desde el panel e incluir pasos para comprobar FR-001 a FR-015.

### Key Entities *(include if feature involves data)*

- **Negocio** (ampliado): se añade el **enlace a mapa**, opcional. Es un enlace web a la ubicación
  del negocio en cualquier servicio de mapas.
- **Contacto que usa el bot** (derivado, no se guarda): el contacto al que el bot pasa la
  conversación y su origen (configurado, teléfono del negocio o ninguno). Se calcula a partir del
  contacto de derivación y del teléfono del negocio.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Una persona que no conoce el panel completa el escenario 6 de la guía de
  validación sin ayuda y sin falsos fallos, en menos de 5 minutos.
- **SC-002**: Quitar un medio de derivación se hace en 2 acciones como máximo: quitarlo y
  guardar.
- **SC-003**: En el 100 % de los guardados de Datos y Derivación que cambian el contacto que usa
  el bot, el operador ve un mensaje con el nuevo contacto y su origen.
- **SC-004**: Desde la portada, el operador sabe si Políticas, Tono y Derivación están
  configuradas sin entrar en ellas.
- **SC-005**: El enlace a mapa aparece en la información del bot en la primera consulta después
  de guardarlo, sin reiniciar.

## Assumptions

- La feature 001 (base de conocimiento) está terminada y esta spec solo amplía su panel y su
  modelo. Se mantienen sus reglas: FR-019 (uso del teléfono del negocio), FR-032 (protección del
  negocio activo) y el cálculo de avisos sin guardarlos.
- El uso del enlace a mapa en las respuestas del bot corresponde a la feature 002 (bot de
  preguntas frecuentes por WhatsApp). Esta spec solo lo pone a disposición del bot. La spec 002
  MUST actualizarse para que la respuesta de ubicación incluya el enlace cuando exista, ya que
  todavía no está implementada.
- No se muestra ningún mapa dentro del panel ni se envían mensajes de ubicación nativos de
  WhatsApp (con coordenadas). Solo se guarda y se ofrece el enlace. Las coordenadas quedan
  fuera de alcance.
- El sistema no comprueba que el enlace lleve a un mapa ni que exista. Solo valida su formato.
- El resumen de la portada usa los mismos datos que ya se cargan para calcular los avisos. No
  necesita información nueva.
- No se cambia el modelo de Políticas ni de Derivación: siguen siendo registros únicos. Si más
  adelante hacen falta varias políticas o varios contactos (por ejemplo, por servicio), será
  otra spec.

---

## Hallazgos posteriores (2026-09-25, validación de la feature 004)

Anotados al recorrer el escenario 1 del quickstart de la 004 ("Probar el bot"). Ninguno está
todavía convertido en historia de usuario ni en requisito; quedan aquí para decidirlo cuando
esta spec pase a plan.

### H1 — El panel no avisa de que una FAQ contradice un dato estructurado (candidato a esta spec)

Con `payment_methods = {Efectivo}` y la FAQ "¿Aceptáis tarjeta? → Sí.", el bot contesta que el
único método registrado es el efectivo. Es el comportamiento especificado (regla 5 del prompt de
la 002: ante contradicción prevalece el dato estructurado), pero el operador cree haber
contestado la duda en las FAQ y nunca se le dice que esa FAQ no se está usando.

Encaja con el contexto de esta spec ("el sistema se comporta según su spec, pero el panel no
explica lo que pasa"). La forma natural sería un aviso no crítico de `computeWarnings` sobre la
FAQ, con enlace al dato estructurado que prevalece.

### H2 — El bot repite el bloque de contacto (necesita spec propia)

Al pedir hablar con una persona, la respuesta trae el teléfono y el horario de atención dos
veces: una en el texto del modelo y otra en el bloque que añade el código. Causas:

- El prompt manda dos cosas que chocan: no escribir datos de contacto porque el sistema añade el
  bloque, y, en la petición de persona, responder que se le facilita el contacto.
- `compose()` en `src/conversation/responder.ts` añade `contactBlock(snapshot)` sin comprobar si
  el texto del modelo ya lo trae.
- El verificador de cifras no lo frena, y es correcto: el teléfono de derivación sí figura en el
  snapshot, así que es redundancia, no invención.

**No encaja en esta spec**: es un defecto de la composición de respuestas de la 002, no de la
claridad del panel. Debería ser una spec de núcleo aparte que arregle las dos capas (instrucción
del prompt y comprobación determinista antes de añadir el bloque).
