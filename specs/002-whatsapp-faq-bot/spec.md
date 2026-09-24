# Feature Specification: Atención automática de dudas y precios por WhatsApp

**Feature Branch**: `002-whatsapp-faq-bot`

**Created**: 2026-09-24

**Status**: Draft

**Ámbito**: Núcleo (genérico, aplica a todos los clientes)

**Input**: User description: "Atención automática de dudas y precios por WhatsApp. Problema: los clientes del negocio preguntan por WhatsApp horarios, servicios, precios y ubicación, y el negocio no siempre puede contestar a tiempo. Usuario: cliente final que escribe al WhatsApp del negocio. User stories: P1 horario, ubicación o servicios con la respuesta registrada; P1 precios, con el caso 'a consultar'; P1 preguntas sin dato registrado, sin inventar y ofreciendo contacto; P2 saludo de presentación solo al inicio de la conversación; P2 reconducir preguntas ajenas al negocio. Casos límite: varias preguntas en un mensaje, faltas de ortografía o lenguaje coloquial, mensajes fuera del horario del negocio, audios, imágenes o stickers [TBD]. Fuera de alcance: citas, derivación al negocio, mensajes iniciados por el negocio y otros canales distintos de WhatsApp."

## Clarifications

### Session 2026-09-24

- Q: ¿Se atienden audios, imágenes o stickers, o el bot indica que solo lee texto? → A: Se
  atienden texto y audio (el audio se convierte en texto y se responde por escrito). Al resto
  de tipos (imágenes, stickers, vídeos, documentos…) el bot responde que solo atiende texto y
  audios.
- Q: Cuando el cliente envía varios mensajes seguidos en pocos segundos, ¿el bot espera y los
  responde juntos o responde cada uno por separado? → A: Espera unos segundos sin mensajes
  nuevos del cliente y contesta todo lo recibido en una sola respuesta; cada pregunta se
  contesta una sola vez. La duración de la espera se fija en el plan.
- Q: Si un mismo número envía muchísimos mensajes en poco tiempo, ¿debe el bot limitar cuántos
  atiende? → A: Sí. Se limitan los mensajes por número en un periodo; al superar el límite, el
  bot envía una única vez un aviso breve con el contacto del negocio y deja de responder hasta
  que termina el periodo. Las cifras se fijan en el plan.
- Q: ¿Durante cuánto tiempo se guardan las conversaciones y los números de los clientes
  finales, y cuándo se borran? → A: Borrado automático de la conversación completa (mensajes y
  número) 30 días después de su último mensaje.
- Q: Si un mensaje del cliente se procesa con retraso o llega con el negocio "en
  preparación", ¿debe contestarse más tarde? → A: Los recibidos en preparación no se guardan
  ni se contestan nunca; los retrasados se contestan solo si siguen dentro de la ventana de 24
  horas de WhatsApp, y si no se descartan sin respuesta.
- Q: ¿Qué debe quedar registrado de la actividad del bot para detectar fallos? → A: Registros
  técnicos sin el texto de los mensajes y con el número enmascarado o seudonimizado: mensajes
  procesados, tipo, tiempo de respuesta, fallos, límites superados y mensajes descartados.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Consultar horario, ubicación y servicios (Priority: P1)

Un cliente final escribe al WhatsApp del negocio para preguntar cuándo abre, dónde está, cómo
llegar o qué servicios ofrece. El bot responde al momento con la información que el operador
registró en la base de conocimiento del negocio (spec 001).

**Why this priority**: son las preguntas más frecuentes y las que el negocio no puede atender
cuando está ocupado o cerrado. Resolverlas al instante es el valor principal del producto.

**Independent Test**: con un negocio activo que tiene registrados datos, horario, un cierre
puntual y varios servicios, enviar por WhatsApp preguntas sobre horario, ubicación y servicios
y comparar cada respuesta con los datos registrados.

**Acceptance Scenarios**:

1. **Given** un negocio activo con horario semanal registrado, **When** el cliente pregunta
   "¿a qué hora abrís el sábado?", **Then** el bot responde con las franjas registradas para
   el sábado, o indica que ese día está cerrado si no tiene franjas.
