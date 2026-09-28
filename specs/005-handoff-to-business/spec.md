# Feature Specification: Derivación de la conversación al negocio

**Feature Branch**: `005-handoff-to-business`

**Created**: 2026-09-28

**Status**: Draft

**Ámbito**: Núcleo

**Input**: User description: "Derivación de la conversación al negocio. Problema: hay consultas que el bot no puede resolver, y clientes que quieren hablar con una persona. Usuarios: cliente final y negocio. User stories: P1 el cliente pide hablar con una persona (el bot confirma que el negocio le contestará y el negocio recibe un aviso con el nombre, el número y un resumen del motivo); P1 el bot no puede resolver la consulta y el cliente acepta que le atienda el negocio (mismo aviso); P1 mientras el negocio atiende la conversación, el bot no responde en ella; P2 la conversación vuelve al bot cuando el negocio lo indica o tras [TBD: tiempo] sin actividad; P2 si la derivación ocurre fuera de horario, el bot indica cuándo le contestarán (próxima franja de apertura); P2 una queja o reclamación se deriva siempre, sin intentar resolverla. Casos límite: el cliente pide una persona en mitad de otra gestión; el negocio no contesta en [TBD: tiempo]; el cliente vuelve a escribir tras volver la conversación al bot. Fuera de alcance: panel de chat para el negocio, varios agentes y métricas de atención."

## Contexto

Hasta ahora, cuando el cliente pide hablar con una persona o el bot no tiene el dato, el bot le da
el contacto de derivación del negocio (spec 002, FR-015 a FR-017) y es el cliente quien tiene que
dar el paso. Esta feature convierte esa salida en una **derivación activa**: el bot avisa al
negocio con lo necesario para contestar, deja de responder en esa conversación mientras el negocio
la atiende y la recupera después. Se aplica igual en todos los canales (WhatsApp y chat web), como
exige la constitución, y sustituye el supuesto de la spec 002 que dejaba la derivación activa
fuera de alcance.

## Clarifications

### Session 2026-09-28

- Q: ¿Cómo recibe el aviso el negocio, desde dónde contesta al cliente y cómo indica que ha
  terminado? → A: Por dos vías siempre que sea posible, para que todo quede registrado en ambas:
  WhatsApp (desde el número del bot al WhatsApp del negocio) y email. El negocio contesta al
  cliente por sus propios medios (llamada o mensaje desde su teléfono). Los mensajes que el
  cliente escribe durante la derivación se reenvían por las mismas vías. El negocio confirma que
  atiende y da por terminada la derivación respondiendo al aviso de WhatsApp o con los enlaces del
  email.
- Q: ¿Qué plazos rigen la derivación? → A: La conversación vuelve al bot tras 24 horas sin
  mensajes del cliente. Si el negocio no confirma que atiende en 2 horas contadas dentro de su
  horario de atención, se le envía un recordatorio (una vez) y el bot da al cliente el contacto
  directo del negocio.
- Q: ¿Cómo indica el negocio por WhatsApp si confirma que atiende o si da por terminada la
  derivación, y cómo se sabe a qué derivación se refiere cuando hay varias activas? → A: El aviso,
  el recordatorio y los mensajes reenviados llevan dos botones, "Le atiendo" y "Terminado", ligados
  a esa derivación. Si el negocio escribe texto libre, recibe una ayuda breve y no cambia nada.
- Q: En el chat web, ¿qué ve el visitante que escribe durante una derivación, si el bot no
  responde? → A: Un aviso fijo de la interfaz mientras dure la derivación (el negocio le contactará
  en el teléfono que ha dado y lo que escriba también le llega). No es un mensaje del bot.
- Q: ¿Puede el operador ver y terminar derivaciones activas desde el panel, fuera de "Probar el
  bot"? → A: Sí: el panel lista las derivaciones activas (sin textos de mensajes) y permite
  terminarlas.
- Q: ¿Avisa el bot al cliente cuando la conversación vuelve al bot? → A: No; la vuelta es
  silenciosa. En el chat web desaparece el aviso fijo de derivación.
