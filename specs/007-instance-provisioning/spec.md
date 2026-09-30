# Feature Specification: Aprovisionamiento de instancias

**Feature Branch**: `007-instance-provisioning`

**Created**: 2026-09-30

**Status**: Draft

**Ámbito**: Núcleo

**Input**: User description: "Aprovisionamiento de instancias. Herramientas de operación para dar de alta una instancia nueva del núcleo de forma segura: generar un entorno completo con secretos únicos (incluida la clave de las copias de seguridad), crear una base de datos con un usuario propio, validar el entorno antes de desplegar detectando identificadores y secretos repetidos entre instancias, y llevar un inventario de instancias sin secretos en claro. Ámbito: núcleo."

## Contexto

El núcleo no separa clientes dentro de una misma base de datos: **el aislamiento entre clientes
depende por completo de cómo se da de alta cada instancia**. Hoy el alta se hace a mano siguiendo
la guía de [docs/operacion-multicliente.md](../../docs/operacion-multicliente.md) (sección 2), y cada
paso manual puede romper ese aislamiento sin que nada lo avise: un secreto de sesión copiado de otro
cliente, dos instancias apuntando a la misma base de datos, una clave del modelo de lenguaje
compartida, un fichero de entorno incompleto. Desde la feature 006 hay además un identificador de
instancia, un directorio de copias y una clave de cifrado de copias que deben ser únicos y estar
guardados en lugar seguro; un error ahí no se nota hasta el día en que hace falta restaurar.

Esta feature da al operador unas herramientas de operación, iguales para todas las instancias, que
convierten el alta en un proceso guiado y comprobable: generar el entorno con secretos nuevos, crear
la base de datos con un usuario propio, validar el entorno antes de desplegar comparándolo con el
resto de instancias, y llevar un inventario que no contiene ningún secreto en claro. Es la propuesta
P1 de la guía y se necesita antes de dar de alta el segundo cliente.

Las herramientas son de operación: se ejecutan en el equipo del operador (o donde él las lance),
no forman parte del servicio que atiende a los clientes finales y no cambian su comportamiento.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - El operador valida un entorno antes de desplegar (Priority: P1)

Antes de arrancar una instancia (nueva o tras tocar su entorno), el operador pasa su fichero de
entorno por la validación. Obtiene una lista de problemas, cada uno con la variable afectada y qué
hacer, separados en **errores** (impiden desplegar) y **advertencias** (conviene revisarlas). La
validación comprueba que el entorno está completo y es coherente y, además, que ni el identificador
de la instancia, ni su base de datos, ni ninguno de sus secretos coincide con los de otra instancia
del inventario.

**Why this priority**: es la red de seguridad que protege el aislamiento aunque el entorno se haya
preparado a mano o con otras herramientas; sirve ya para la instancia que existe hoy y para
cualquier cambio posterior de entorno.

**Independent Test**: con un inventario de dos instancias y varios ficheros de entorno preparados
(uno correcto, uno incompleto, uno con el secreto de sesión de otra instancia, uno con la misma base
de datos que otra), ejecutar la validación y comprobar que solo el correcto pasa y que cada fallo
nombra la variable y la instancia con la que coincide, sin mostrar el valor del secreto.

**Acceptance Scenarios**:

1. **Given** un entorno completo de producción con secretos nuevos, **When** el operador lo valida,
   **Then** el resultado es "apto para desplegar", sin errores, y la herramienta termina con éxito.
2. **Given** un entorno sin identificador de instancia, directorio de copias o clave de copias,
   **When** se valida, **Then** hay un error por cada variable que falta y el resultado es "no apto".
3. **Given** un entorno cuyo secreto de sesión (o clave de copias, o clave del modelo de lenguaje, o
   cualquier otro secreto) es igual al de otra instancia del inventario, **When** se valida,
   **Then** hay un error que nombra la variable y el identificador de la otra instancia, y en ningún
   caso muestra el valor del secreto.
4. **Given** un entorno con el mismo identificador de instancia o la misma base de datos (mismo
   servidor, puerto y nombre) que otra instancia del inventario, **When** se valida, **Then** hay un
   error que nombra la instancia con la que coincide.
