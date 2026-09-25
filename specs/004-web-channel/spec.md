# Feature Specification: Canal web del bot de atención

**Feature Branch**: `004-web-channel`

**Created**: 2026-09-25

**Status**: Draft

**Ámbito**: núcleo (genérico, aplica a todos los clientes)

**Input**: User description: "Canal web para el bot de atención (núcleo). Objetivo: poder
conversar con el bot desde el navegador, sin depender de WhatsApp ni de Meta, con la misma cadena
de respuesta que el canal de WhatsApp. Alcance: (1) generalizar el núcleo de conversación para
varios canales, sin cambiar el comportamiento de WhatsApp; (2) página 'Probar el bot' dentro del
panel del operador, con información técnica de cada respuesta; (3) canal web público: un chat que
el negocio inserta en su propia web, con visitantes anónimos, límites y protección anti-abuso,
aviso de privacidad y activación por instancia. Fuera de alcance: identificar a la misma persona
entre canales, pasar la conversación a un empleado dentro del chat, fotos y audios por la web,
cambiar de proveedor de modelo."

## Clarifications

### Session 2026-09-25

- Q: ¿Cómo se enmienda la restricción de la constitución "WhatsApp es el canal de atención al
  cliente final"? → A: con una enmienda general: el núcleo atiende al cliente final por los canales
  que se añadan mediante spec de núcleo (el primero es WhatsApp), y todo canal MUST aplicar la misma
  cadena de respuesta y las mismas garantías de los Principios IV y V.
- Q: ¿Cómo se define el tope de uso del canal web público? → A: dos topes a la vez, uno diario y
  otro mensual, en número de respuestas del bot, configurables por el operador; por defecto 200
  al día y 3 000 al mes.

## Contexto

La feature 002 atiende a los clientes finales por WhatsApp. Hoy no hay otra forma de hablar con el
bot que WhatsApp o la herramienta de terminal para desarrolladores, y la prueba con WhatsApp real
depende de que Meta habilite una cuenta. Esta feature añade la web como segundo canal:

- Para el **operador**, una página del panel donde probar el bot con los datos reales del negocio,
  ver por qué responde lo que responde y enseñarlo a un cliente sin teléfono ni cuenta de Meta.
- Para el **cliente final**, un chat en la web del propio negocio que responde igual que por
  WhatsApp.

El bot MUST comportarse igual en todos los canales: mismas reglas de respuesta, misma información
registrada, mismo contacto de derivación. Solo cambia cómo llega el mensaje y cómo se entrega la
respuesta.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Probar el bot desde el panel (Priority: P1)

El operador abre en el panel la página "Probar el bot", escribe preguntas como si fuera un cliente
y ve las respuestas tal como las recibiría un cliente real, con la información del negocio
vigente. Junto a cada respuesta ve por qué es así: qué plantilla se usó, si se añadió el contacto,
si el verificador de cifras rechazó algún borrador y cuánto tardó. Puede empezar una conversación
nueva en cualquier momento para volver a ver el saludo.

**Why this priority**: es la forma de validar el bot sin depender de WhatsApp ni de Meta, y de
detectar datos mal registrados antes de que los vea un cliente. Solo lo usa el operador, así que
no expone el bot al público.

**Independent Test**: con un negocio activo, entrar en el panel, abrir "Probar el bot" y hacer
preguntas de horario, precios, una sin dato registrado y una petición de hablar con una persona.
Las respuestas coinciden con las del canal de WhatsApp para las mismas preguntas y la información
técnica se muestra junto a cada una.

**Acceptance Scenarios**:

1. **Given** un negocio activo y el operador con sesión iniciada, **When** abre "Probar el bot" y
   escribe "¿a qué hora abrís el sábado?", **Then** recibe una respuesta que empieza por el saludo
   con el nombre del negocio y da las franjas del sábado registradas.