- Q: Si el cliente envía varios mensajes seguidos durante la derivación, ¿se reenvía cada uno por
  separado? → A: No; se agrupan como los mensajes normales (spec 002, FR-004) y se reenvía un
  único mensaje por grupo.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - El cliente pide hablar con una persona (Priority: P1)

Un cliente final, en cualquier momento de la conversación, dice que quiere hablar con alguien del
negocio. El bot le confirma que el negocio le contestará y el negocio recibe un aviso con el
nombre del cliente, su número de contacto y un resumen breve del motivo, sacado de la
conversación.

**Why this priority**: es la garantía del Principio V (siempre hay salida a una persona) llevada
a su forma útil: el negocio se entera sin que el cliente tenga que repetir su consulta por otro
medio.

**Independent Test**: con un negocio activo y al menos una vía de aviso disponible, escribir por
WhatsApp una pregunta de precio y después "quiero hablar con una persona"; comprobar la
confirmación al cliente y que el negocio recibe un único aviso con nombre, número y un motivo que
menciona la consulta de precio.

**Acceptance Scenarios**:

1. **Given** un negocio activo, dentro de su horario de atención, y un cliente que escribe por
   WhatsApp, **When** el cliente pide hablar con una persona, **Then** el bot le confirma que el
   negocio le contestará y el negocio recibe un aviso con el nombre del cliente, su número y un
   resumen del motivo.
2. **Given** un cliente cuyo canal no proporciona su nombre, **When** pide hablar con una
   persona, **Then** el bot le pide el nombre antes de avisar al negocio, y el aviso incluye el
   nombre que haya dado.
3. **Given** un visitante del chat web (anónimo), **When** pide hablar con una persona, **Then**
   el bot le pide un nombre y un teléfono de contacto, y el aviso se envía con esos datos.
4. **Given** un visitante web que no quiere dar un teléfono, **When** se niega, **Then** el bot
   no avisa al negocio y le facilita el contacto de derivación del negocio (como en la spec 002).
5. **Given** un cliente que pide una persona sin explicar para qué, **When** se envía el aviso,
   **Then** el motivo resume la conversación previa o, si no la hay, indica que el cliente pidió
   hablar con una persona sin dar el motivo.

---

### User Story 2 - El bot no puede resolver y el cliente acepta la derivación (Priority: P1)

El cliente pregunta algo que no está registrado o que el bot no puede gestionar. En lugar de solo
darle el contacto, el bot le ofrece que le atienda el negocio. Si el cliente acepta, se produce la
misma derivación que en la historia 1.

**Why this priority**: es el caso más frecuente de consulta perdida: el cliente recibe un "no lo
sé" y se va. Ofrecer la derivación convierte esas consultas en contactos para el negocio.

**Independent Test**: preguntar algo sin dato registrado, aceptar la oferta y comprobar que el
aviso del negocio incluye esa pregunta en el motivo; repetir rechazando la oferta y comprobar que
no hay aviso.

**Acceptance Scenarios**:

1. **Given** una pregunta sobre el negocio sin dato registrado, **When** el bot responde,
   **Then** dice que no dispone de esa información (spec 002, FR-015) y ofrece que le atienda el
   negocio.
2. **Given** la oferta de derivación, **When** el cliente acepta, **Then** ocurre lo mismo que en
   la historia 1 y el motivo del aviso recoge la pregunta sin resolver.
3. **Given** la oferta de derivación, **When** el cliente la rechaza o cambia de tema, **Then** no
   se avisa al negocio y el bot sigue atendiendo con normalidad.
4. **Given** una petición que el bot no puede gestionar por este medio (por ejemplo, reservar una
   cita), **When** el bot responde, **Then** ofrece también la derivación.

---

### User Story 3 - El bot calla mientras el negocio atiende (Priority: P1)

Desde que se deriva una conversación hasta que vuelve al bot, los mensajes del cliente en esa
conversación no reciben respuesta automática: los atiende el negocio.

**Why this priority**: sin esto, el bot y el negocio se pisan y el cliente recibe respuestas
contradictorias; la derivación deja de tener sentido.

**Independent Test**: derivar una conversación, enviar varios mensajes más desde el cliente y
comprobar que el bot no contesta ninguno y que el negocio los recibe.

**Acceptance Scenarios**:

