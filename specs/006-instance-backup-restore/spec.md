# Feature Specification: Copias de seguridad y restauración por instancia

**Feature Branch**: `006-instance-backup-restore`

**Created**: 2026-09-29

**Status**: Draft

**Ámbito**: Núcleo

**Input**: User description: "Copias de seguridad y restauración de la base de datos de una instancia, con copia previa obligatoria a las migraciones, cifrado, retención configurable compatible con el borrado de conversaciones a los 30 días y un procedimiento de restauración verificable. Ámbito: núcleo."

## Contexto

Cada instancia guarda en su propia base de datos todo lo que no es código: la configuración del
negocio que registra el operador, las conversaciones de los últimos 30 días, las derivaciones y la
configuración de los canales. Hoy no hay forma prevista de copiarla ni de recuperarla, y al arrancar
una versión nueva del núcleo las migraciones se aplican solas: un fallo en una migración o un error
del operador puede dejar a un cliente sin su configuración y sin forma de volver atrás.

Esta feature da al operador una forma única, igual para todas las instancias, de hacer copias
cifradas, guardarlas durante un tiempo limitado, restaurarlas y comprobar que se pueden restaurar.
Es la propuesta P3 de [docs/operacion-multicliente.md](../../docs/operacion-multicliente.md) y es
requisito para el primer cliente real.

## Clarifications

### Session 2026-09-29

- Q: ¿Cuánto tiempo se conservan las copias, por defecto y como máximo? → A: 7 días por defecto y
  30 como máximo. Una conversación borrada de la instancia puede seguir, como mucho, 30 días más en
  una copia.
- Q: ¿Hace la instancia copias automáticas periódicas? → A: Sí, una copia diaria a una hora local
  configurable, además de las copias bajo demanda y las previas a migraciones.
- Q: ¿Dónde se guardan las copias? → A: Solo en un directorio configurable de la instancia. En el
  despliegue, ese directorio está en el almacenamiento del hosting o VPS; sacar las copias fuera de
  esa máquina (volumen con réplica o instantáneas del proveedor, sincronización) es cosa de la
  plataforma, no del núcleo.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - El operador hace una copia de una instancia (Priority: P1)

El operador pide una copia de la instancia en cualquier momento (antes de un cambio grande de
configuración, antes de actualizar o al cerrar un alta). Obtiene un único fichero cifrado cuyo
nombre dice de qué instancia es, con qué versión del esquema se hizo y cuándo, y un resumen de lo
que contiene sin datos personales.

**Why this priority**: sin una copia no hay nada que restaurar; es la pieza mínima que ya protege a
un cliente real.

**Independent Test**: con una instancia con datos de ejemplo, pedir una copia y comprobar que se
crea un único fichero, que su contenido no es legible sin la clave y que el nombre y el resumen
identifican instancia, versión del esquema y fecha.

**Acceptance Scenarios**:

1. **Given** una instancia en funcionamiento con negocio, servicios y conversaciones, **When** el
   operador pide una copia, **Then** se crea un fichero cifrado con toda la base de datos de la
   instancia y se informa de su nombre, tamaño, versión del esquema y número de elementos por tipo
   (negocio, servicios, conversaciones…), sin textos, teléfonos ni nombres.
2. **Given** una instancia en funcionamiento, **When** se hace la copia mientras el bot atiende
   mensajes, **Then** la copia refleja un estado coherente de un único instante y el bot sigue
   atendiendo sin interrupción.
3. **Given** que falta la clave de cifrado o no es válida, **When** el operador pide una copia,
   **Then** no se crea ningún fichero y se indica qué falta.
4. **Given** que no hay espacio o el destino no es escribible, **When** el operador pide una copia,
   **Then** no queda ningún fichero a medias que pueda confundirse con una copia válida y se indica
   el motivo.

---

### User Story 2 - El operador restaura una copia (Priority: P1)

Tras un fallo o un error, el operador restaura una copia en la instancia. La instancia queda
exactamente como estaba cuando se hizo la copia, salvo las conversaciones que desde entonces han
superado los 30 días, que se borran antes de que el bot vuelva a atender.

**Why this priority**: una copia que no se puede restaurar no protege nada; junto con la historia 1
forma el mínimo útil.

**Independent Test**: hacer una copia, cambiar datos del negocio y borrar un servicio, restaurar la
copia y comprobar que el panel y la vista del bot muestran exactamente lo que había al hacer la
copia.

