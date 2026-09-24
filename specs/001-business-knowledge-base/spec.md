# Feature Specification: Base de conocimiento del negocio

**Feature Branch**: `001-business-knowledge-base`

**Created**: 2026-09-24

**Status**: Draft

**Ámbito**: Núcleo (genérico, aplica a todos los clientes)

**Input**: User description: "Base de conocimiento del negocio. El bot necesita la información de cada negocio para responder y gestionar citas. El negocio se la facilita al operador, que la registra en la instancia de ese cliente. Información: datos del negocio, horario y cierres puntuales, servicios, recursos que atienden citas, preguntas frecuentes, políticas, tono del bot y contacto para derivaciones. Fuera de alcance: que el negocio edite su propia información, la carga automática desde webs o documentos y los campos específicos de un sector."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Registrar datos, horario y servicios de un negocio (Priority: P1)

El operador recibe del negocio su información básica y la registra en la instancia de ese
cliente: nombre, dirección, indicaciones para llegar, teléfono, email, horario semanal de
apertura, cierres puntuales (festivos, vacaciones) y el catálogo de servicios con su
descripción, precio, duración y si se pueden reservar.

**Why this priority**: sin estos datos el bot no puede responder a las preguntas más
habituales (dónde estáis, cuándo abrís, cuánto cuesta) ni ofrecer citas. Es el mínimo
imprescindible para poner en marcha una instancia.

**Independent Test**: registrar un negocio de ejemplo con sus datos, horario y tres
servicios (uno de precio fijo, uno "desde" y uno "a consultar") y comprobar que el bot
dispone de toda esa información sin que se haya tocado código ni desplegado nada nuevo.

**Acceptance Scenarios**:

1. **Given** una instancia sin información registrada, **When** el operador registra nombre,
   dirección, cómo llegar, teléfono y email del negocio, **Then** esos datos quedan
   disponibles para el bot sin cambios de código.
2. **Given** un negocio registrado, **When** el operador define el horario semanal (por
   ejemplo, lunes a viernes de 9:00 a 14:00 y de 16:00 a 20:00, sábados de 10:00 a 14:00),
   **Then** el horario queda disponible para el bot, incluidos los días con varias franjas y
   los días cerrados.
3. **Given** un negocio registrado, **When** el operador añade un cierre puntual (un festivo
   o un periodo de vacaciones), **Then** ese cierre queda disponible para el bot y prevalece
   sobre el horario habitual en esas fechas.
4. **Given** un negocio registrado, **When** el operador añade un servicio con nombre,
   descripción, tipo de precio, duración e indicación de si es reservable, **Then** el
   servicio queda disponible para el bot con todos sus datos.
5. **Given** que el operador intenta guardar un dato inválido (por ejemplo, una franja cuya
   hora de fin es anterior a la de inicio, o un precio negativo), **When** guarda, **Then**
   el sistema rechaza el dato e indica qué campo debe corregirse.

---

### User Story 2 - Modificar cualquier dato registrado (Priority: P1)

El negocio comunica un cambio (sube un precio, cambia el horario de verano, deja de ofrecer
un servicio) y el operador lo actualiza en la instancia. Desde ese momento el bot trabaja con
el dato nuevo.

**Why this priority**: la información de un negocio cambia a menudo. Un dato obsoleto hace
que el bot dé información falsa en nombre del negocio, lo que contradice el principio de
responder solo con información registrada y veraz.

**Independent Test**: con un negocio ya registrado, cambiar el precio de un servicio y el
horario de un día, y comprobar que la siguiente respuesta del bot sobre esos datos usa los
valores nuevos.

**Acceptance Scenarios**:

1. **Given** un servicio con precio de 20 €, **When** el operador lo cambia a 25 €, **Then**
   toda respuesta del bot generada después de guardar el cambio usa 25 €, también dentro de
   conversaciones que ya estaban abiertas.
2. **Given** un servicio registrado, **When** el operador lo elimina, **Then** el bot deja de
   ofrecerlo y de mencionarlo en las respuestas posteriores al cambio.
3. **Given** cualquier dato de la base de conocimiento (datos del negocio, horario, cierres,
   servicios, recursos, preguntas frecuentes, políticas, tono o contacto de derivación),
   **When** el operador lo modifica, **Then** el cambio se aplica sin cambios de código ni
   nuevo despliegue.

---

### User Story 3 - Registrar recursos con sus servicios y horarios (Priority: P2)

El operador registra los recursos que atienden citas (profesionales, puestos, agentes),
indica qué servicios presta cada uno y define su horario de atención.