1. **Given** una conversación derivada, **When** el cliente escribe, **Then** el bot no responde.
2. **Given** una conversación derivada, **When** el cliente escribe, **Then** el negocio recibe
   ese mensaje reenviado por las mismas vías que el aviso (WhatsApp y email), identificando al
   cliente; si el cliente envía varios mensajes seguidos, se agrupan y se reenvían en un único
   mensaje.
3. **Given** una conversación derivada de un cliente, **When** otro cliente escribe al bot,
   **Then** el bot atiende al otro cliente con normalidad: la derivación afecta solo a esa
   conversación.
4. **Given** una conversación derivada, **When** el cliente vuelve a pedir una persona o insiste
   en que le contesten, **Then** no se genera un aviso nuevo ni respuesta automática.
5. **Given** una conversación derivada en el chat web, **When** el visitante la tiene abierta o
   escribe, **Then** el chat muestra un aviso fijo indicando que el negocio le contactará en el
   teléfono que ha dado y que lo que escriba también le llega, sin ningún mensaje del bot.

---

### User Story 4 - La conversación vuelve al bot (Priority: P2)

La derivación termina cuando el negocio indica que ha acabado o cuando pasa un tiempo sin
actividad. A partir de ahí, el siguiente mensaje del cliente lo contesta el bot.

**Why this priority**: sin vuelta, una conversación derivada se queda muda para siempre si el
negocio olvida cerrarla. Es P2 porque el valor principal (avisar y callar) ya existe sin ella.

**Independent Test**: derivar una conversación, marcarla como terminada desde el lado del negocio
y comprobar que el siguiente mensaje del cliente lo contesta el bot; repetir dejando pasar el
tiempo de inactividad.

**Acceptance Scenarios**:

1. **Given** una conversación derivada, **When** el negocio pulsa "Terminado" en un mensaje de
   WhatsApp de esa derivación o usa el enlace del email, **Then** el siguiente mensaje del cliente
   lo contesta el bot.
2. **Given** dos derivaciones activas de clientes distintos, **When** el negocio pulsa "Terminado"
   en el aviso de una de ellas, **Then** solo termina esa derivación.
3. **Given** una conversación derivada, **When** el negocio escribe texto libre al número del bot
   en lugar de pulsar un botón, **Then** recibe una ayuda breve sobre cómo usar los botones y
   ninguna derivación cambia de estado.
4. **Given** una conversación derivada, **When** pasan 24 horas sin mensajes del cliente,
   **Then** vuelve al bot.
5. **Given** una derivación activa, **When** el operador la termina desde el panel, **Then** el
   siguiente mensaje del cliente lo contesta el bot.
6. **Given** una derivación que termina por cualquier causa, **When** termina, **Then** el bot no
   envía ningún mensaje al cliente y, en el chat web, desaparece el aviso fijo de derivación.
7. **Given** una conversación que ha vuelto al bot, **When** el cliente escribe, **Then** el bot
   responde sin repetir el saludo inicial si la conversación sigue abierta (spec 002, FR-021) y
   sin volver a derivar por el motivo anterior salvo que el cliente lo pida.

---

### User Story 5 - Derivación fuera de horario (Priority: P2)

Si la derivación ocurre cuando el negocio no atiende, el bot le dice al cliente cuándo le
contestarán, con la próxima franja de apertura.

**Why this priority**: evita la sensación de abandono cuando el cliente escribe de noche o en un
día de cierre; la derivación funciona sin esto, pero con peor experiencia.

**Independent Test**: derivar un sábado por la noche en un negocio que abre el lunes a las 9:00 y
comprobar que la confirmación menciona el lunes a las 9:00.

**Acceptance Scenarios**:

1. **Given** un negocio cerrado en este momento, **When** se deriva una conversación, **Then** la
   confirmación al cliente incluye el día y la hora de la próxima franja de atención.
2. **Given** un cierre puntual registrado para mañana, **When** se deriva la víspera por la tarde,
   **Then** la próxima franja que se da es la primera posterior al cierre.
3. **Given** un negocio abierto en este momento, **When** se deriva, **Then** la confirmación no
   menciona horarios.
4. **Given** una derivación fuera de horario, **When** se envía el aviso al negocio, **Then** se
   envía en el momento, sin esperar a la apertura.

---