**Acceptance Scenarios**:

1. **Given** una copia válida de la misma instancia y la instancia parada, **When** el operador la
   restaura, **Then** la base de datos queda idéntica a la del momento de la copia y se informa del
   número de elementos restaurados por tipo.
2. **Given** una copia que contiene conversaciones que hoy ya superan los 30 días sin mensajes,
   **When** se restaura, **Then** esas conversaciones se borran antes de que la instancia vuelva a
   atender a nadie.
3. **Given** una copia hecha con una versión del esquema anterior a la del núcleo instalado,
   **When** se restaura y la instancia arranca, **Then** se aplican las migraciones pendientes con
   las mismas garantías de la historia 3.
4. **Given** una copia hecha con una versión del esquema posterior a la del núcleo instalado,
   **When** el operador intenta restaurarla, **Then** se rechaza sin tocar la base de datos y se
   indica qué versión del núcleo hace falta.
5. **Given** una copia de otra instancia, **When** el operador intenta restaurarla, **Then** se
   rechaza sin tocar la base de datos, salvo que el operador confirme de forma explícita que quiere
   restaurar una copia de otra instancia (por ejemplo, para montar una instancia de pruebas).
6. **Given** una copia dañada, incompleta o una clave incorrecta, **When** se intenta restaurar,
   **Then** se detecta antes de modificar nada y la base de datos queda como estaba.
7. **Given** que la restauración falla a mitad, **When** termina, **Then** la base de datos queda
   como estaba antes de empezar, nunca a medias.

---

### User Story 3 - Copia obligatoria antes de las migraciones (Priority: P1)

Al arrancar una versión nueva del núcleo con migraciones pendientes, la instancia hace una copia
antes de aplicarlas. Si no puede hacerla, no migra ni arranca, y lo dice.

**Why this priority**: las actualizaciones llegan a todos los clientes a la vez y las migraciones se
aplican solas; es el momento de más riesgo y hoy no tiene red.

**Independent Test**: arrancar una instancia con una migración pendiente y comprobar que antes de
aplicarla existe una copia nueva con la versión anterior del esquema; repetir sin clave de cifrado y
comprobar que la instancia no arranca y el esquema no ha cambiado.

**Acceptance Scenarios**:

1. **Given** una instancia con datos y migraciones pendientes, **When** arranca, **Then** hace una
   copia etiquetada como previa a la migración, con la versión del esquema anterior, y solo después
   aplica las migraciones.
2. **Given** una instancia sin migraciones pendientes, **When** arranca, **Then** no hace copia y
   arranca como hasta ahora.
3. **Given** una instancia nueva con la base de datos vacía, **When** arranca por primera vez,
   **Then** no hace copia (no hay nada que proteger) y aplica las migraciones.
4. **Given** migraciones pendientes y la copia falla (sin clave, sin espacio, destino no
   escribible), **When** la instancia arranca, **Then** no aplica ninguna migración, no empieza a
   atender y registra el motivo; el esquema queda sin cambios.
5. **Given** que la copia previa se hizo y la migración falla, **When** el operador lo revisa,
   **Then** tiene la copia previa identificada para restaurarla con la versión anterior del núcleo.

---

### User Story 4 - Las copias caducan (Priority: P2)

Las copias se borran solas cuando superan el periodo de retención configurado, para que los datos
personales no vivan en las copias mucho más de lo que viven en la instancia.

**Why this priority**: es lo que hace compatibles las copias con el borrado de conversaciones a los
30 días, pero una instancia con pocas copias manuales puede empezar sin ello.

**Independent Test**: con copias de distintas fechas y un periodo de retención configurado,
comprobar que se borran exactamente las que lo superan y que nunca se borra la más reciente.

**Acceptance Scenarios**:

1. **Given** copias más antiguas que el periodo de retención, **When** se aplica la retención,
   **Then** se borran esas copias y se informa de cuántas.
2. **Given** que todas las copias superan el periodo, **When** se aplica la retención, **Then** se
   conserva la más reciente válida para no dejar la instancia sin ninguna.
3. **Given** un periodo de retención por encima del máximo permitido, **When** la instancia arranca
   o el operador pide una copia, **Then** se rechaza la configuración y se indica el máximo.