2. **Given** un negocio con un cierre puntual registrado para una fecha, **When** el cliente
   pregunta si abre ese día, **Then** el bot indica que ese día está cerrado (o las horas en
   que cierra, si el cierre es parcial), aunque el horario habitual diga lo contrario.
3. **Given** un negocio con zona horaria registrada, **When** el cliente pregunta "¿estáis
   abiertos ahora?", **Then** el bot responde según la hora actual en la zona horaria del
   negocio, teniendo en cuenta horario y cierres puntuales.
4. **Given** un negocio con dirección e indicaciones para llegar, **When** el cliente pregunta
   dónde está o cómo llegar, **Then** el bot responde con la dirección y las indicaciones
   registradas.
5. **Given** un negocio con servicios activos e inactivos, **When** el cliente pregunta qué
   servicios ofrece, **Then** el bot enumera solo los servicios activos y no menciona los
   inactivos.
6. **Given** un negocio con preguntas frecuentes registradas, **When** el cliente hace una
   pregunta equivalente a una de ellas, **Then** el bot responde con la respuesta registrada,
   salvo en la parte que contradiga un dato estructurado, donde prevalece este (FR-014a de la
   spec 001).

---

### User Story 2 - Consultar precios (Priority: P1)

El cliente pregunta cuánto cuesta un servicio. El bot responde con el precio registrado,
respetando su tipo: fijo, "desde" o "a consultar".

**Why this priority**: el precio es, junto con el horario, la duda más habitual y la que más
daño hace si se contesta mal: un precio inventado compromete al negocio.

**Independent Test**: registrar tres servicios, uno con precio fijo, uno "desde" y uno "a
consultar"; preguntar el precio de cada uno y comprobar que las respuestas coinciden con lo
registrado y que para el "a consultar" no aparece ninguna cifra.

**Acceptance Scenarios**:

1. **Given** un servicio activo con precio fijo de 25 €, **When** el cliente pregunta su
   precio, **Then** el bot responde 25 € y no presenta el importe como aproximado.
2. **Given** un servicio activo con precio "desde" 40 €, **When** el cliente pregunta su
   precio, **Then** el bot indica que el precio es desde 40 € y no da un precio exacto ni un
   máximo.
3. **Given** un servicio activo con precio "a consultar", **When** el cliente pregunta su
   precio, **Then** el bot indica que el precio se consulta con el negocio, no da ninguna
   cifra y ofrece el contacto del negocio.
4. **Given** que el operador cambia el precio de un servicio, **When** el cliente pregunta de
   nuevo en la misma conversación, **Then** el bot responde con el precio nuevo.