### User Story 6 - Las quejas se derivan siempre (Priority: P2)

Cuando el cliente presenta una queja o reclamación, el bot no intenta resolverla ni justificarla:
la deriva directamente al negocio.

**Why this priority**: una queja mal gestionada por un bot daña más al negocio que no contestar;
pero su volumen es bajo frente a las historias P1.

**Independent Test**: escribir "quiero poner una reclamación, el corte me lo hicieron mal" y
comprobar que el bot no da explicaciones ni soluciones, confirma la derivación y el aviso indica
que es una queja.

**Acceptance Scenarios**:

1. **Given** un cliente que presenta una queja o reclamación, **When** el bot responde, **Then**
   no intenta resolverla, justificarla ni dar información sobre ella, y deriva la conversación sin
   pedir que el cliente acepte.
2. **Given** una queja, **When** se envía el aviso, **Then** el motivo indica que es una queja o
   reclamación y resume su contenido.
3. **Given** un comentario negativo que no es una queja (por ejemplo, "qué caro"), **When** el bot
   responde, **Then** no se considera queja y el bot atiende con normalidad.

---

### Edge Cases

- **Petición de persona en mitad de otra gestión**: la derivación tiene prioridad sobre cualquier
  intercambio en curso (Principio V). El intercambio pendiente se abandona y el motivo del aviso
  lo recoge.
- **Varios mensajes seguidos que incluyen la petición**: se agrupan como hasta ahora (spec 002,
  FR-004) y se genera un único aviso.
- **El negocio no contesta**: si no confirma que atiende en 2 horas contadas dentro de su horario
  de atención, recibe un recordatorio (una sola vez) y el bot da al cliente el contacto directo del
  negocio. La conversación sigue derivada: el bot no vuelve a responder hasta que termine la
  derivación (FR-017, FR-019).
- **El negocio olvida terminar y avisa al operador**: el operador puede terminar la derivación
  desde el panel (FR-016a).
- **El negocio escribe texto libre al número del bot**: recibe una ayuda breve; no se trata como
  mensaje de cliente ni cambia ninguna derivación (FR-008b).
- **Botón o enlace de una derivación ya terminada**: no tiene efecto.
- **Solo una vía disponible**: si la instancia no tiene WhatsApp configurado o el negocio no tiene
  email de avisos, el aviso se envía por la vía que exista; basta con que se entregue por una.
- **Una vía falla y la otra no**: la derivación sigue adelante y el fallo queda registrado.
- **El cliente vuelve a escribir tras volver la conversación al bot**: lo atiende el bot con
  normalidad (historia 4). Si vuelve a pedir una persona, es una derivación nueva con su propio
  aviso.
- **El aviso no puede entregarse al negocio**: el bot no confirma que le contestarán; le facilita
  el contacto de derivación (spec 002, FR-016) y la conversación no queda derivada.
- **Ninguna vía de aviso disponible**: el bot mantiene el comportamiento de la spec 002 (da el
  contacto de derivación) y el panel muestra un aviso normal (no crítico) al operador.
- **Negocio "en preparación"**: no hay bot ni, por tanto, derivación (spec 002, FR-002).
- **"Probar el bot" del panel**: la derivación se simula; el aviso no llega al negocio, se muestra
  al operador en la información técnica de la respuesta, y el operador puede terminar la
  derivación para seguir probando.
- **Límite de mensajes por cliente o tope del chat web alcanzado**: la petición de persona sigue
  atendiéndose con el aviso con el contacto de esos límites (spec 002, FR-004a; spec 004); los
  mensajes que el cliente envía durante la derivación cuentan para el límite por cliente.
- **La conversación derivada caduca** (30 días sin mensajes): se borra como cualquier otra, y con
  ella el estado de derivación.
- **Cliente que escribe por WhatsApp y por la web**: son dos conversaciones independientes (spec
  004); derivar una no afecta a la otra.

## Requirements *(mandatory)*

### Functional Requirements

**Inicio de la derivación**

- **FR-001**: Si el cliente pide hablar con una persona del negocio, en cualquier momento y en
  cualquier canal, el bot MUST iniciar una derivación. Esto sustituye el comportamiento de la
  spec 002 (FR-017) cuando la derivación es posible (FR-012).