**Why this priority**: permite gestionar citas en negocios con varias agendas. Los negocios
con una sola agenda pueden funcionar sin este paso, por eso va después de P1.

**Independent Test**: registrar dos recursos con servicios distintos y horarios distintos y
comprobar que cada uno queda asociado solo a sus servicios y con su propio horario.

**Acceptance Scenarios**:

1. **Given** un negocio con los servicios A, B y C, **When** el operador registra el recurso
   "Profesional 1" asociado a A y B, **Then** ese recurso queda asociado solo a A y B y no
   figura como disponible para C.
2. **Given** un recurso registrado, **When** el operador define su horario (por ejemplo,
   solo mañanas de lunes a miércoles), **Then** ese horario queda asociado al recurso de forma
   independiente del horario de otros recursos.
3. **Given** un recurso registrado, **When** el operador le añade una ausencia puntual (por
   ejemplo, una semana de vacaciones), **Then** la ausencia queda disponible para el bot y
   prevalece sobre el horario del recurso en esas fechas.
4. **Given** un negocio sin recursos registrados, **When** el bot consulta con quién se
   atiende un servicio reservable, **Then** el negocio se trata como una agenda única que
   presta todos sus servicios reservables en el horario de apertura.

---

### User Story 4 - Registrar preguntas frecuentes, políticas, tono y contacto de derivación (Priority: P2)

El operador registra las preguntas frecuentes con su respuesta, las políticas del negocio
(cancelación, antelación mínima y máxima para reservar, formas de pago), el tono con el que
debe expresarse el bot y el contacto del negocio al que derivar al cliente cuando pide
hablar con una persona.

**Why this priority**: amplía lo que el bot puede responder sin inventar y fija las reglas de
reserva y derivación, pero el bot ya aporta valor con los datos de P1.

**Independent Test**: registrar dos preguntas frecuentes, las políticas y el contacto de
derivación, y comprobar que el bot dispone de todo ello.

**Acceptance Scenarios**:

1. **Given** un negocio registrado, **When** el operador añade una pregunta frecuente con su
   respuesta, **Then** queda disponible para el bot.
2. **Given** un negocio registrado, **When** el operador define una política de cancelación,
   una antelación mínima de 2 horas y una máxima de 30 días para reservar y las formas de pago
   aceptadas, **Then** esas políticas quedan disponibles para el bot.
3. **Given** un negocio registrado, **When** el operador define el tono (forma de trato,
   de tú o de usted, y una descripción del estilo), **Then** el tono queda disponible para el
   bot.
4. **Given** un negocio registrado, **When** el operador define el contacto de derivación
   (teléfono, WhatsApp o email, y horario en el que se atiende), **Then** ese contacto queda
   disponible para el mecanismo de derivación del bot.

---

### User Story 5 - Aviso de datos incompletos (Priority: P3)

El sistema revisa la base de conocimiento del negocio y avisa al operador de los datos que
faltan o son incoherentes, para que pueda completarlos antes de que afecten a la atención.

**Why this priority**: mejora la calidad de los datos, pero el operador puede registrar y
mantener un negocio sin esta ayuda.

**Independent Test**: registrar un servicio reservable sin duración y un negocio sin horario,
y comprobar que el operador recibe un aviso por cada uno.

**Acceptance Scenarios**:

1. **Given** un servicio marcado como reservable, **When** no tiene duración, **Then** el
   sistema muestra al operador un aviso que identifica el servicio y el dato que falta.
2. **Given** un negocio, **When** no tiene horario de apertura definido, **Then** el sistema
   muestra un aviso al operador.
3. **Given** un negocio con avisos pendientes, **When** el operador completa los datos que
   faltan, **Then** los avisos correspondientes desaparecen.
4. **Given** un dato incompleto, **When** el operador guarda, **Then** el aviso no impide
   guardar el resto de la información.

---

### Edge Cases

- **Precio variable o "a consultar"**: el servicio admite tres tipos de precio: fijo (un
  importe), "desde" (un importe mínimo) y "a consultar" (sin importe). Un servicio "a
  consultar" no requiere importe y el bot no debe dar ninguna cifra para él. Un precio
  "desde" o fijo sin importe genera aviso.
- **Negocio con una sola agenda y sin recursos diferenciados**: registrar recursos es
  opcional. Si no hay ninguno, el negocio funciona como agenda única con su horario de
  apertura y todos sus servicios reservables. No se genera aviso por no tener recursos.
- **Cierres puntuales que se solapan con el horario habitual**: un cierre puntual prevalece
  sobre el horario habitual durante su vigencia. Puede ser de día completo, de varios días o
  parcial (solo unas horas de un día). Si dos cierres se solapan entre sí, se aplica la unión
  de ambos.