5. **Given** un entorno con la clave de copias igual al secreto de sesión, o con la URL pública sin
   `https`, o con solo parte de las variables de WhatsApp, o con el servidor de correo sin
   remitente, **When** se valida, **Then** hay un error por cada incoherencia.
6. **Given** un entorno de una instancia ya registrada en el inventario, **When** se valida,
   **Then** sus propios valores no cuentan como repetidos (solo se compara con las demás).
7. **Given** una validación correcta, **When** el operador pide la salida en formato legible por
   máquinas, **Then** obtiene el mismo resultado estructurado (apto o no, errores y advertencias),
   también sin valores secretos.

---

### User Story 2 - El operador genera el entorno de una instancia nueva (Priority: P1)

El operador indica los datos mínimos de la instancia nueva (identificador, URL pública, zona
horaria, región telefónica, moneda, teléfono de emergencia y si usará WhatsApp) y obtiene un fichero
de entorno completo de producción, construido a partir de la plantilla de entorno del núcleo, con
todos los secretos generados en ese momento: secreto de sesión, clave de copias, credencial del
operador del panel (contraseña nueva y su huella para el entorno) y, si usa WhatsApp, el token de
verificación del webhook. Los valores que solo puede aportar un tercero (clave del modelo de
lenguaje, credenciales de WhatsApp, servidor de correo) quedan señalados como pendientes. Al
terminar, la instancia queda registrada en el inventario en estado "en alta".

**Why this priority**: elimina la causa más común de secretos repetidos (copiar el entorno de otro
cliente) y garantiza que la clave de copias existe desde el primer día.

**Independent Test**: generar dos entornos seguidos para dos instancias distintas y comprobar que
están completos según la plantilla, que ningún secreto se repite entre ellos ni con el inventario,
que la contraseña del operador se muestra una sola vez y no queda guardada en ningún fichero, y que
la validación de la historia 1 solo marca como pendientes los valores de terceros.

**Acceptance Scenarios**:

1. **Given** unos datos mínimos válidos, **When** el operador genera el entorno, **Then** obtiene un
   fichero con todas las variables de la plantilla, en modo producción, con secretos nuevos, y la
   instancia aparece en el inventario como "en alta" con las huellas de sus secretos.
2. **Given** un identificador de instancia con formato inválido o ya presente en el inventario,
   **When** el operador intenta generar el entorno, **Then** se rechaza sin escribir nada y se
   explica el motivo.
3. **Given** un teléfono de emergencia que no es un número internacional válido, una zona horaria
   inexistente o una URL pública sin `https`, **When** se genera, **Then** se rechaza indicando el
   dato erróneo.
4. **Given** que ya existe un fichero en la ruta de salida, **When** se genera, **Then** no se
   sobrescribe y se pide otra ruta.
5. **Given** una ruta de salida dentro del repositorio del núcleo que no está excluida del control
   de versiones, **When** se genera, **Then** se rechaza para que el entorno no pueda acabar
   publicado.
6. **Given** un entorno generado, **When** termina la herramienta, **Then** muestra una sola vez la
   contraseña del operador y recuerda qué hacer a continuación: guardar el fichero y la clave de
   copias en el gestor de secretos, crear la base de datos, completar los valores pendientes y
   validar.

---

### User Story 3 - El operador crea la base de datos de la instancia con un usuario propio (Priority: P2)

Para una instancia registrada en el inventario, el operador pide crear su base de datos. Con unas
credenciales de administración del servidor que se usan solo durante la ejecución, se crean una base
de datos nueva y vacía y un usuario con contraseña aleatoria que es su propietario y el único que
puede conectarse a ella. La dirección de conexión resultante se escribe en el fichero de entorno de
la instancia y el inventario guarda qué base de datos es (servidor, puerto, nombre y usuario, sin
contraseña). Si el operador no puede o no quiere dar credenciales de administración (por ejemplo,
en un servidor gestionado por un proveedor), puede pedir en su lugar las instrucciones exactas para
ejecutarlas él mismo.

**Why this priority**: una base de datos compartida es la rotura de aislamiento más grave, pero hoy
ya puede hacerse a mano con la guía; esta historia la hace repetible y sin errores.

**Independent Test**: en un servidor de pruebas, crear las bases de datos de dos instancias y
comprobar que cada usuario puede conectarse solo a la suya, que ninguna otra cuenta sin privilegios
puede conectarse a ellas, y que un segundo intento con el mismo nombre se rechaza sin tocar la
existente.