- **FR-002**: Cuando el bot no puede responder porque el dato no está registrado (spec 002,
  FR-015) o porque la petición no se gestiona por este medio (spec 002, FR-018), MUST ofrecer al
  cliente que le atienda el negocio, e iniciar la derivación solo si el cliente acepta.
- **FR-003**: Ante una queja o reclamación, el bot MUST iniciar la derivación sin pedir
  aceptación y MUST NOT intentar resolverla, justificarla ni aportar información sobre ella.
- **FR-004**: Para iniciar una derivación, el sistema MUST disponer de un nombre y de un medio de
  contacto del cliente. Si el canal los proporciona (en WhatsApp, el número y el nombre de perfil),
  se usan; si falta alguno, el bot MUST pedirlo en una sola pregunta. Si el cliente no lo facilita,
  el bot MUST darle el contacto de derivación (spec 002, FR-016) y no iniciar la derivación.
- **FR-005**: El teléfono que facilite un cliente MUST validarse como teléfono y guardarse en
  formato internacional; si no es válido, el bot MUST pedirlo de nuevo una sola vez.

**Aviso al negocio**

- **FR-006**: Al iniciarse una derivación, el sistema MUST enviar al negocio un único aviso con: el
  nombre del cliente, su teléfono de contacto, el canal por el que escribe, el tipo de derivación
  (petición de persona, consulta sin resolver o queja) y un resumen breve del motivo sacado de la
  conversación.
- **FR-007**: El resumen del motivo MUST basarse solo en lo que el cliente ha escrito en la
  conversación y MUST NOT añadir datos que el cliente no haya dado.
- **FR-008**: El aviso MUST enviarse por todas las vías disponibles de las dos previstas:
  WhatsApp (desde el número del bot al WhatsApp de avisos del negocio) y email (al email de avisos
  del negocio). Una vía está disponible si el operador ha configurado su destino y, en el caso de
  WhatsApp, la instancia tiene el canal de WhatsApp configurado. El aviso se considera entregado si
  llega por al menos una vía.
- **FR-008a**: El aviso MUST indicar al negocio que contacte con el cliente por sus propios medios
  y cómo confirmar que lo atiende y cómo dar por terminada la derivación. Por WhatsApp, el aviso,
  el recordatorio y cada mensaje reenviado del cliente MUST llevar dos botones, "Le atiendo" y
  "Terminado", que actúan solo sobre la derivación de ese mensaje. Por email, MUST llevar dos
  enlaces equivalentes, que MUST funcionar sin iniciar sesión y solo para esa derivación.
- **FR-008b**: Si el negocio escribe texto libre al número del bot en lugar de pulsar un botón, el
  sistema MUST contestarle con una ayuda breve sobre los botones y MUST NOT cambiar el estado de
  ninguna derivación ni tratar ese mensaje como de un cliente.
- **FR-009**: El aviso MUST enviarse en el momento de la derivación, también fuera del horario del
  negocio.

**Confirmación al cliente**

- **FR-010**: Cuando el aviso se ha entregado, el bot MUST confirmar al cliente que el negocio le
  contestará. Si el negocio está fuera de su horario de atención en ese momento, la confirmación
  MUST incluir el día y la hora de inicio de la próxima franja de atención.
- **FR-011**: La próxima franja de atención MUST calcularse con el horario del contacto de
  derivación si está registrado (spec 001, FR-018) y, si no, con el horario semanal del negocio,
  teniendo en cuenta los cierres puntuales y la zona horaria del negocio.
- **FR-012**: Si no hay ninguna vía de aviso disponible o el aviso no se entrega por ninguna, el
  bot MUST NOT confirmar que le contestarán y MUST facilitar el contacto de derivación (spec 002,
  FR-016). La conversación no queda derivada.

**Durante la derivación**

- **FR-013**: Mientras una conversación está derivada, el bot MUST NOT generar respuestas
  automáticas en ella, tampoco saludos, avisos de tipo de mensaje no atendido ni ofertas de
  derivación.
- **FR-013a**: Mientras una conversación del chat web está derivada, el chat MUST mostrar un aviso
  fijo de la interfaz (no un mensaje del bot) que indique que el negocio contactará al visitante
  en el teléfono que ha dado y que lo que escriba también le llega. El aviso MUST desaparecer al
  terminar la derivación.