2. **Given** una conversación de prueba en curso, **When** el operador escribe una segunda
   pregunta, **Then** la respuesta no repite el saludo y tiene en cuenta los mensajes anteriores.
3. **Given** una respuesta a una pregunta sin dato registrado, **When** el operador la mira,
   **Then** ve que incluye el contacto de derivación y que la información técnica lo indica.
4. **Given** una conversación de prueba en curso, **When** el operador pulsa "Nueva
   conversación", **Then** la siguiente respuesta vuelve a empezar por el saludo y no tiene en
   cuenta los mensajes anteriores.
5. **Given** el operador cambia un precio en el panel, **When** vuelve a preguntar por ese precio
   en la página de pruebas, **Then** la respuesta usa el precio nuevo.
6. **Given** un negocio "en preparación", **When** el operador abre "Probar el bot", **Then** puede
   probarlo igualmente y la página le indica que los clientes reales no reciben respuesta mientras
   el negocio no esté activo.
7. **Given** alguien sin sesión de operador, **When** intenta abrir la página o enviarle mensajes,
   **Then** se le redirige al inicio de sesión y no se genera ninguna respuesta.

---

### User Story 2 - Activar el chat web e insertarlo en la web del negocio (Priority: P2)

El operador activa el chat web de la instancia, indica en qué webs se puede mostrar y el enlace a
la política de privacidad del negocio, y obtiene el fragmento que el negocio pega en su web para
que aparezca el chat.

**Why this priority**: sin activación explícita el chat público no debe existir; es el paso previo
a que un cliente final lo use.

**Independent Test**: con el chat web desactivado, comprobar que la web del negocio no muestra el
chat; activarlo con una web permitida, pegar el fragmento en una página de esa web y comprobar que
el chat aparece; pegarlo en una web no permitida y comprobar que no funciona.

**Acceptance Scenarios**:

1. **Given** una instancia recién creada, **When** nadie ha activado el chat web, **Then** el chat
   web público está desactivado y no responde a ningún visitante.
2. **Given** el operador en la configuración del chat web, **When** lo activa sin indicar ninguna
   web permitida o sin enlace a la política de privacidad, **Then** el panel no guarda la
   activación y explica qué falta.
3. **Given** el chat web activado con una web permitida, **When** el operador copia el fragmento y
   el negocio lo pega en esa web, **Then** los visitantes ven el chat en esa web.
4. **Given** el fragmento pegado en una web que no está en la lista, **When** un visitante intenta
   usar el chat, **Then** el chat no se muestra o no acepta mensajes.
5. **Given** el chat web activado, **When** el operador lo desactiva, **Then** a partir de ese
   momento el chat deja de aceptar mensajes nuevos y muestra a los visitantes que no está
   disponible, con el contacto de derivación.

---

### User Story 3 - El cliente final conversa en la web del negocio (Priority: P2)

Un visitante de la web del negocio abre el chat, ve un aviso breve de que habla con un asistente
automático y cómo se tratan sus mensajes, y hace sus preguntas. Recibe las mismas respuestas que
recibiría por WhatsApp. Si vuelve más tarde en el mismo navegador, puede seguir la conversación.

**Why this priority**: es el valor final para el negocio, pero depende de la activación (US2) y
conviene haberlo validado antes desde el panel (US1).

**Independent Test**: en una web permitida con el chat activado, abrir el chat desde un navegador
nuevo, hacer una pregunta de horario, una de precio "a consultar" y pedir hablar con una persona;
comprobar saludo, respuestas y contacto; recargar la página y comprobar que la conversación sigue.

**Acceptance Scenarios**:

1. **Given** un visitante que abre el chat por primera vez, **When** aún no ha escrito, **Then** ve
   el aviso de asistente automático con el enlace a la política de privacidad del negocio.
2. **Given** el visitante escribe su primera pregunta, **When** llega la respuesta, **Then** empieza
   por el saludo con el nombre del negocio y contesta con la información registrada.