4. **Given** una copia previa a una migración, **When** se aplica la retención, **Then** sigue las
   mismas reglas que las demás copias.

5. **Given** que no se configura el periodo, **When** se aplica la retención, **Then** se usan 7
   días; el operador puede configurar entre 1 y 30 días.

---

### User Story 5 - El operador comprueba que una copia se puede restaurar (Priority: P2)

Sin tocar la instancia en producción, el operador comprueba que una copia concreta se descifra, está
completa y se puede restaurar, y obtiene un informe que puede anotar en su inventario. Un
procedimiento documentado explica cómo hacerlo de forma periódica.

**Why this priority**: una copia no verificada puede fallar justo cuando hace falta; es la
diferencia entre "tener copias" y "poder recuperarse".

**Independent Test**: comprobar una copia válida y una dañada y verificar que el informe distingue
ambas sin modificar la base de datos de la instancia.

**Acceptance Scenarios**:

1. **Given** una copia válida, **When** el operador la comprueba, **Then** se restaura en un espacio
   temporal separado de la instancia, se informa de versión del esquema, fecha y elementos por
   tipo, y el espacio temporal se elimina al terminar.
2. **Given** una copia dañada o una clave incorrecta, **When** el operador la comprueba, **Then** el
   informe dice que no es restaurable y por qué.
3. **Given** cualquier comprobación, **When** termina, **Then** la base de datos de la instancia no
   ha cambiado.
4. **Given** la guía de validación, **When** el operador la sigue de principio a fin, **Then** hace
   una copia, la comprueba, la restaura en una instancia de pruebas y confirma en su panel que los
   datos coinciden.

---

### User Story 6 - Copias periódicas automáticas (Priority: P3)

Además de las copias bajo demanda y las previas a migraciones, la instancia hace sola una copia al
día a la hora local configurada, sin que el operador tenga que acordarse.

**Why this priority**: protege frente a errores del día a día, pero las historias 1 a 3 ya dan una
red mínima con copias manuales.

**Independent Test**: con una hora de copia configurada y el reloj adelantado, comprobar que se
crea una copia diaria etiquetada como periódica, que no se crean dos el mismo día y que la
retención las borra como a las demás.

**Acceptance Scenarios**:

1. **Given** una instancia en funcionamiento con la copia diaria a una hora configurada, **When**
   llega esa hora en la zona horaria del negocio, **Then** se hace una copia etiquetada como
   periódica y el bot sigue atendiendo.
2. **Given** que la instancia estaba parada a la hora de la copia, **When** arranca más tarde ese
   mismo día, **Then** hace la copia del día que faltaba; nunca hace más de una copia periódica al
   día.
3. **Given** que la copia periódica falla, **When** ocurre, **Then** se registra el motivo sin datos
   personales, el bot sigue atendiendo y se reintenta en la siguiente ocasión prevista.
4. **Given** que no se configura hora, **When** la instancia arranca, **Then** la copia diaria se
   hace a una hora por defecto de madrugada (03:00 hora local).

---

### Edge Cases

- Se pide una copia mientras otra está en curso: la segunda espera o se rechaza con un mensaje
  claro; nunca se mezclan en un mismo fichero.
- Se pide restaurar con la instancia atendiendo: se rechaza hasta que la instancia esté parada, para
  que no entren mensajes a mitad de la restauración.
- Se pierde la clave de cifrado: las copias hechas con ella no se pueden recuperar; así se
  documenta, y la clave se guarda aparte de las copias.
- Se cambia la clave de cifrado: las copias nuevas usan la nueva; las anteriores siguen necesitando
  la anterior hasta que caducan.
- Dos instancias comparten por error la misma clave o el mismo destino de copias: cada copia lleva
  el identificador de su instancia y la retención de una instancia solo toca sus propias copias.
- Un fichero ajeno o con nombre parecido en el destino de las copias: no se trata como copia ni se
  borra en la retención.
- Restaurar una copia de una instancia con el negocio activo cuyo estado ya no cumple los avisos
  críticos del núcleo instalado: se restaura tal cual y el panel muestra los avisos; la
  restauración no cambia el estado del negocio por su cuenta.
- La restauración trae derivaciones activas y plazos vencidos durante el tiempo sin copia: al volver
  a arrancar se aplican las reglas habituales de la derivación (vuelta al bot, recordatorios) con la
  hora real.