- **FR-014**: Mientras una conversación está derivada, los mensajes nuevos del cliente MUST
  reenviarse al negocio por las mismas vías que el aviso, identificando al cliente y la
  derivación, sin generar avisos de derivación nuevos. Los mensajes seguidos MUST agruparse como
  los mensajes normales (spec 002, FR-004) y reenviarse en un único mensaje por grupo.
- **FR-015**: La derivación MUST afectar solo a la conversación derivada; el bot sigue atendiendo
  el resto de conversaciones de la instancia.

**Fin de la derivación**

- **FR-016**: El negocio MUST poder confirmar que atiende una derivación y MUST poder indicar que
  ha terminado, sin acceso al panel del operador, con los botones de WhatsApp o los enlaces del
  email (FR-008a). Terminar implica también confirmar. Si se indica por las dos vías, solo cuenta
  la primera; pulsar un botón o enlace de una derivación ya terminada no tiene efecto.
- **FR-016a**: El operador MUST poder ver en el panel las derivaciones activas (cliente, canal,
  tipo, inicio y si están confirmadas, sin textos de mensajes) y MUST poder terminar cualquiera
  de ellas.
- **FR-017**: Una conversación derivada MUST volver al bot tras 24 horas sin mensajes del cliente,
  haya confirmado o no el negocio.
- **FR-018**: Al terminar una derivación, por cualquier causa, el bot MUST NOT enviar ningún
  mensaje al cliente. Una vez de vuelta, el siguiente mensaje del cliente MUST contestarlo el bot,
  que MUST tener en cuenta la conversación anterior sin volver a derivar por el mismo motivo salvo
  que el cliente lo pida.
- **FR-019**: Si el negocio no confirma que atiende la derivación en 2 horas contadas solo dentro
  de su horario de atención (FR-011), el sistema MUST enviarle un recordatorio por las mismas vías
  que el aviso, una sola vez por derivación, y el bot MUST enviar al cliente un único mensaje con
  el contacto de derivación del negocio (spec 002, FR-016) para que pueda contactar directamente.
  La conversación sigue derivada.

**Configuración, pruebas y registros**

- **FR-020**: El operador MUST poder configurar en el panel los destinos de los avisos de
  derivación del negocio: un WhatsApp (teléfono) y un email, ambos opcionales. Si no hay ninguna
  vía disponible, el panel MUST mostrar un aviso de gravedad normal (no bloquea la activación del
  negocio, porque el bot sigue dando el contacto de derivación); si solo hay una, MUST mostrar un
  aviso normal que recomiende configurar la otra.
- **FR-021**: En "Probar el bot", la derivación MUST simularse: el aviso MUST NOT enviarse al
  negocio y MUST mostrarse al operador en la información técnica de la respuesta, y el operador
  MUST poder terminar la derivación de la conversación de prueba.
- **FR-022**: El sistema MUST registrar la actividad técnica de las derivaciones (inicio, tipo,
  entrega o fallo del aviso, fin y su causa) sin textos de mensajes, nombres ni identificadores de
  cliente en claro, como el resto de registros (spec 002, FR-030a).
- **FR-023**: Los datos de contacto que el cliente facilite y el estado de derivación MUST formar
  parte de la conversación y borrarse con ella (spec 002, FR-030).
- **FR-024**: Ningún texto, regla ni comportamiento de la derivación MUST depender del sector o
  del cliente.

### Key Entities

- **Derivación**: periodo en el que una conversación la atiende el negocio y no el bot. Tiene
  tipo (petición de persona, consulta sin resolver, queja), momento de inicio, resumen del motivo,
  estado (activa o terminada), si el negocio la ha confirmado y cuándo, si se envió el
  recordatorio, y causa del fin (indicada por el negocio, inactividad, operador desde el panel u
  operador en pruebas). Una conversación tiene como mucho una derivación activa.
- **Aviso de derivación**: mensaje que recibe el negocio al iniciarse una derivación, por cada vía
  disponible. Contiene nombre y teléfono del cliente, canal, tipo, resumen del motivo, los botones
  (WhatsApp) o enlaces (email) para confirmar y terminar esa derivación, y el resultado de la
  entrega por vía. Los recordatorios y los mensajes reenviados del cliente van por las mismas vías
  y llevan los mismos botones o enlaces.
