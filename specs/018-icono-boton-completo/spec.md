# Feature Specification: Icono del botón a tamaño completo y datos que el bot no ha guardado

**Feature Branch**: `018-icono-boton-completo`

**Created**: 2026-10-30

**Status**: Draft

**Ámbito**: núcleo (genérico, aplica a todos los clientes)

**Input**: User description: "Dos cambios pequeños del núcleo que salen juntos en la misma versión. (1) El icono propio del botón flotante del chat web rellena todo el botón, recortado con su forma, y solo queda un borde fino del color principal; hoy se dibuja siempre a la mitad del botón y no se reconoce un logo. Sin opción en el panel: se aplica a todas las instancias con icono propio, y las que no lo tienen no cambian. (2) El bot nunca dice que ha anotado, guardado o pasado los datos del cliente ni que el negocio le llamará: solo el sistema lo confirma cuando crea de verdad una derivación. Hoy, si el cliente da su nombre y teléfono sin que se los pidan, el modelo puede contestar 'He anotado tus datos para que el centro se ponga en contacto contigo' sin que se haya avisado a nadie."

## Contexto

Dos problemas vistos al dar de alta una instancia de prueba, los dos genéricos y pequeños, que se
corrigen en la misma versión del núcleo para desplegar una sola vez.

**1. El icono del botón no se reconoce.** La 011 permitió subir un icono propio para el botón
flotante, y lo muestra siempre pequeño en el centro (más o menos la mitad del ancho del botón),
rodeado del color principal (FR-030a de la 011). Los negocios suben como icono su **logo**, y a ese
tamaño no se reconoce. A partir de esta feature el icono rellena el botón y del color principal solo
queda un borde fino, que sigue marcando el contorno del botón sobre la web del negocio.

No se añade una opción en el panel: hoy todos los iconos propios son logos, y las instancias sin
icono propio no cambian. Si un negocio necesitara el icono pequeño, se añadiría entonces una opción
(una feature aparte).

**2. El bot promete un contacto que nadie va a hacer.** El bot no guarda datos ni avisa a nadie por
su cuenta: cuando hay derivación, es el **sistema** quien pide el nombre y el teléfono, crea la
derivación, avisa al negocio y lo confirma al cliente («He avisado a…»). Pero si el cliente escribe
su nombre y teléfono sin que se los pidan, el modelo puede responder «He anotado tus datos para que
el centro se ponga en contacto contigo». No se ha guardado nada ni se ha avisado a nadie, y el
cliente se queda esperando una llamada que no llega. Es un compromiso falso en nombre del negocio
(Principio IV) y deja al cliente sin la salida real a una persona (Principio V).

Hoy se evita con un párrafo en el tono de cada instancia. Esta feature lo lleva a las reglas comunes
del bot, para todas las instancias, sin depender de que el operador lo recuerde.

### Límites del cambio

- No cambia el tamaño ni la posición del botón ni del chat, ni el logo de la cabecera, el avatar,
  los colores o los textos del diseño.
- No cambia la configuración del negocio: no hay datos nuevos, ni migración, ni cambio del formato
  de exportación e importación.
- No cambia el flujo de derivación: cuándo se ofrece, cómo se piden los datos, cómo se avisa al
  negocio ni los textos que confirma el sistema.
- El párrafo que ya tenga una instancia en su tono puede quedarse: dice lo mismo que la regla común.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - El logo del negocio se reconoce en el botón (Priority: P1)

Un visitante entra en la web de un negocio que ha subido su logo como icono del botón. Ve el logo
ocupando todo el botón, con un borde fino del color del chat, y lo reconoce como el chat de ese
negocio.

**Why this priority**: es lo que el negocio ve primero de su chat; un logo irreconocible le resta
confianza.

**Independent Test**: en una instancia con icono propio, cargar la web y comprobar que el icono
rellena el botón con un borde fino del color principal; en una sin icono, comprobar que el botón no
ha cambiado.

**Acceptance Scenarios**:

1. **Given** una instancia con icono propio, **When** se carga el chat en la web del negocio,
   **Then** el icono rellena el botón, recortado con su forma, y alrededor solo se ve un borde fino
   del color principal.
2. **Given** una instancia con icono propio y forma recta, suave o redondeada, **When** se carga el
   chat, **Then** la imagen y el borde siguen la forma del botón (cuadrada, con esquinas suaves o
   circular).
3. **Given** un icono que no es cuadrado, **When** se muestra, **Then** rellena el botón sin
   deformarse, recortando lo que sobra.
4. **Given** una instancia sin icono propio, **When** se carga el chat, **Then** el botón se ve
   exactamente igual que antes de esta feature.
5. **Given** un icono que no se puede cargar en el navegador del visitante, **When** se carga el
   chat, **Then** el botón muestra el icono original sobre el color principal, como hoy.
6. **Given** el panel, sección «Diseño del chat», **When** el operador sube o cambia el icono,
   **Then** la vista previa muestra el botón ya con el icono a tamaño completo.

---

### User Story 2 - El bot no promete un contacto que no ha pedido (Priority: P1)

Un cliente escribe su nombre y su teléfono sin que el bot se los haya pedido. El bot no dice que
los ha anotado ni que el negocio le llamará: le remite al negocio. Si después el cliente pide
hablar con una persona o acepta que le contacten, el sistema sigue su flujo de siempre y es él quien
confirma el aviso.