- **Horario de un recurso fuera del horario del negocio**: el sistema avisa al operador de
  las franjas del recurso que caen fuera del horario de apertura.
- **Servicio reservable sin ningún recurso que lo preste** (en un negocio que sí tiene
  recursos): el sistema avisa al operador.
- **Eliminación de un servicio asociado a recursos**: al eliminar el servicio se eliminan
  también sus asociaciones con recursos.
- **Servicio reservable con datos incompletos**: mientras falte la duración, el servicio no se
  ofrece para reserva, aunque el bot sí puede informar sobre él.
- **Falta el contacto de derivación**: se usa el teléfono general del negocio y el sistema
  avisa al operador. Si tampoco hay teléfono, el aviso se marca como crítico, porque la salida
  a una persona es obligatoria.
- **Antelación mínima mayor que la máxima**: el sistema rechaza la política como dato
  inválido.

## Requirements *(mandatory)*

### Functional Requirements

**Datos del negocio**

- **FR-001**: El operador MUST poder registrar y modificar los datos del negocio: nombre,
  dirección, indicaciones para llegar, teléfono y email.
- **FR-002**: El sistema MUST validar el formato del teléfono y del email y rechazar los
  valores mal formados.

**Horario y cierres**

- **FR-003**: El operador MUST poder definir el horario de apertura semanal, con una o varias
  franjas por día y días sin apertura.
- **FR-004**: El operador MUST poder registrar cierres puntuales con fecha o rango de fechas,
  de día completo o parciales (rango horario), y un motivo opcional.
- **FR-005**: Un cierre puntual MUST prevalecer sobre el horario habitual durante su vigencia.
- **FR-006**: El sistema MUST rechazar franjas horarias cuya hora de fin no sea posterior a
  la de inicio, y cierres cuya fecha de fin sea anterior a la de inicio.

**Servicios**

- **FR-007**: El operador MUST poder registrar, modificar y eliminar servicios con nombre,
  descripción, tipo de precio, importe (cuando corresponda), duración e indicación de si es
  reservable.
- **FR-008**: El tipo de precio MUST ser uno de: fijo (importe exacto), "desde" (importe
  mínimo) o "a consultar" (sin importe). El sistema MUST rechazar importes negativos.
- **FR-009**: Un servicio reservable sin duración MUST NOT ofrecerse para reserva hasta que se
  complete su duración.

**Recursos**

- **FR-010**: El operador MUST poder registrar, modificar y eliminar recursos con un nombre,
  los servicios que presta y su horario de atención.
- **FR-011**: Cada recurso MUST quedar asociado únicamente a los servicios que el operador le
  asigne.
- **FR-012**: El operador MUST poder registrar ausencias puntuales de un recurso, que
  prevalecen sobre su horario durante su vigencia.
- **FR-013**: Registrar recursos MUST ser opcional. Si un negocio no tiene recursos, MUST
  tratarse como una agenda única que presta todos sus servicios reservables en el horario de
  apertura.

**Preguntas frecuentes, políticas, tono y derivación**

- **FR-014**: El operador MUST poder registrar, modificar y eliminar preguntas frecuentes, cada
  una con su pregunta y su respuesta.
- **FR-015**: El operador MUST poder registrar las políticas del negocio: política de
  cancelación (texto y, opcionalmente, plazo mínimo para cancelar sin penalización),
  antelación mínima y máxima para reservar y formas de pago aceptadas.
- **FR-016**: El sistema MUST rechazar una antelación mínima mayor que la máxima.
- **FR-017**: El operador MUST poder definir el tono del bot mediante la forma de trato (tú o
  usted) y una descripción del estilo en texto libre.
- **FR-018**: El operador MUST poder registrar el contacto de derivación del negocio: uno o
  varios medios (teléfono, WhatsApp, email) y, opcionalmente, el horario en que se atiende.
- **FR-019**: Si no hay contacto de derivación registrado, el sistema MUST usar el teléfono
  general del negocio como contacto de derivación.

**Disponibilidad para el bot y aplicación de cambios**

- **FR-020**: Toda la información registrada MUST quedar disponible para el bot de la
  instancia sin cambios de código ni nuevo despliegue.
- **FR-021**: Cualquier modificación MUST aplicarse a toda respuesta del bot generada después
  de guardarla, incluidas las de conversaciones ya abiertas.
- **FR-022**: La información de un negocio MUST ser accesible solo desde la instancia de ese
  negocio.