- **Datos de contacto del cliente**: nombre y teléfono del cliente final, obtenidos del canal o
  pedidos por el bot; pertenecen a la conversación.
- **Destinos de avisos**: WhatsApp y email del negocio a los que se envían los avisos de
  derivación; los configura el operador. Como mucho uno de cada por negocio.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: El 100 % de las peticiones de hablar con una persona, en cualquier punto de la
  conversación y en cualquier canal, termina en un aviso al negocio o, si no es posible, en el
  contacto de derivación.
- **SC-002**: El negocio recibe el aviso por al menos una vía en menos de 1 minuto desde que el
  cliente completa la petición (incluidos, si hacían falta, su nombre y teléfono).
- **SC-003**: En una evaluación con el negocio leyendo solo el aviso, al menos el 90 % de los
  avisos permite identificar al cliente y el motivo sin consultar la conversación, y ninguno
  contiene datos que el cliente no haya dado.
- **SC-004**: El 0 % de los mensajes que un cliente envía en una conversación derivada recibe
  respuesta automática.
- **SC-005**: El 100 % de las derivaciones fuera de horario indica la próxima franja de atención
  correcta, incluidos los casos con cierres puntuales.
- **SC-006**: En una evaluación con quejas y comentarios negativos que no lo son, al menos el 95 %
  de las quejas se deriva sin intento de resolverla y al menos el 90 % de los comentarios que no
  son queja se atiende con normalidad.
- **SC-007**: El 100 % de las consultas sin dato registrado incluye la oferta de derivación cuando
  hay al menos una vía de aviso disponible.
- **SC-008**: El 100 % de las conversaciones derivadas vuelve al bot como mucho 24 horas después
  del último mensaje del cliente.
- **SC-009**: El 100 % de las derivaciones no confirmadas en 2 horas de horario de atención genera
  un único recordatorio al negocio y un único mensaje al cliente con el contacto del negocio.
- **SC-010**: El 100 % de las pulsaciones de "Le atiendo" o "Terminado" cambia solo la derivación
  a la que pertenece el mensaje, también con varias derivaciones activas a la vez.

## Assumptions

- Los avisos van a un único destinatario, el negocio (un WhatsApp y un email como mucho); varios
  agentes, reparto o asignación de conversaciones quedan fuera de alcance, como pide la
  descripción.
- No hay panel de chat para el negocio: el negocio atiende al cliente por medios propios (su
  teléfono) y se relaciona con el sistema solo a través del aviso de WhatsApp y del email. La
  lista de derivaciones activas del panel (FR-016a) es para el operador, no para el negocio, y no
  muestra mensajes.
- Los avisos por WhatsApp los inicia el sistema fuera de la conversación con el cliente; cumplir
  las reglas del proveedor para esos mensajes (por ejemplo, plantillas aprobadas con botones) se
  resuelve en el plan. La instancia necesita además un medio de envío de email, que se fija en el
  plan.
- En el chat web, el visitante sigue siendo anónimo (spec 004, FR-018) salvo que decida dar su
  nombre y teléfono para que le contacten; pedírselos solo en ese momento es compatible con la
  spec 004.
- El nombre de perfil de WhatsApp se acepta como nombre del cliente; el bot no lo verifica.
- Qué es una queja o reclamación lo interpreta el bot a partir del mensaje; no hay lista de
  palabras configurable.
- El "horario de atención" para la derivación es el del contacto de derivación y, si no está
  registrado, el del negocio (spec 001).
- Las métricas de atención (tiempos de respuesta del negocio, número de derivaciones) quedan fuera
  de alcance; solo se registran los eventos técnicos de FR-022.
- La derivación no cambia el límite de mensajes por cliente (spec 002, FR-004a) ni los topes del
  chat web (spec 004).
- Dependencias: spec 001 (contacto de derivación, horario y cierres), spec 002 (cadena de
  respuesta, agrupación de mensajes, contacto de derivación, registros y borrado) y spec 004
  (canal web y "Probar el bot").