**Why this priority**: una promesa falsa de contacto deja al cliente sin atender sin que nadie lo
sepa; es el fallo más grave que puede tener el bot frente a un cliente.

**Independent Test**: en una conversación sin derivación, escribir nombre y teléfono sin que se
pidan y comprobar que la respuesta no afirma haberlos guardado ni promete una llamada; repetir
pidiendo hablar con una persona y comprobar que la derivación y su confirmación siguen igual.

**Acceptance Scenarios**:

1. **Given** una conversación sin derivación en curso, **When** el cliente escribe su nombre y su
   teléfono sin que se le hayan pedido, **Then** la respuesta no dice que se hayan anotado,
   guardado, registrado o pasado, ni que el negocio le llamará o contactará, y le remite al negocio.
2. **Given** el mismo caso, **When** el bot remite al negocio, **Then** el cliente sigue teniendo
   la salida a una persona del mecanismo configurado (contacto del negocio u oferta de derivación).
3. **Given** que el cliente pide hablar con una persona y da sus datos cuando el sistema se los
   pide, **When** se crea la derivación, **Then** el cliente recibe la confirmación del sistema («He
   avisado a…») igual que antes de esta feature.
4. **Given** cualquier conversación, **When** el bot responde, **Then** nunca afirma que el negocio
   contactará al cliente salvo en la confirmación que da el sistema tras crear una derivación.

### Edge Cases

- **Icono con fondo transparente**: lo transparente deja ver el color principal detrás, como hoy.
- **Icono de poca resolución**: se amplía y puede verse borroso; es cosa del icono que suba el
  operador, y el panel no lo bloquea.
- **Foco con el teclado**: el indicador de foco del botón sigue visible y la imagen no lo tapa.
- **Posición a la izquierda**: el icono se ve igual en las dos esquinas.
- **El cliente da sus datos en mitad de una derivación ya en curso**: sigue el flujo del sistema
  (es el sistema quien los recoge); la regla solo prohíbe que el modelo afirme por su cuenta haberlos
  guardado.
- **El cliente pregunta «¿me vais a llamar?»** sin derivación: el bot no lo promete; le remite al
  negocio o le ofrece el contacto según lo configurado.

## Requirements *(mandatory)*

### Functional Requirements

**Icono del botón**

- **FR-001**: Cuando hay icono propio, el icono MUST rellenar todo el botón flotante, recortado con
  la forma del botón y sin deformarse (recortando lo que sobre), dejando visible solo un borde fino
  del color principal alrededor de todo el contorno.
- **FR-002**: El borde MUST tener el mismo grosor con las tres formas del botón.
- **FR-003**: Sin icono propio, o si el icono no se puede cargar, el botón MUST verse exactamente
  igual que antes de esta feature.
- **FR-004**: El cambio MUST NOT alterar el tamaño ni la posición del botón, el tamaño del chat
  cerrado ni abierto, ni ningún otro elemento del diseño.
- **FR-005**: El botón MUST conservar su etiqueta accesible, su indicador de foco visible y su
  comportamiento al pulsarlo. La imagen sigue siendo decorativa.
- **FR-006**: La vista previa del diseño en el panel MUST mostrar el botón igual que lo verán los
  visitantes.

**Datos que el bot no ha guardado**

- **FR-007**: Las reglas comunes del bot MUST prohibirle afirmar que ha anotado, guardado,
  registrado o pasado datos del cliente, y prometer que el negocio le llamará o contactará. Esa
  confirmación solo la da el sistema cuando crea una derivación.
- **FR-008**: Si el cliente da sus datos sin que se le hayan pedido, el bot MUST remitirle al
  negocio sin comentar los datos, marcando que hay que remitir al negocio, para que el sistema
  añada el contacto o la oferta de derivación configurados.
- **FR-009**: La regla MUST aplicarse a todas las instancias sin depender de su tono, y MUST NOT
  cambiar el flujo de derivación ni los mensajes que da el sistema.
- **FR-010**: La regla MUST quedar cubierta por pruebas antes de dar la feature por terminada
  (constitución: los comportamientos de los Principios IV y V se prueban).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Con icono propio, el icono ocupa al menos el 85 % del ancho del botón, frente a más o
  menos el 50 % de antes.
- **SC-002**: Las instancias sin icono propio no muestran ningún cambio visible en el botón.
- **SC-003**: En la evaluación con el modelo real, en el 100 % de los casos en que el cliente da su
  nombre y teléfono sin que se los pidan, la respuesta no afirma haberlos guardado ni promete un
  contacto.
- **SC-004**: El 100 % de las derivaciones de prueba terminan con la confirmación del sistema, igual
  que antes.

## Assumptions

- El grosor del borde es fijo, de unos pocos píxeles; se fija en el plan.
- La sombra del botón se mantiene como hoy.
- La comprobación de SC-003 se hace con la evaluación del modelo real (`pnpm test:eval`), que tiene
  coste y va fuera de `pnpm test`; se lanza solo con permiso del operador.
- Enmienda en parte el FR-030a de la 011: el color principal del botón queda como borde cuando hay
  icono propio. El resto del FR-030a sigue (forma, tamaño, foco y etiqueta del botón).
- Ejemplo ilustrativo (no requisito): un centro cuyo icono es su logo circular sobre fondo blanco,
  con un borde fino de su color corporativo.