- **FR-023**: Solo el operador MUST poder registrar o modificar la información. El sistema
  MUST NOT ofrecer al negocio ningún medio para editarla.
- **FR-024**: El modelo de información MUST ser genérico y válido para cualquier sector, sin
  campos propios de un sector concreto.

**Avisos de datos incompletos**

- **FR-025**: El sistema MUST avisar al operador, como mínimo, en estos casos:
  - un servicio reservable sin duración;
  - un negocio sin horario de apertura;
  - un servicio con precio fijo o "desde" sin importe;
  - un servicio reservable que ningún recurso presta, en negocios con recursos;
  - un recurso con franjas horarias fuera del horario del negocio;
  - un negocio sin contacto de derivación.
- **FR-026**: Cada aviso MUST identificar el elemento afectado y el dato que falta o es
  incoherente.
- **FR-027**: Los avisos MUST NOT impedir guardar la información. Un aviso MUST desaparecer
  cuando se corrige el dato que lo origina.
- **FR-028**: Si un negocio no tiene ni contacto de derivación ni teléfono general, el aviso
  MUST marcarse como crítico.

### Key Entities *(include if feature involves data)*

- **Negocio**: el cliente al que atiende la instancia. Contiene nombre, dirección,
  indicaciones para llegar, teléfono, email y zona horaria. Hay uno por instancia.
- **Horario de apertura**: franjas semanales en las que el negocio está abierto. Cada día
  puede tener cero, una o varias franjas.
- **Cierre puntual**: periodo (fecha o rango, completo o parcial) en el que el negocio no
  atiende, con un motivo opcional. Prevalece sobre el horario de apertura.
- **Servicio**: lo que el negocio ofrece. Contiene nombre, descripción, tipo de precio
  (fijo, "desde" o "a consultar"), importe opcional, duración e indicación de si es
  reservable.
- **Recurso**: quien atiende las citas (profesional, puesto, agente). Contiene nombre,
  servicios que presta, horario propio y ausencias puntuales. Se relaciona con varios
  servicios, y un servicio puede prestarlo más de un recurso.
- **Pregunta frecuente**: par de pregunta y respuesta.
- **Políticas**: política de cancelación, antelación mínima y máxima para reservar y formas de
  pago. Hay un conjunto por negocio.
- **Tono**: forma de trato y descripción del estilo del bot. Hay uno por negocio.
- **Contacto de derivación**: medios y horario para que el cliente hable con una persona del
  negocio. Hay uno por negocio.
- **Aviso**: indica al operador un dato incompleto o incoherente. Contiene el elemento
  afectado, la descripción y la gravedad (normal o crítica).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: El operador registra la información completa de un negocio típico (datos,
  horario, 10 servicios, 3 recursos, 10 preguntas frecuentes, políticas, tono y contacto) en
  menos de 30 minutos.
- **SC-002**: Dar de alta un negocio nuevo o modificar sus datos requiere cero cambios de
  código y cero despliegues.
- **SC-003**: El 100 % de las respuestas del bot generadas después de guardar un cambio
  reflejan el dato nuevo.
- **SC-004**: El 100 % de los casos de datos incompletos enumerados en FR-025 generan un aviso
  visible para el operador.
- **SC-005**: Negocios de al menos tres sectores distintos (por ejemplo, una clínica, una
  peluquería y un taller) se registran con el mismo modelo de información, sin campos
  adicionales.
- **SC-006**: Ningún recurso figura como disponible para un servicio que no tiene asignado.

## Assumptions

- Hay un único usuario de esta funcionalidad, el operador del sistema. Su identificación y
  acceso siguen el mecanismo estándar de administración de la instancia.
- Cada instancia atiende a un único negocio con una única ubicación. Los negocios con varias
  sedes quedan fuera de esta versión.
- Cada negocio opera en una única zona horaria, registrada con sus datos.
- Los importes se expresan en una única moneda por negocio, por defecto el euro.
- La información se registra en un único idioma, el de atención al cliente del negocio.
- No se exige historial de versiones de la información. Basta con registrar la fecha de la
  última modificación de cada elemento.
- Esta spec define qué información existe y cómo se mantiene. Cómo usa el bot esa información
  para conversar, calcular disponibilidad o gestionar citas se define en specs posteriores.
  Esta spec solo fija las reglas de los datos (prevalencia de cierres, agenda única sin
  recursos, servicio sin duración no reservable).
- Qué ocurre con las citas ya reservadas cuando cambian un servicio, un recurso o un horario
  se trata en la spec de gestión de citas.
- Fuera de alcance: que el negocio edite su propia información, la carga automática desde
  webs o documentos y los campos específicos de un sector.