3. **Given** el visitante escribe tres mensajes seguidos en menos de 3 segundos, **When** el bot
   responde, **Then** da una sola respuesta que cubre los tres, como en WhatsApp.
4. **Given** el visitante pide hablar con una persona, **When** llega la respuesta, **Then** incluye
   el contacto de derivación y su horario.
5. **Given** una conversación en curso, **When** el visitante recarga la página o vuelve en el
   mismo navegador antes de que caduque la conversación, **Then** ve sus mensajes anteriores y el
   bot no repite el saludo.
6. **Given** el negocio pasa a "en preparación", **When** un visitante escribe, **Then** no recibe
   respuesta del bot y ve que el chat no está disponible, con el contacto de derivación.
7. **Given** el visitante espera una respuesta, **When** esta tarda, **Then** ve una indicación de
   que el bot está escribiendo y, si la respuesta no llega por un fallo, un mensaje de disculpa con
   el contacto del negocio.

---

### User Story 4 - Protección del chat web contra abuso y exceso de coste (Priority: P3)

Como el chat web es público, cualquiera puede escribir. El sistema limita cuánto puede escribir
cada visitante y cuánto uso total admite la instancia, para que un abuso o un bucle automático no
bloquee la atención ni dispare el coste.

**Why this priority**: imprescindible antes de publicar el chat en una web real, pero no para
probarlo desde el panel.

**Independent Test**: enviar desde un mismo visitante más mensajes de los permitidos y comprobar un
único aviso con el contacto y después silencio; alcanzar el tope de uso de la instancia y comprobar
que el chat deja de generar respuestas y lo indica con el contacto.

**Acceptance Scenarios**:

1. **Given** un visitante que supera el límite de mensajes por visitante, **When** envía uno más,
   **Then** recibe una sola vez un aviso con el contacto del negocio y sus mensajes siguientes no se
   contestan hasta que baja su ritmo.
2. **Given** muchas sesiones nuevas desde el mismo origen de red en poco tiempo, **When** se supera
   el límite por origen, **Then** las nuevas sesiones desde ese origen no reciben respuesta del bot
   durante un tiempo y ven el contacto del negocio.
3. **Given** la instancia alcanza el tope de uso del canal web, **When** un visitante escribe,
   **Then** el chat indica que no puede atender ahora y muestra el contacto de derivación, y el
   operador lo ve en el panel.
4. **Given** el tope de uso del canal web se alcanza, **When** un cliente escribe por WhatsApp,
   **Then** el canal de WhatsApp sigue atendiendo con normalidad.

---

### Edge Cases

- **Mismo negocio, dos canales**: una persona que escribe por WhatsApp y por la web tiene dos
  conversaciones independientes; el sistema no intenta relacionarlas.
- **Mensajes muy largos o vacíos**: el chat web rechaza mensajes vacíos y limita la longitud de cada
  mensaje; lo que supere el límite no se envía y el visitante ve el motivo.
- **Navegador sin almacenamiento o en modo privado**: el chat funciona, pero la conversación no se
  conserva al recargar; al volver, empieza una conversación nueva con saludo.
- **Varias pestañas del mismo visitante**: comparten la misma conversación y no generan respuestas
  duplicadas.
- **Conexión cortada mientras se espera la respuesta**: la respuesta queda guardada y el visitante
  la ve al reconectar, si la conversación sigue vigente.
- **Contenido del visitante con formato o código**: se muestra como texto, nunca se interpreta en
  la página; nada de lo que escriba el visitante puede ejecutarse en la web del negocio ni en el
  panel.
- **Intentos de manipular el bot** ("ignora tus instrucciones…"): mismas garantías que en WhatsApp.
- **Negocio sin contacto de derivación usable**: no puede ocurrir en un negocio activo (lo
  garantiza la 001); con el negocio "en preparación" el chat público no atiende.