**Acceptance Scenarios**:

1. **Given** una instancia "en alta" sin base de datos, **When** el operador la crea con
   credenciales de administración, **Then** existen una base de datos vacía y un usuario propio,
   el usuario no puede conectarse a otras bases de datos de instancias, y la dirección de conexión
   queda en el fichero de entorno.
2. **Given** que ya existe una base de datos o un usuario con ese nombre en el servidor, **When** se
   pide crearla, **Then** se rechaza sin modificar nada de lo existente (nunca se reutiliza ni se
   vacía una base de datos).
3. **Given** el modo "solo instrucciones", **When** el operador lo pide, **Then** recibe las órdenes
   exactas a ejecutar y la dirección de conexión resultante, y no se conecta a ningún servidor.
4. **Given** un fallo a mitad de la creación, **When** termina la herramienta, **Then** no quedan
   una base de datos o un usuario a medio crear, o se informa exactamente de qué quedó creado.
5. **Given** las credenciales de administración usadas, **When** termina la herramienta, **Then**
   no quedan guardadas en ningún fichero ni en el inventario.

---

### User Story 4 - El operador consulta y mantiene el inventario de instancias (Priority: P2)

El operador tiene un único inventario local, fuera del repositorio, con todas sus instancias:
identificador, cliente, URL pública, versión de la imagen desplegada, espacio de trabajo del
proveedor del modelo de lenguaje, dónde está guardada la clave de copias, fechas de alta y de baja,
estado, y fecha y resultado de la última verificación de copia. El inventario guarda **huellas** de
los secretos para poder detectar repeticiones, pero ningún secreto en claro ni nada que permita
recuperarlo. El operador puede listar las instancias, registrar una instancia que ya existía antes
de esta feature a partir de su fichero de entorno, anotar el resultado de una verificación de copia,
actualizar los datos descriptivos, pasar una instancia a "activa" y darla de baja.

**Why this priority**: sin inventario no hay con qué comparar; pero la comparación de la historia 1
solo necesita las huellas, y el resto de datos descriptivos sustituye a una lista que hoy el
operador lleva a mano.

**Independent Test**: registrar una instancia existente desde su entorno, anotar una verificación
de copia a partir de la salida estructurada de la verificación de la 006, listar y dar de baja; en
cada paso comprobar que el inventario no contiene ningún valor secreto (buscando en él los valores
de los entornos usados).

**Acceptance Scenarios**:

1. **Given** una instancia desplegada antes de esta feature, **When** el operador la registra desde
   su fichero de entorno, **Then** entra en el inventario con sus huellas y datos descriptivos, y
   si alguno de sus secretos coincide con el de otra instancia registrada se avisa de ello.
2. **Given** el resultado estructurado de una verificación de copia de una instancia, **When** el
   operador lo anota, **Then** el inventario guarda la fecha, el fichero y el resultado, y rechaza el
   resultado si es de otra instancia.
3. **Given** un inventario con instancias, **When** el operador lo lista, **Then** ve cada instancia
   con su estado, versión, fecha de la última verificación de copia y un aviso para las que llevan
   más de 31 días sin verificación correcta.
4. **Given** una instancia dada de baja, **When** después se genera o valida otra instancia, **Then**
   el identificador, la base de datos y los secretos de la dada de baja siguen contando como usados
   (nunca se reutilizan).
5. **Given** cualquier operación sobre el inventario, **When** se revisa el fichero, **Then** no
   contiene ningún secreto, contraseña ni dirección de conexión con contraseña.

---

### Edge Cases