- Los registros técnicos de copias, retención y restauraciones no contienen textos, teléfonos,
  nombres ni la clave.

## Requirements *(mandatory)*

### Functional Requirements

**Copia**

- **FR-001**: El operador MUST poder hacer una copia completa de la base de datos de una instancia
  en cualquier momento, sin parar la instancia.
- **FR-002**: Cada copia MUST ser un estado coherente de un único instante.
- **FR-003**: Cada copia MUST estar cifrada con una clave propia de la instancia, que no se guarda
  junto a las copias; sin la clave, el contenido no se puede leer.
- **FR-004**: El nombre de cada copia MUST identificar la instancia, la versión del esquema, la
  fecha y hora y el motivo (bajo demanda, previa a migración o periódica), sin datos personales.
- **FR-005**: Cada copia MUST llevar dentro, protegidos contra manipulación, el identificador de la
  instancia, la versión del esquema, la versión del núcleo y la fecha, para que la restauración y la
  comprobación los validen sin fiarse del nombre del fichero.
- **FR-006**: Una copia fallida MUST NOT dejar un fichero que pueda confundirse con una copia
  válida.
- **FR-007**: La operación MUST informar al terminar del nombre, tamaño, versión del esquema y
  número de elementos por tipo, sin datos personales.

**Restauración**

- **FR-008**: El operador MUST poder restaurar una copia en una instancia parada; con la instancia
  atendiendo, la restauración MUST rechazarse.
- **FR-009**: Antes de modificar nada, la restauración MUST comprobar que la copia se descifra, está
  íntegra, pertenece a esta instancia y tiene una versión de esquema igual o anterior a la del
  núcleo instalado.
- **FR-010**: Restaurar una copia de otra instancia MUST requerir una confirmación explícita del
  operador que nombre la instancia de origen.
- **FR-011**: La restauración MUST ser total o nula: si falla, la base de datos queda como estaba.
- **FR-012**: Tras restaurar, las conversaciones que ya superan los 30 días sin mensajes MUST
  borrarse antes de que la instancia atienda ningún mensaje.
- **FR-013**: La restauración MUST NOT activar ni desactivar el negocio ni los canales por su cuenta:
  la instancia queda con el estado que tenía la copia.

**Copia previa a las migraciones**

- **FR-014**: Al arrancar con migraciones pendientes y datos existentes, la instancia MUST hacer una
  copia antes de aplicar la primera migración.
- **FR-015**: Si esa copia no se puede hacer, la instancia MUST NOT aplicar ninguna migración ni
  empezar a atender, y MUST registrar el motivo.
- **FR-016**: Sin migraciones pendientes, o con la base de datos vacía, el arranque MUST NOT hacer
  copia.
- **FR-017**: La copia previa a la migración MUST poder restaurarse con la versión del núcleo
  anterior a la actualización.

**Retención**

- **FR-018**: Las copias MUST borrarse automáticamente al superar el periodo de retención
  configurado: 7 días por defecto, entre 1 y 30 días; un valor fuera de ese rango MUST rechazarse.
- **FR-019**: La retención MUST conservar siempre la copia válida más reciente de la instancia.
- **FR-020**: La retención MUST tocar solo copias de la propia instancia y MUST ignorar cualquier
  otro fichero del destino.

**Comprobación**

- **FR-021**: El operador MUST poder comprobar una copia restaurándola en un espacio temporal
  separado, sin modificar la instancia, y obtener un informe de validez con versión del esquema,
  fecha y elementos por tipo.
- **FR-022**: Una guía de validación MUST describir el ciclo completo (copiar, comprobar, restaurar
  en una instancia de pruebas y confirmar en el panel) y con qué frecuencia repetirlo.

**Copia periódica**

- **FR-026**: La instancia MUST hacer una copia periódica al día a la hora local configurada en la
  zona horaria del negocio (03:00 por defecto), sin interrumpir la atención.
- **FR-027**: Si la instancia no estaba en marcha a la hora prevista, MUST hacer la copia del día al
  arrancar; MUST NOT hacer más de una copia periódica por día.
- **FR-028**: Un fallo de la copia periódica MUST registrarse sin datos personales y MUST NOT
  detener la atención.

**Generales**

- **FR-023**: Las operaciones de copia, restauración, comprobación y retención MUST ser las mismas
  para todas las instancias y MUST NOT contener nada específico de un cliente o sector.