- **Fallo al leer la información del negocio**: disculpa con el contacto de emergencia de la
  instancia, como en WhatsApp.
- **Conversación de prueba del operador**: nunca se mezcla con conversaciones de clientes reales en
  los registros ni en las cifras de uso del canal público.

## Requirements *(mandatory)*

### Varios canales

- **FR-001**: El núcleo de conversación MUST admitir varios canales de atención. Cada cliente final
  MUST identificarse por el canal y un identificador propio de ese canal (el número de teléfono en
  WhatsApp, la sesión del navegador en la web).
- **FR-002**: La cadena de respuesta MUST ser la misma en todos los canales: espera de agrupado,
  lectura de la información vigente, hechos calculados, generación, verificación de cifras,
  plantillas, saludo, contacto de derivación, límites y registros sin datos personales. Ninguna
  regla de respuesta MUST depender del canal, salvo las propias de cada canal indicadas en esta
  spec.
- **FR-003**: Las reglas propias de WhatsApp (ventana de 24 horas para responder, tipos de mensaje
  de WhatsApp, grupos) MUST aplicarse solo al canal de WhatsApp.
- **FR-004**: El comportamiento del canal de WhatsApp MUST NOT cambiar con esta feature: sus
  escenarios de aceptación y sus pruebas automáticas MUST seguir cumpliéndose.
- **FR-005**: Las conversaciones existentes de WhatsApp MUST conservarse al introducir los canales,
  sin pérdida de mensajes ni de su estado.
- **FR-006**: Los registros técnicos MUST indicar el canal de cada evento y MUST seguir sin contener
  textos de mensajes ni identificadores de cliente en claro, tampoco el de la sesión web.

### Página "Probar el bot"

- **FR-007**: El panel MUST ofrecer una página "Probar el bot", accesible solo con sesión de
  operador, donde el operador escribe mensajes de texto y recibe las respuestas del bot.
- **FR-008**: Las respuestas de la página de pruebas MUST generarse con la misma cadena y la misma
  información vigente que las de los clientes reales, y MUST mostrarse con el mismo texto que
  recibiría un cliente.
- **FR-009**: Junto a cada respuesta, la página MUST mostrar al operador: la plantilla fija usada
  (si la hubo), si se añadió el contacto de derivación y por qué, si se añadió el saludo, si el
  verificador de cifras rechazó algún borrador (cuántos, sin repetir los valores) y el tiempo de
  respuesta.
- **FR-010**: El operador MUST poder empezar una conversación de prueba nueva en cualquier momento;
  la siguiente respuesta MUST tratarse como el inicio de una conversación.
- **FR-011**: La página de pruebas MUST funcionar también con el negocio "en preparación", indicando
  que los clientes reales no reciben respuesta en ese estado.
- **FR-012**: Las conversaciones de prueba MUST distinguirse de las de clientes reales: MUST NOT
  contar para los límites ni el tope de uso del canal web público y MUST borrarse con la misma
  retención que el resto de conversaciones.
- **FR-013**: Los mensajes de la página de pruebas MUST estar protegidos contra envíos desde otras
  webs en nombre del operador, como el resto de acciones del panel.

### Chat web público

- **FR-014**: El chat web público MUST estar desactivado por defecto en cada instancia y MUST
  activarlo el operador desde el panel.
- **FR-015**: Para activarlo, el operador MUST indicar al menos una web permitida y el enlace a la
  política de privacidad del negocio. El chat MUST funcionar solo insertado en las webs permitidas.
- **FR-016**: El panel MUST ofrecer al operador el fragmento que el negocio inserta en su web para
  mostrar el chat, listo para copiar.
- **FR-017**: Antes del primer mensaje, el chat MUST mostrar que el visitante habla con un asistente
  automático del negocio y enlazar la política de privacidad indicada.
- **FR-018**: Cada visitante MUST identificarse por una sesión anónima de su navegador, sin pedirle
  nombre, teléfono ni correo.