5. **Given** una pregunta ambigua que puede referirse a varios servicios (por ejemplo, "¿cuánto
   cuesta el tratamiento?" con dos tratamientos registrados), **When** el cliente la envía,
   **Then** el bot da los precios de los servicios que encajan o pide que concrete, sin
   escoger uno por su cuenta.

---

### User Story 3 - Preguntas sin información registrada (Priority: P1)

El cliente pregunta algo relacionado con el negocio que no está registrado (un servicio que no
existe, un dato que el operador no ha cargado). El bot no inventa: reconoce que no tiene esa
información y ofrece el contacto del negocio.

**Why this priority**: es la garantía del Principio IV de la constitución. Sin ella, las dos
historias anteriores no son seguras de desplegar.

**Independent Test**: preguntar por un servicio, un precio y un dato (por ejemplo, si hay
aparcamiento) que no están registrados, y comprobar que en ningún caso el bot aporta un dato
del negocio y que siempre ofrece el contacto.

**Acceptance Scenarios**:

1. **Given** un negocio que no tiene registrado un servicio, **When** el cliente pregunta por
   él, **Then** el bot indica que no tiene información sobre ese servicio, ofrece el contacto
   del negocio y, si procede, menciona los servicios que sí ofrece.
2. **Given** un dato del negocio que no figura ni en los datos estructurados ni en las
   preguntas frecuentes, **When** el cliente pregunta por él, **Then** el bot dice
   explícitamente que no dispone de esa información y ofrece el contacto del negocio, sin
   estimar ni deducir una respuesta.
3. **Given** un servicio inactivo, **When** el cliente pregunta por él, **Then** el bot lo
   trata como no registrado.
4. **Given** un cliente que insiste o pide al bot que "suponga" o "calcule aproximadamente"
   un dato no registrado, **When** envía el mensaje, **Then** el bot mantiene que no tiene
   esa información y vuelve a ofrecer el contacto.

---

### User Story 4 - Saludo de presentación al inicio de la conversación (Priority: P2)

Cuando un cliente escribe por primera vez, o vuelve a escribir tras un periodo sin actividad,
el bot le saluda, se presenta como asistente automático del negocio y explica brevemente qué
puede hacer (informar de horario, ubicación, servicios y precios).

**Why this priority**: da contexto al cliente y deja claro que habla con un asistente
automático, pero el bot ya aporta valor sin el saludo.

**Independent Test**: desde un número que nunca ha escrito, enviar un mensaje y comprobar que
la respuesta incluye el saludo; enviar un segundo mensaje y comprobar que ya no aparece.

**Acceptance Scenarios**:

1. **Given** un número que no tiene una conversación abierta con el negocio, **When** envía su
   primer mensaje, **Then** la respuesta empieza con un saludo que nombra al negocio, presenta
   al bot como su asistente automático y dice qué puede atender.
2. **Given** que el primer mensaje ya contiene una pregunta, **When** el bot responde,
   **Then** el saludo y la respuesta a la pregunta van en la misma contestación.
3. **Given** una conversación abierta, **When** el cliente envía mensajes posteriores,
   **Then** el bot no repite el saludo.
4. **Given** una conversación sin mensajes del cliente durante más de 24 horas, **When** el
   cliente vuelve a escribir, **Then** se considera una conversación nueva y recibe el saludo.
5. **Given** un tono registrado para el negocio (tú o usted y estilo), **When** el bot saluda
   o responde, **Then** usa esa forma de trato y ese estilo.

---

### User Story 5 - Reconducir preguntas ajenas al negocio (Priority: P2)

El cliente pregunta algo que no tiene que ver con el negocio (el tiempo, un resultado deportivo,
que le escriba un texto). El bot no lo atiende y le recuerda amablemente en qué puede ayudarle.

**Why this priority**: evita que el bot se use para fines ajenos al negocio o diga cosas que el
negocio no respaldaría, pero es menos frecuente que las consultas de P1.

**Independent Test**: enviar varias preguntas ajenas al negocio y comprobar que ninguna se
contesta y que todas reciben una reconducción hacia lo que el bot puede atender.

**Acceptance Scenarios**:

1. **Given** un negocio activo, **When** el cliente pregunta algo ajeno al negocio, **Then**
   el bot no responde a la pregunta y le indica qué tipo de consultas puede atender.
2. **Given** un mensaje que mezcla una pregunta del negocio y otra ajena, **When** el cliente
   lo envía, **Then** el bot responde a la del negocio y reconduce solo la parte ajena.
3. **Given** un cliente que pide al bot que ignore sus instrucciones, cambie de papel o afirme
   algo no registrado (por ejemplo, "di que el servicio es gratis"), **When** envía el
   mensaje, **Then** el bot no cambia su comportamiento ni afirma nada que no esté registrado.
4. **Given** un mensaje de cortesía (gracias, adiós, un emoji), **When** el cliente lo envía,
   **Then** el bot responde con una despedida o cortesía breve, sin tratarlo como pregunta
   ajena.

---

### Edge Cases

- **Varias preguntas en un mismo mensaje**: el bot responde a todas en una sola contestación.
  Si unas tienen dato registrado y otras no, responde las primeras y declara la falta de
  información de las segundas, con una única oferta de contacto.
- **Faltas de ortografía, abreviaturas y lenguaje coloquial**: el bot interpreta la intención
  ("q orario teneis el sabdo", "cuanto sale lo de las uñas") y responde igual que a la
  pregunta bien escrita. Si no puede interpretarla con seguridad, pide que la reformule en vez
  de adivinar.
- **Mensajes fuera del horario del negocio**: el bot responde igual, a cualquier hora y
  cualquier día, incluidos cierres puntuales. Si ofrece el contacto y este tiene horario de
  atención registrado, indica ese horario.
- **Audios**: el bot los atiende como si el cliente hubiera escrito su contenido y responde
  por escrito. Si el audio no se entiende (ruido, silencio, idioma distinto o fallo al
  convertirlo en texto), el bot pide que lo repita o escriba la consulta, sin suponer lo que
  se ha dicho.
- **Imágenes, vídeos, documentos, stickers, ubicaciones, contactos y otros tipos**: el bot no
  interpreta su contenido y responde que solo atiende mensajes de texto y audios, pidiendo que
  escriba o grabe la consulta. Si el mensaje trae un texto que lo acompaña (por ejemplo, el pie
  de una foto), el bot responde a ese texto e indica que no puede ver el archivo.
- **Petición de cita o reserva**: la gestión de citas está fuera de alcance. El bot indica que
  no puede reservar por este medio y ofrece el contacto del negocio. Puede informar de si un
  servicio es reservable, pero no de disponibilidad.
- **El cliente pide hablar con una persona**: el bot facilita en ese mismo momento el contacto
  de derivación del negocio (o su teléfono general, según la spec 001), sea cual sea el punto
  de la conversación (Principio V).
- **Negocio no activo** ("en preparación"): el bot no responde a los mensajes recibidos
  (FR-029 de la spec 001), no los guarda y no los contesta cuando el negocio pasa a activo.
- **Mensaje procesado con retraso** (caída o reinicio del sistema, reentrega tardía del
  canal): si sigue dentro de la ventana de 24 horas desde el último mensaje del cliente, el
  bot lo contesta con los datos y la hora del momento de responder; si no, lo descarta sin
  responder (FR-002a).
- **La información del negocio cambia durante la conversación**: cada respuesta usa los datos
  vigentes en el momento de generarla.
- **La base de conocimiento no se puede leer o la respuesta no puede generarse** (fallo
  temporal): el bot no responde con datos de memoria ni inventados; envía un mensaje breve de
  disculpa pidiendo que vuelva a escribir más tarde.
- **Varios mensajes seguidos en pocos segundos**: el bot espera a que el cliente deje de
  escribir unos segundos y contesta todos los mensajes recibidos en una sola respuesta; cada
  pregunta recibe respuesta una sola vez (FR-004).
- **Mensaje en otro idioma**: el bot responde en el idioma de atención del negocio.
- **Mensaje vacío o ininteligible**: el bot pide amablemente que el cliente reformule su
  consulta y recuerda qué puede atender.
- **Mensaje reenviado o duplicado por el canal** (el mismo mensaje entregado dos veces): el
  cliente recibe una sola respuesta.
- **Mensajes desde grupos de WhatsApp**: el bot solo atiende conversaciones individuales.
- **Un número envía un volumen excesivo de mensajes** (abuso, otro bot o un envío
  automatizado): al superar el límite del periodo, el bot envía una sola vez un aviso breve con
  el contacto del negocio y no responde a los mensajes siguientes hasta que termina el periodo
  (FR-004a).

## Requirements *(mandatory)*

### Functional Requirements

**Recepción y respuesta**

- **FR-001**: El sistema MUST recibir los mensajes que los clientes finales envían al número de
  WhatsApp del negocio y responder en esa misma conversación.
- **FR-002**: El bot MUST responder solo cuando el negocio está activo; con el negocio "en
  preparación" MUST NOT enviar respuestas. Los mensajes recibidos mientras el negocio está en
  preparación MUST NOT guardarse ni contestarse después, aunque el negocio pase a activo.
- **FR-002a**: Un mensaje que se procesa con retraso MUST contestarse solo si sigue dentro de
  la ventana de 24 horas desde el último mensaje del cliente final; fuera de ella MUST
  descartarse sin respuesta. La respuesta tardía MUST usar la información y la hora del momento
  en que se genera (FR-007, FR-008).
- **FR-003**: El bot MUST responder a cualquier hora y cualquier día, con independencia del
  horario de apertura y de los cierres puntuales del negocio.
- **FR-004**: Antes de responder, el bot MUST esperar un breve intervalo sin mensajes nuevos
  del mismo cliente final y MUST contestar en una sola respuesta todos los mensajes recibidos
  en ese intervalo. Cada mensaje del cliente MUST quedar cubierto por exactamente una
  respuesta, y cada pregunta MUST contestarse una sola vez. Los mensajes duplicados por el
  canal MUST NOT generar respuestas duplicadas. La duración del intervalo se fija en el plan
  y MUST ser compatible con SC-003.
- **FR-004a**: El sistema MUST limitar el número de mensajes que atiende de cada cliente final
  en un periodo. Al superar el límite, el bot MUST enviar una sola vez un aviso breve que
  incluya el contacto del negocio según FR-016 (y así cumpla el Principio V), y MUST NOT
  responder a más mensajes de ese número hasta que termine el periodo. El límite y el periodo
  se fijan en el plan y MUST ser holgados para una conversación normal. Mientras un número no
  supera el límite, FR-004 se aplica sin cambios.
- **FR-005**: El bot MUST atender solo conversaciones individuales iniciadas por el cliente
  final; MUST NOT iniciar conversaciones ni responder en grupos.

**Contenido de las respuestas**

- **FR-006**: Toda afirmación del bot sobre el negocio (horario, cierres, ubicación, datos de
  contacto, servicios, precios, políticas y preguntas frecuentes) MUST proceder de la
  información registrada del negocio y coincidir con ella.
- **FR-007**: Cada respuesta MUST basarse en la información vigente en el momento de
  generarla, incluidos los cambios guardados durante una conversación abierta.
- **FR-008**: Para preguntas de horario, el bot MUST tener en cuenta las franjas semanales,
  los cierres puntuales (que prevalecen) y la zona horaria del negocio; para preguntas
  relativas al momento actual, MUST usar la fecha y hora actuales en esa zona horaria.
- **FR-009**: El bot MUST ignorar los servicios inactivos: no los enumera, no da su precio y
  los trata como no registrados.
- **FR-010**: El bot MUST expresar el precio según su tipo: fijo, con el importe exacto;
  "desde", con el importe mínimo indicado como tal; "a consultar", sin ninguna cifra, indicando
  que se consulta con el negocio y ofreciendo su contacto.
- **FR-011**: Los importes MUST mostrarse en la moneda registrada del negocio.
- **FR-012**: Cuando una pregunta pueda referirse a varios servicios, el bot MUST dar la
  información de todos los que encajan o pedir al cliente que concrete; MUST NOT elegir uno
  arbitrariamente.
- **FR-013**: Si la respuesta de una pregunta frecuente contradice un dato estructurado, el
  bot MUST usar el dato estructurado.
- **FR-014**: El bot MUST responder en el idioma de atención del negocio y con el tono
  registrado (forma de trato tú/usted y estilo).

**Información no registrada y salida a una persona**

- **FR-015**: Si lo preguntado sobre el negocio no está registrado, el bot MUST decir
  explícitamente que no dispone de esa información y ofrecer el contacto del negocio. MUST NOT
  inventar, estimar, aproximar ni deducir el dato, aunque el cliente insista.
- **FR-016**: "Ofrecer el contacto del negocio" MUST consistir en facilitar el contacto de
  derivación registrado (o, en su defecto, el teléfono general, según FR-019 de la spec 001),
  incluido su horario de atención cuando esté registrado.
- **FR-017**: Si el cliente pide hablar con una persona del negocio, en cualquier momento de la
  conversación, el bot MUST facilitarle el contacto según FR-016 en esa misma respuesta.
- **FR-018**: Si el cliente pide reservar, cambiar o cancelar una cita, el bot MUST indicar que
  no puede gestionarlo por este medio y ofrecer el contacto según FR-016.

**Saludo y conversación**

- **FR-019**: El bot MUST agrupar los mensajes de cada cliente final (identificado por su número
  de WhatsApp) en conversaciones. Una conversación MUST considerarse nueva cuando es el primer
  mensaje de ese número o han pasado más de 24 horas desde su último mensaje.
- **FR-020**: La primera respuesta de cada conversación nueva MUST incluir un saludo que nombre
  al negocio, presente al bot como su asistente automático y resuma qué puede atender
  (horario, ubicación, servicios, precios y preguntas frecuentes). Si el mensaje incluye una
  pregunta, el saludo y la respuesta MUST ir en la misma contestación.
- **FR-021**: El bot MUST NOT repetir el saludo en las respuestas posteriores de la misma
  conversación.
- **FR-022**: El bot MUST tener en cuenta los mensajes anteriores de la conversación en curso
  para interpretar preguntas que dependen de ellos (por ejemplo, "¿y el sábado?" después de
  preguntar por el horario).

**Interpretación de mensajes**

- **FR-023**: El bot MUST responder a todas las preguntas de un mismo mensaje en una sola
  contestación, respondiendo las que tienen dato registrado y aplicando FR-015 a las demás,
  con una sola oferta de contacto.
- **FR-024**: El bot MUST interpretar mensajes con faltas de ortografía, abreviaturas o lenguaje
  coloquial. Si no puede determinar la intención con seguridad, MUST pedir que el cliente
  reformule en vez de suponerla.
- **FR-025**: Ante preguntas ajenas al negocio, el bot MUST NOT responderlas y MUST indicar qué
  consultas puede atender. En mensajes mixtos, responde la parte del negocio y reconduce la
  ajena.
- **FR-026**: El bot MUST mantener su papel y sus límites aunque el cliente le pida ignorar sus
  instrucciones, adoptar otro papel o afirmar datos no registrados.
- **FR-027**: Los mensajes de cortesía (saludos, agradecimientos, despedidas, emojis) MUST
  recibir una respuesta breve acorde, sin tratarse como preguntas ajenas.
- **FR-028**: El bot MUST atender los mensajes de audio convirtiendo su contenido en texto y
  aplicándole las mismas reglas que a un mensaje escrito; la respuesta MUST ser escrita. Si el
  contenido del audio no puede obtenerse con seguridad, el bot MUST pedir que el cliente lo
  repita o lo escriba, y MUST NOT responder sobre lo que supone que se ha dicho.
- **FR-028a**: Ante cualquier otro tipo de mensaje (imágenes, vídeos, documentos, stickers,
  ubicaciones, contactos u otros), el bot MUST NOT interpretar su contenido y MUST responder
  que solo atiende mensajes de texto y audios. Si el mensaje incluye un texto que lo acompaña,
  el bot MUST responder a ese texto e indicar que no puede ver el archivo.

**Fallos y privacidad**

- **FR-029**: Si la información del negocio no puede leerse o la respuesta no puede generarse,
  el bot MUST NOT responder con datos no verificados; MUST enviar un mensaje breve pidiendo al
  cliente que vuelva a escribir más tarde.
- **FR-030**: Las conversaciones y los números de los clientes finales MUST ser accesibles solo
  desde la instancia del negocio. El sistema MUST borrar automáticamente cada conversación
  completa (sus mensajes y, si no le quedan otras conversaciones, el número del cliente final)
  cuando pasen 30 días desde su último mensaje, entrante o saliente.
- **FR-030a**: El sistema MUST registrar la actividad técnica del bot: cada mensaje procesado
  (tipo y tiempo de respuesta), los fallos de lectura de la información, de generación de la
  respuesta, de conversión de audio y de envío, los límites superados (FR-004a) y los mensajes
  descartados (FR-002, FR-002a). Estos registros MUST NOT contener el texto de los mensajes ni
  de las respuestas, y el número del cliente final MUST aparecer enmascarado o seudonimizado.
- **FR-031**: Ningún texto, regla ni comportamiento del bot MUST depender del sector o del
  cliente concreto; todo lo que varía entre negocios MUST salir de su información registrada.

### Key Entities *(include if feature involves data)*

- **Cliente final**: persona que escribe al WhatsApp del negocio. Se identifica por su número de
  WhatsApp. No se le pide ningún otro dato.
- **Conversación**: serie de mensajes entre un cliente final y el bot del negocio. Contiene el
  cliente final, el momento de inicio y el del último mensaje. Determina cuándo se saluda y qué
  contexto se usa para interpretar las preguntas.
- **Mensaje**: cada mensaje recibido o enviado dentro de una conversación. Contiene dirección
  (entrante o saliente), tipo (texto, audio u otro), contenido (en los audios, el texto
  obtenido de ellos) y momento. Cada mensaje entrante queda cubierto por una sola respuesta,
  que puede cubrir varios mensajes entrantes seguidos (FR-004).
- **Base de conocimiento del negocio** (definida en la spec 001): fuente única de la
  información con la que responde el bot, incluidos el tono, el contacto de derivación y el
  estado del negocio.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: En un juego de pruebas de al menos 50 preguntas sobre información registrada
  (horario, cierres, ubicación, servicios, precios y preguntas frecuentes), el 100 % de las
  respuestas coincide con los datos registrados.
- **SC-002**: En un juego de pruebas de al menos 30 preguntas sobre información no registrada o
  con precio "a consultar", el 0 % de las respuestas contiene un dato del negocio inventado y
  el 100 % ofrece el contacto del negocio.
- **SC-003**: El 95 % de los mensajes recibe respuesta en menos de 10 segundos, contados desde
  el último mensaje del grupo que se contesta junto (FR-004) e incluida la espera, a cualquier
  hora del día y cualquier día de la semana.
- **SC-004**: Al menos el 90 % de las preguntas escritas con faltas de ortografía o lenguaje
  coloquial obtiene la misma respuesta que su versión bien escrita, y el resto recibe una
  petición de reformular, nunca un dato erróneo.
- **SC-005**: El saludo aparece en el 100 % de las conversaciones nuevas y en el 0 % de las
  respuestas posteriores de una misma conversación.
- **SC-006**: El 100 % de las preguntas ajenas al negocio del juego de pruebas se reconduce sin
  responder a su contenido.
- **SC-007**: En mensajes con varias preguntas, el 100 % de las preguntas recibe respuesta o
  declaración de falta de información.
- **SC-008**: El 100 % de las peticiones de hablar con una persona recibe el contacto del
  negocio en la misma respuesta.
- **SC-009**: En un juego de pruebas de al menos 20 audios con preguntas sobre información
  registrada, al menos el 90 % recibe la misma respuesta que la pregunta escrita equivalente y
  el resto recibe una petición de repetir o escribir, nunca un dato erróneo. El 100 % de los
  mensajes de otros tipos (imágenes, stickers, vídeos, documentos) recibe el aviso de que solo
  se atienden texto y audios.
- **SC-010**: Negocios de al menos tres sectores distintos se atienden con el mismo
  comportamiento del bot, sin cambios de código.
- **SC-011**: El 100 % de las conversaciones cuyo último mensaje tiene más de 30 días (más el
  margen de ejecución del borrado que fije el plan) no existe en la instancia, ni sus mensajes.

## Assumptions

- Depende de la spec 001 (base de conocimiento del negocio): el bot usa su información, su
  estado activo/en preparación, su tono y su contacto de derivación, y ve los cambios en la
  siguiente respuesta.
- Cada instancia tiene un número de WhatsApp del negocio conectado al sistema. La forma de
  conectarlo y sus credenciales las configura el operador en la instancia; el detalle se fija
  en el plan.
- "Derivación al negocio" (fuera de alcance) se entiende como traspasar la conversación a una
  persona o avisar al negocio. Facilitar el contacto registrado sí está dentro del alcance y es
  el mecanismo que cumple el Principio V en esta versión.
- Los audios se atienden en el idioma de atención del negocio; los audios en otro idioma o
  demasiado largos para procesarse se tratan como no entendidos (FR-028). El límite de
  duración se fija en el plan.
- Los audios del cliente no se conservan una vez obtenido su texto; basta con guardar el texto
  en la conversación.
- Una conversación caduca tras 24 horas sin mensajes del cliente, en línea con la ventana de
  atención habitual de WhatsApp.
- El bot atiende en un único idioma, el de atención del negocio (spec 001).
- El plazo de 30 días de FR-030 cubre con margen el contexto de la conversación (24 horas), la
  detección de duplicados y el límite por número, y deja margen para investigar incidencias; se
  considera compatible con la normativa de protección de datos.
- El operador no revisa ni responde conversaciones desde el panel en esta versión; esa
  funcionalidad, si se necesita, irá en una spec posterior.
- La calidad de las respuestas depende de que la información registrada sea completa; los
  avisos de la spec 001 ayudan al operador a completarla.
- Fuera de alcance: gestión de citas y disponibilidad, derivación activa al negocio, mensajes
  iniciados por el negocio y canales distintos de WhatsApp.