- **FR-024**: Los registros técnicos de estas operaciones MUST NOT contener textos de mensajes,
  teléfonos, nombres, la clave ni fragmentos del contenido de la copia.
- **FR-025**: Las copias MUST guardarse en un directorio configurable de la instancia; el núcleo
  MUST NOT enviarlas a ningún almacenamiento externo. Si el directorio no existe o no es escribible,
  las operaciones de copia MUST fallar con un mensaje claro.

### Key Entities

- **Copia**: fichero cifrado con toda la base de datos de una instancia en un instante. Atributos:
  instancia, versión del esquema, versión del núcleo, fecha y hora, motivo (bajo demanda, previa a
  migración, periódica), tamaño y resumen de elementos por tipo.
- **Clave de cifrado de la instancia**: secreto propio de cada instancia, distinto entre
  instancias, guardado fuera del destino de las copias.
- **Política de retención**: periodo durante el que se conservan las copias (7 días por defecto,
  de 1 a 30), y la regla de conservar siempre la más reciente.
- **Programación de la copia periódica**: hora local diaria (03:00 por defecto) en la zona horaria
  del negocio.
- **Informe de comprobación**: resultado de verificar una copia (restaurable o no, motivo, versión
  del esquema, fecha, elementos por tipo), sin datos personales.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Una copia de una instancia con 30 días de actividad típica de un pequeño negocio
  termina en menos de 1 minuto sin que el bot deje de atender.
- **SC-002**: El 100 % de las copias restauradas en las pruebas reproducen exactamente la
  configuración del negocio y los elementos contados al hacer la copia.
- **SC-003**: En el 100 % de los arranques con migraciones pendientes y datos existentes hay una
  copia previa anterior a la primera migración, o la instancia no arranca y el esquema no cambia.
- **SC-004**: Ninguna copia contiene datos legibles sin la clave de su instancia, y ningún registro
  técnico de estas operaciones contiene datos personales.
- **SC-005**: Ninguna conversación restaurada con más de 30 días sin mensajes llega a estar visible
  para el bot ni en el panel.
- **SC-006**: Ninguna copia sobrevive más de 30 días, salvo la más reciente de cada instancia, y
  con la configuración por defecto ninguna pasa de 7 días.
- **SC-009**: Una instancia en marcha tiene, en el 100 % de los días, una copia periódica de ese día
  o un registro del fallo.
- **SC-007**: El operador completa la guía de validación (copiar, comprobar, restaurar en pruebas y
  confirmar) en menos de 15 minutos la primera vez.
- **SC-008**: Una restauración fallida (copia dañada, clave incorrecta, otra instancia o esquema
  posterior) deja la base de datos sin ningún cambio en el 100 % de los casos probados.

## Assumptions

- El operador es el único que hace copias y restauraciones; el negocio no tiene acceso a ellas
  (Principio VI). No hay pantalla en el panel: son operaciones del operador en la instancia.
- Cada instancia tiene un identificador estable configurado, distinto entre instancias; esta
  feature lo introduce si todavía no existe.
- La clave de cifrado es un secreto más de la instancia, distinto por instancia como los demás, y el
  operador la guarda en su gestor de secretos. Perder la clave hace irrecuperables sus copias.
- La restauración requiere parar la instancia; la parada breve que implica es aceptable.
- La copia incluye toda la base de datos de la instancia, también conversaciones y datos de
  clientes finales; por eso va cifrada y caduca. Exportar solo la configuración del negocio es la
  propuesta P2, fuera de esta feature.
- Las copias son de la base de datos: los ficheros de entorno y los secretos no se copian aquí.
- Las migraciones siguen aplicándose al arrancar, como hasta ahora; esta feature solo añade la copia
  previa y el bloqueo si falla.
- En el despliegue, el directorio de copias está en el almacenamiento del hosting o VPS, en un
  volumen persistente distinto del contenedor. Si ese volumen está en la misma máquina que la base
  de datos, perder la máquina hace perder las copias: el operador debe activar las instantáneas o
  la réplica del proveedor, o sincronizar el directorio fuera. La guía de validación lo recuerda.
- Fuera de alcance: enviar las copias a un almacenamiento externo desde el núcleo, elegir o
  contratar un proveedor de almacenamiento, copias continuas o
  recuperación a un instante arbitrario, y restauración parcial (un solo servicio o una sola
  conversación).