- **FR-019**: Una conversación web MUST continuar mientras el visitante vuelva desde el mismo
  navegador antes de 24 horas sin mensajes suyos; pasado ese tiempo, su siguiente mensaje MUST abrir
  una conversación nueva con saludo.
- **FR-020**: El chat MUST aceptar solo mensajes de texto, con una longitud máxima por mensaje, y
  MUST mostrar el contenido del visitante y del bot siempre como texto.
- **FR-021**: Mientras se genera la respuesta, el chat MUST indicar que el bot está escribiendo. Si
  no hay respuesta por un fallo, MUST mostrar la disculpa con el contacto, como en WhatsApp.
- **FR-022**: Con el negocio "en preparación" o el chat desactivado, el chat MUST NOT generar
  respuestas y MUST mostrar que no está disponible junto con el contacto de derivación (o, si no
  puede leerse, el contacto de emergencia de la instancia).
- **FR-023**: Los mensajes de una conversación web MUST agruparse y contestarse con las mismas
  reglas que en WhatsApp (una respuesta para varios mensajes seguidos, sin duplicados aunque el
  visitante reintente el envío o tenga varias pestañas abiertas).

### Límites y protección

- **FR-024**: El sistema MUST limitar los mensajes de cada visitante con las mismas reglas que por
  número en WhatsApp: por encima del límite, un único aviso con el contacto por ventana y ninguna
  respuesta más hasta que baje su ritmo.
- **FR-025**: El sistema MUST limitar además las sesiones nuevas y los mensajes por origen de red,
  para que crear sesiones nuevas no sirva para esquivar el límite por visitante.
- **FR-026**: El sistema MUST aplicar dos topes de uso del canal web público por instancia, en
  número de respuestas del bot: uno diario y otro mensual, configurables por el operador (por
  defecto 200 al día y 3 000 al mes). El día y el mes se cuentan en la zona horaria del negocio.
  Al alcanzar cualquiera de los dos, el chat MUST dejar de generar respuestas hasta que empiece el
  día o el mes siguiente, mostrar el contacto de derivación y avisar al operador en el panel. Los
  topes MUST NOT afectar al canal de WhatsApp ni a la página de pruebas.
- **FR-026a**: El panel MUST mostrar al operador cuántas respuestas lleva el canal web en el día y
  en el mes en curso frente a sus topes.
- **FR-027**: Las peticiones al chat web desde webs no permitidas MUST rechazarse sin generar
  respuestas ni guardar mensajes.

### Datos y retención

- **FR-028**: Las conversaciones web y sus sesiones MUST borrarse con la misma retención que las de
  WhatsApp, y los registros técnicos MUST seudonimizar el identificador de sesión.
- **FR-029**: El sistema MUST NOT guardar del visitante más que lo necesario para la conversación:
  el identificador de sesión, sus mensajes y las marcas de tiempo. La dirección de red solo MUST
  usarse para los límites de FR-025 y MUST NOT guardarse junto a la conversación.

### Key Entities

- **Canal**: vía por la que llega un cliente final (WhatsApp, web pública, pruebas del operador).
  Determina cómo se identifica al cliente, cómo se entregan las respuestas y qué reglas propias
  aplican.
- **Cliente final**: persona que escribe por un canal, identificada por el canal y un identificador
  de ese canal (número de teléfono o sesión web). No se relacionan clientes entre canales.
- **Sesión web**: identificador anónimo que el navegador del visitante conserva para continuar su
  conversación. No contiene datos personales.
- **Configuración del chat web**: por instancia; si está activado, las webs permitidas, el enlace a
  la política de privacidad y los topes diario y mensual. La gestiona el operador.
- **Conversación**, **Mensaje**: los mismos de la 002, ahora asociados a un cliente de cualquier
  canal.