- **Inventario inexistente**: la primera generación o registro lo crea; la validación sin
  inventario comprueba solo la coherencia del entorno y lo advierte ("no se ha podido comparar con
  otras instancias").
- **Inventario ilegible o con formato inválido**: ninguna herramienta lo sobrescribe; se detienen y
  explican el problema.
- **Dos operaciones a la vez sobre el inventario**: una de ellas espera o falla con un mensaje; el
  inventario nunca queda a medio escribir.
- **Valores pendientes de terceros sin completar**: la validación los trata como error en lo que el
  núcleo exige para arrancar en producción y como advertencia en lo opcional (p. ej. WhatsApp sin
  configurar es válido si no hay ninguna de sus variables).
- **Secreto vacío o de relleno** (texto de ejemplo, valor demasiado corto): error, aunque no esté
  repetido.
- **Secretos que sí se pueden compartir**: el servidor de correo de los avisos puede ser el mismo
  del operador para varias instancias; su coincidencia es una advertencia, no un error.
- **Misma base de datos escrita de dos formas** (nombre de servidor distinto que resuelve al mismo
  sitio): la comparación es por servidor, puerto y nombre tal como están escritos; el caso de alias
  queda documentado como limitación y cubierto por el usuario propio de cada base de datos.
- **Directorio de copias repetido** entre instancias del mismo servidor: advertencia (las copias
  llevan el identificador de instancia y no se mezclan, pero borrar el volumen de una afectaría a
  la otra).
- **El operador pierde el fichero de entorno generado**: los secretos no se pueden recuperar del
  inventario; se regeneran con una nueva generación para esa instancia, y la clave de copias
  antigua se conserva solo si estaba guardada en el gestor de secretos.
- **Instancia de desarrollo o de pruebas del operador**: se puede registrar en el inventario para
  que sus secretos cuenten, marcada como tal; la validación de modo producción no se le exige.

## Requirements *(mandatory)*

### Functional Requirements

#### Validación del entorno

- **FR-001**: Las herramientas MUST validar un fichero de entorno y dar un resultado "apto" o "no
  apto", con la lista de errores y advertencias; cada entrada MUST nombrar la variable afectada y
  la acción que corrige el problema.
- **FR-002**: La validación MUST exigir las variables que el núcleo necesita para arrancar en
  producción, incluidas el identificador de instancia, el directorio de copias y la clave de copias,
  y el modo producción.
- **FR-003**: La validación MUST comprobar la coherencia del entorno según las reglas del núcleo:
  URL pública con `https`; variables de WhatsApp todas o ninguna; servidor de correo y remitente
  juntos; clave del modelo de lenguaje presente si hay WhatsApp; teléfono de emergencia en formato
  internacional válido; zona horaria existente; retención de copias y hora de la copia diaria en
  sus rangos; proxy de confianza nunca configurado como "confiar en todo"; clave de copias distinta
  del secreto de sesión; y formato del identificador de instancia.
- **FR-004**: La validación MUST rechazar secretos vacíos, de relleno o con menos entropía de la que
  exige su tipo.
- **FR-005**: La validación MUST comparar el entorno con todas las demás instancias del inventario
  (incluidas las dadas de baja) y marcar como **error** cualquier coincidencia de identificador de
  instancia, de base de datos (servidor, puerto y nombre), de usuario de base de datos, de secreto
  de sesión, de clave de copias (actual o anteriores), de credencial del operador, de clave del
  modelo de lenguaje, de credenciales de WhatsApp, del número de WhatsApp o de URL pública.
- **FR-006**: La validación MUST marcar como **advertencia** las coincidencias que pueden ser
  legítimas: servidor de correo de avisos y directorio de copias.
- **FR-007**: Ningún resultado, mensaje ni registro de las herramientas MUST mostrar el valor de un
  secreto; las coincidencias se describen por variable e instancia.
- **FR-008**: La validación MUST ofrecer, además de la salida para personas, una salida
  estructurada con el mismo contenido, y terminar con un código de salida distinto según sea apto
  o no apto, para poder usarla en un proceso de despliegue.
- **FR-009**: La validación MUST NOT modificar el fichero de entorno ni el inventario.

#### Generación del entorno

- **FR-010**: Las herramientas MUST generar el fichero de entorno de una instancia nueva a partir de
  la plantilla de entorno del núcleo, pidiendo solo: identificador de instancia, nombre del cliente
  (solo para el inventario), URL pública, zona horaria, región telefónica, moneda, teléfono de
  emergencia, si usa WhatsApp y directorio de copias (con un valor por defecto).
- **FR-011**: La generación MUST crear en ese momento, con una fuente aleatoria segura, el secreto
  de sesión, la clave de copias, la contraseña del operador (y su huella en el formato que espera el
  núcleo) y, si usa WhatsApp, el token de verificación del webhook; y MUST comprobar antes de
  escribir que ninguno coincide con el inventario.
- **FR-012**: La contraseña del operador MUST mostrarse una sola vez al terminar y MUST NOT quedar
  escrita en ningún fichero; el entorno solo contiene su huella.
- **FR-013**: La generación MUST dejar los valores que aporta un tercero (clave del modelo de
  lenguaje, credenciales de WhatsApp, servidor de correo, dirección de la base de datos si aún no se
  ha creado) vacíos y señalados como pendientes, y el resto de variables con los valores por
  defecto de la plantilla.
- **FR-014**: La generación MUST rechazar datos inválidos (identificador con formato incorrecto o ya
  usado, teléfono no válido, zona horaria inexistente, URL sin `https`) sin escribir nada.
- **FR-015**: La generación MUST NOT sobrescribir un fichero existente y MUST rechazar una ruta de
  salida dentro del repositorio del núcleo que no esté excluida del control de versiones.
- **FR-016**: El fichero generado MUST quedar legible solo por el usuario que lo generó, en los
  sistemas que lo permitan.
- **FR-017**: Al terminar, la generación MUST registrar la instancia en el inventario en estado "en
  alta" y mostrar los siguientes pasos del alta, incluido guardar la clave de copias fuera del
  directorio de copias.

#### Creación de la base de datos

- **FR-018**: Las herramientas MUST crear, para una instancia del inventario, una base de datos
  nueva y un usuario nuevo con contraseña aleatoria, propietario de esa base de datos, y retirar el
  permiso general de conexión a ella para que solo ese usuario (y la administración del servidor)
  pueda conectarse.
- **FR-019**: La creación MUST rechazar la operación sin cambiar nada si ya existe en el servidor
  una base de datos o un usuario con ese nombre; MUST NOT reutilizar, vaciar ni borrar ninguna base
  de datos.
- **FR-020**: Las credenciales de administración MUST usarse solo durante la ejecución y MUST NOT
  guardarse en ningún fichero ni en el inventario.
- **FR-021**: La creación MUST escribir la dirección de conexión en el fichero de entorno de la
  instancia (sin tocar el resto de variables) y guardar en el inventario la identidad de la base de
  datos sin contraseña.
- **FR-022**: Las herramientas MUST ofrecer un modo "solo instrucciones" que produce las órdenes
  exactas equivalentes sin conectarse a ningún servidor.
- **FR-023**: Si la creación falla a mitad, MUST deshacer lo creado o informar exactamente de lo que
  quedó creado.

#### Inventario

- **FR-024**: El inventario MUST ser un único fichero local, en una ubicación configurable fuera del
  repositorio del núcleo, con un formato legible por personas.
- **FR-025**: Por cada instancia, el inventario MUST guardar: identificador, nombre del cliente, URL
  pública, estado (en alta, activa, de pruebas, dada de baja), versión de la imagen desplegada,
  espacio de trabajo del proveedor del modelo de lenguaje, dónde está guardada la clave de copias
  (texto descriptivo), identidad de la base de datos sin contraseña, directorio de copias, fechas de
  alta y de baja, fecha, fichero y resultado de la última verificación de copia, y las huellas de
  sus secretos.
- **FR-026**: Las huellas MUST permitir detectar que dos secretos son iguales sin permitir recuperar
  ni comprobar por fuerza bruta el secreto a partir del inventario.
- **FR-027**: El inventario MUST NOT contener ningún secreto, contraseña ni dirección de conexión con
  contraseña.
- **FR-028**: Las herramientas MUST permitir: listar instancias; registrar una instancia existente a
  partir de su fichero de entorno (avisando de coincidencias); actualizar sus datos descriptivos y
  su estado; anotar el resultado estructurado de una verificación de copia de la feature 006
  (rechazándolo si es de otra instancia); y dar de baja una instancia.
- **FR-029**: Una instancia dada de baja MUST permanecer en el inventario y sus identificadores y
  huellas MUST seguir contando como usados.
- **FR-030**: El listado MUST señalar las instancias activas sin una verificación de copia correcta
  en los últimos 31 días.
- **FR-031**: Las escrituras en el inventario MUST ser atómicas y MUST NOT sobrescribir un
  inventario que no se ha podido leer.
- **FR-032**: Si un fichero de entorno registrado cambia sus secretos (rotación), el operador MUST
  poder actualizar sus huellas conservando las anteriores como usadas.

#### Generales

- **FR-033**: Las herramientas MUST NOT contener nombres ni lógica de un sector o cliente
  (Principio I); los nombres de cliente solo existen en el inventario del operador.
- **FR-034**: Las herramientas MUST NOT cambiar el comportamiento de una instancia en ejecución ni
  ser necesarias para que una instancia arranque.
- **FR-035**: La guía de operación multicliente y el README MUST describir el alta con estas
  herramientas, sustituyendo los pasos manuales equivalentes.

### Key Entities

- **Fichero de entorno de instancia**: la configuración de despliegue de una instancia (base de
  datos, secretos, canales, copias). Vive fuera del repositorio, en el gestor de secretos del
  operador. Contiene secretos en claro.
- **Instancia (en el inventario)**: el registro descriptivo de una instancia: identificador,
  cliente, URL, estado, versión, base de datos sin contraseña, directorio de copias, fechas, última
  verificación de copia y huellas de sus secretos. No contiene secretos.
- **Huella de secreto**: valor derivado de un secreto que solo sirve para saber si otro secreto es
  igual; asociada a la variable de origen y a si es vigente o anterior.
- **Inventario**: el conjunto de instancias del operador, en un único fichero local.
- **Resultado de validación**: apto / no apto, con errores y advertencias por variable y, en las
  coincidencias, la instancia con la que se coincide.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Dar de alta una instancia nueva hasta tener un entorno validado y su base de datos
  creada lleva menos de 15 minutos, sin contar los valores que aportan terceros.
- **SC-002**: En un conjunto de prueba con cada tipo de repetición (identificador, base de datos y
  cada secreto) y cada incoherencia listada en FR-003, la validación detecta el 100 % como error y
  no da como apto ninguno de esos entornos.
- **SC-003**: Un entorno generado y completado con los valores de terceros pasa la validación sin
  errores en el primer intento.
- **SC-004**: En 100 entornos generados seguidos, ningún secreto se repite.
- **SC-005**: Buscar en el inventario y en todas las salidas de las herramientas los valores
  secretos de los entornos usados en las pruebas devuelve 0 coincidencias.
- **SC-006**: En las pruebas, el usuario de base de datos de una instancia no puede conectarse a la
  base de datos de ninguna otra instancia creada con estas herramientas.
- **SC-007**: El operador puede responder desde el listado del inventario, sin abrir ningún otro
  documento, qué instancias hay, en qué estado, con qué versión y cuáles llevan más de un mes sin
  verificar su copia.

## Assumptions

- El destinatario de las herramientas es el operador/desarrollador del producto, con acceso a una
  terminal y al repositorio del núcleo; no hay interfaz en el panel.
- Crear la infraestructura (máquina, contenedor, volumen, dominio, certificado) y elegir proveedor
  quedan fuera de alcance; el directorio de copias se da como una ruta y su existencia en el
  destino no se comprueba desde el equipo del operador.
- La contraseña del operador se genera siempre aleatoria (no la teclea el operador): así es única
  por instancia y su huella en el inventario no se puede atacar por fuerza bruta. El comando actual
  para calcular la huella a partir de una contraseña tecleada sigue existiendo para cambios
  posteriores.
- Las huellas se calculan con una clave propia del inventario, que se crea con el inventario y se
  guarda fuera de él; sin esa clave el inventario no permite comparar, y perderla obliga a
  registrar de nuevo las instancias desde sus entornos. El mecanismo concreto se decide en el plan.
- El inventario se guarda en el equipo del operador; hacer copia de él y de su clave es
  responsabilidad del operador (no contiene secretos, pero sí nombres de clientes).
- La creación de base de datos se hace contra un servidor compatible con el del núcleo y con una
  cuenta con permiso para crear bases de datos y usuarios; en servidores gestionados sin ese
  permiso se usa el modo "solo instrucciones".
- La versión de la imagen y el espacio de trabajo del proveedor del modelo de lenguaje los anota el
  operador a mano; la propuesta P6 automatizará la consulta de versiones a partir de este
  inventario.
- La verificación de copias es la de la feature 006 y su salida estructurada es la que se anota en
  el inventario.
- La rotación automática de secretos, el despliegue y la baja automática (borrado de base de datos y
  copias) quedan fuera de alcance; la baja solo cambia el estado en el inventario.