- **Información técnica de una respuesta**: plantilla, contacto añadido y motivo, saludo, rechazos
  del verificador y tiempo; se muestra solo en la página de pruebas.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: El 100 % de las pruebas automáticas y escenarios de aceptación del canal de WhatsApp
  (feature 002) siguen cumpliéndose tras introducir los canales.
- **SC-002**: Para el mismo juego de preguntas de evaluación, las respuestas por la web y por
  WhatsApp cumplen los mismos criterios de la 002 (SC-001, SC-002, SC-005 a SC-008) con los mismos
  porcentajes.
- **SC-003**: El operador puede hacer una pregunta en "Probar el bot" y leer la respuesta con su
  información técnica en menos de 10 segundos en el 95 % de los casos.
- **SC-004**: En el chat web público, el 95 % de los mensajes recibe respuesta en menos de 10
  segundos desde el último mensaje del grupo, igual que en WhatsApp.
- **SC-005**: El 100 % de los visitantes ve el aviso de asistente automático y el enlace a la
  política de privacidad antes de su primer mensaje.
- **SC-006**: Con el chat desactivado, el negocio en preparación, una web no permitida o el tope de
  uso alcanzado, el 0 % de los mensajes genera una respuesta del modelo.
- **SC-007**: Un visitante que envía mensajes sin parar recibe como mucho un aviso de límite por
  ventana y ninguna respuesta más mientras supere el límite; abrir sesiones nuevas desde el mismo
  origen no le permite superar el límite por origen.
- **SC-008**: Ningún registro técnico contiene textos de mensajes, números de teléfono,
  identificadores de sesión en claro ni direcciones de red.
- **SC-009**: Un operador que no conoce la funcionalidad activa el chat web y obtiene el fragmento
  para la web del negocio en menos de 5 minutos.

## Dependencias

- **Enmienda de la constitución**: la sección "Restricciones del producto" dice "Canal: WhatsApp es
  el canal de atención al cliente final". El chat web público (US2 a US4) atiende a clientes finales
  por otro canal, así que requiere enmendar esa restricción con `/speckit-constitution` antes del
  plan. Redacción acordada: "El núcleo atiende al cliente final por los canales que se añadan
  mediante spec de núcleo; el primero es WhatsApp. Todo canal MUST aplicar la misma cadena de
  respuesta y las mismas garantías de los Principios IV y V." (enmienda MINOR). La página de
  pruebas (US1) no atiende a clientes finales y no la necesita.
- **Feature 002**: la cadena de respuesta, las plantillas, el verificador, los límites, la
  retención y los registros se reutilizan tal cual.
- **Feature 001**: el panel, la sesión del operador y la información del negocio.

## Assumptions

- El chat web solo atiende texto, en español, con las mismas plantillas y tono que WhatsApp; fotos,
  audios y archivos quedan fuera de alcance.
- La página de pruebas y el chat público usan el mismo modelo de lenguaje y la misma configuración
  que WhatsApp; cada mensaje tiene el mismo coste que en WhatsApp.
- La sesión web se conserva en el navegador del visitante solo para continuar su conversación; al
  ser necesaria para el servicio que el visitante pide, no requiere un consentimiento de cookies
  aparte. La política de privacidad del negocio debe mencionar el chat; redactarla es cosa del
  negocio.
- Los límites por visitante son los de WhatsApp (30 mensajes en 15 minutos); los límites por origen
  de red los fija el plan con valores holgados para redes compartidas (oficinas, datos móviles).
- El fragmento para la web es uno solo, sin opciones de diseño; personalizar colores o posición del
  chat queda para una feature posterior.
- El operador, no el negocio, activa y configura el chat web (Principio VI).
- No se implementa aviso al operador por correo ni otros canales cuando se alcanza el tope; se
  muestra en el panel.
- La validación de WhatsApp real sigue pendiente de un negocio piloto con cuenta de Meta; esta
  feature no depende de ella.
