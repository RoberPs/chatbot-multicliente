# Feature Specification: Versión visible y actualización escalonada

**Feature Branch**: `009-version-health-rollout`

**Created**: 2026-10-01

**Status**: Draft

**Ámbito**: Núcleo

**Input**: User description: "Exponer la versión del núcleo y del esquema de base de datos en el panel y en un endpoint de salud (/health) sin datos sensibles, consultar desde el inventario de instancias qué versión corre cada una y definir el procedimiento de publicación escalonada con instancia de pruebas, comprobación tras cada actualización y vuelta atrás con la copia previa a la migración. Ámbito: núcleo (propuesta P6 de docs/operacion-multicliente.md)."

## Contexto

Una versión nueva de la imagen del núcleo llega a **todos** los clientes y las migraciones se aplican
solas al arrancar. Con una sola instancia basta con mirar el contenedor; con dos o más, el operador
necesita saber qué versión corre cada una para actualizar por tandas, comprobar que cada
actualización ha ido bien y poder volver atrás si algo falla. Hoy no hay forma de saberlo sin entrar
en cada servidor: el panel no muestra la versión, no existe un endpoint de salud y el inventario
(feature 007) anota la versión que el operador *dice* haber desplegado, no la que de verdad corre.

Ya está cubierto por la feature 006: la copia previa a cada migración (sin ella la instancia no migra
ni arranca) y la regla de migraciones de solo añadir. Esta feature añade lo que falta para usarlas
con seguridad en un parque de instancias: **ver** la versión (en cada instancia y desde el
inventario) y **seguir un procedimiento** de publicación con comprobaciones y vuelta atrás.

Es la propuesta P6 de [docs/operacion-multicliente.md](../../docs/operacion-multicliente.md). Es de
operación: no cambia lo que el bot responde ni lo que ven los clientes finales.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Una instancia declara su versión y su estado (Priority: P1)

El operador (o una herramienta suya) consulta una instancia y obtiene, sin iniciar sesión, un
resumen mínimo: su estado de salud, la versión del núcleo que corre y la versión del esquema de base
de datos aplicada. El mismo dato aparece en el panel `/admin` de la instancia, para el operador que
ya está dentro.

**Why this priority**: es la base de todo lo demás. Sin que cada instancia declare qué versión corre,
ni el comando del inventario ni la comprobación posterior a una actualización tienen de dónde leer.

**Independent Test**: arrancar una instancia, consultar su endpoint de salud y su panel, y comprobar
que la versión del núcleo y la del esquema coinciden con las del código desplegado y la base de datos;
parar la base de datos y comprobar que el estado pasa a "degradado" sin exponer detalles del fallo.

**Acceptance Scenarios**:

1. **Given** una instancia arrancada con la base de datos disponible y las migraciones aplicadas,
   **When** se consulta su endpoint de salud sin credenciales, **Then** responde "correcto" con la
   versión del núcleo, la versión del esquema y el identificador de la instancia, y nada más.
2. **Given** una instancia cuya base de datos no responde, **When** se consulta el endpoint de salud,
   **Then** responde "degradado" con un código que lo distingue de "correcto", sigue indicando la
   versión del núcleo y no revela la causa técnica, direcciones ni credenciales.
3. **Given** el operador con sesión iniciada, **When** abre el panel, **Then** ve en un lugar fijo la
   versión del núcleo y la del esquema de esa instancia.
4. **Given** una instancia cuyo esquema está en una versión distinta de la que espera el núcleo que
   corre, **When** se consulta la salud, **Then** el estado es "degradado" y ambas versiones son
   visibles para el operador.
5. **Given** cualquier consulta de salud, **When** se inspecta la respuesta, **Then** no contiene
   conversaciones, teléfonos, nombres de negocio o de cliente, configuración, secretos, variables de
   entorno ni rutas del servidor.

---

### User Story 2 - El operador ve de un vistazo qué versión corre cada instancia (Priority: P2)

El operador lanza una orden de operación que recorre las instancias del inventario, consulta la salud
de cada una y muestra una tabla con: instancia, cliente, estado, versión del núcleo y del esquema
que *corre de verdad*, versión que el inventario tiene anotada, y si coinciden. Marca las que no
responden, las degradadas, las que no coinciden con lo anotado y las que responden con un
identificador de instancia distinto del esperado (URL apuntando a otra instancia).

**Why this priority**: es lo que hace seguras las actualizaciones por tandas con varias instancias;
depende de la historia 1.

**Independent Test**: con un inventario de tres instancias (una en la versión nueva, una en la
anterior, una apagada), ejecutar la orden y comprobar que la tabla refleja cada situación, que una
caída no impide ver las demás y que el código de salida indica si hay algo que revisar.

**Acceptance Scenarios**:

1. **Given** un inventario con varias instancias activas, **When** el operador ejecuta la orden,
   **Then** obtiene una fila por instancia con su estado y versiones, y las instancias de baja no
   se consultan.
2. **Given** una instancia que no responde dentro del tiempo límite, **When** se ejecuta la orden,
   **Then** esa fila aparece como "no responde" y el resto se consulta con normalidad.
3. **Given** una instancia cuya versión real difiere de la anotada en el inventario, **When** se
   ejecuta la orden, **Then** la fila lo marca como discrepancia y, por defecto, el inventario no se
   modifica.
4. **Given** una URL del inventario que responde con el identificador de otra instancia,
   **When** se ejecuta la orden, **Then** se marca como error de identidad y la versión no se
   atribuye a la instancia esperada.
5. **Given** una instancia anterior a esta feature que no tiene endpoint de salud, **When** se
   ejecuta la orden, **Then** aparece como "sin información de versión" y no como caída.
6. **Given** que el operador lo pide expresamente, **When** la orden termina, **Then** puede anotar
   en el inventario la versión observada de las instancias que coinciden en identidad, tras mostrarle
   qué va a cambiar.
7. **Given** cualquier ejecución, **When** se revisa la salida (también en formato máquina), **Then**
   no contiene secretos ni datos de clientes finales.

---

### User Story 3 - Procedimiento de publicación escalonada con vuelta atrás (Priority: P3)

El operador dispone de un procedimiento escrito y comprobable para publicar una versión nueva:
comprobaciones previas (tests, evaluación, etiquetado semántico), despliegue en la instancia de
pruebas, actualización de los clientes por tandas, comprobación tras cada instancia con la orden de
la historia 2 y el panel, criterios para parar la tanda, y vuelta atrás con la imagen anterior y la
copia previa a la migración.

**Why this priority**: sin las historias 1 y 2 el procedimiento no puede apoyarse en datos; con
ellas, convierte la sección 5 de la guía de operación en pasos con criterios de "listo" y "parar".

**Independent Test**: un operador que no ha participado en la feature sigue el procedimiento con una
instancia de pruebas y una instancia de ensayo, publica una versión, detecta una actualización
fallida simulada y vuelve atrás sin ayuda, usando solo la guía.

**Acceptance Scenarios**:

1. **Given** una versión nueva lista, **When** el operador sigue el procedimiento, **Then** cada paso
   tiene una comprobación observable (una orden y el resultado esperado) y un criterio explícito de
   continuar o parar.
2. **Given** una actualización cuya instancia queda degradada o en una versión distinta de la
   esperada, **When** el operador consulta el procedimiento, **Then** sabe si debe detener la tanda,
   cómo volver a la etiqueta anterior y cuándo restaurar la copia previa a la migración.
3. **Given** una actualización con migraciones, **When** el operador termina el procedimiento,
   **Then** queda indicado repetir la comprobación de la copia previa (guía de validación de copias)
   y anotar la nueva versión en el inventario.

---

### Edge Cases

- **Arranque o migración en curso**: mientras la instancia aplica migraciones o no ha terminado de
  arrancar, la consulta no debe dar "correcto"; debe indicar un estado no listo, distinguible de
  una caída.
- **Migración bloqueada** (`migration_blocked`, sin copia previa): la instancia no arranca y por tanto
  no responde; la orden del inventario la muestra como "no responde" y el procedimiento indica dónde
  mirar el motivo.
- **Esquema más nuevo que el núcleo** (tras volver atrás a una imagen anterior sin restaurar): la
  instancia se declara degradada y el operador ve ambas versiones.
- **Instancias sin URL o sin `https`** en el inventario: se informa y no se consulta.
- **Inventario vacío o sin instancias activas**: mensaje claro, sin error técnico.
- **Muchas instancias**: la consulta es concurrente y acotada en tiempo; una instancia lenta no
  retrasa la lista completa más que su propio tiempo límite.
- **Consultas repetidas o abusivas al endpoint de salud**: no deben degradar la atención a clientes
  finales ni escribir datos.
- **Respuesta de salud malformada o de un servidor que no es el núcleo**: se trata como "respuesta
  no válida", nunca como versión.
- **Versión del núcleo no disponible** (compilación sin versión definida): la instancia no puede
  arrancar en producción con versión desconocida, o la declara claramente como tal; nunca inventa
  una.

## Requirements *(mandatory)*

### Functional Requirements

**Versión y salud de cada instancia**

- **FR-001**: Cada instancia MUST exponer un endpoint de salud sin autenticación que devuelva el
  estado (correcto, degradado o no listo), la versión del núcleo, la versión del esquema de base de
  datos y el identificador de la instancia.
- **FR-002**: El endpoint de salud MUST NOT devolver ni registrar datos de clientes finales,
  conversaciones, configuración del negocio, nombres de negocio o cliente, secretos, variables de
  entorno, rutas del servidor, direcciones de la base de datos ni detalles de errores internos.
- **FR-003**: El estado MUST distinguirse también por el código de respuesta, de modo que una
  herramienta externa pueda decidir sin interpretar el contenido: correcto con éxito; degradado o no
  listo con un código de error de servicio.
- **FR-004**: El estado MUST ser "correcto" solo si la base de datos responde y la versión del esquema
  aplicado es la que corresponde a la versión del núcleo que corre; en cualquier otro caso MUST ser
  "degradado" o "no listo".
- **FR-005**: La versión del núcleo MUST proceder de una única fuente fijada al construir la imagen y
  coincidir con la etiqueta de la imagen que se despliega; la versión del esquema MUST proceder de lo
  realmente aplicado en la base de datos de la instancia.
- **FR-006**: La consulta de salud MUST ser de solo lectura, no modificar ningún dato y responder de
  forma rápida sin afectar a la atención a clientes finales.
- **FR-007**: El panel del operador MUST mostrar la versión del núcleo y la del esquema de la
  instancia en un lugar fijo, visible tras iniciar sesión.
- **FR-008**: El comportamiento del bot, los canales y la configuración del negocio MUST permanecer
  inalterados por esta feature.

**Versión de todas las instancias desde el inventario**

- **FR-009**: El sistema MUST ofrecer una orden de operación que consulte, a partir del inventario de
  instancias (feature 007), la salud de cada instancia que no esté dada de baja y muestre su estado,
  versión del núcleo, versión del esquema y la versión anotada en el inventario.
- **FR-010**: La orden MUST marcar por separado: no responde, respuesta no válida, degradada o no
  lista, discrepancia con la versión anotada, e identificador de instancia distinto del esperado;
  una instancia anterior a esta feature MUST aparecer como "sin información de versión".
- **FR-011**: La orden MUST consultar las instancias de forma concurrente, con un tiempo límite por
  instancia, y un fallo en una MUST NOT impedir mostrar las demás.
- **FR-012**: La orden MUST ser de solo lectura sobre las instancias y, por defecto, sobre el
  inventario; solo anotará las versiones observadas en el inventario si el operador lo pide
  expresamente y tras mostrarle los cambios.
- **FR-013**: La orden MUST ofrecer salida legible para personas y salida en formato máquina, y un
  código de salida que distinga "todo coincide y correcto" de "hay algo que revisar".
- **FR-014**: La salida de la orden MUST NOT contener secretos ni datos de clientes finales, y MUST
  atribuir una versión a una instancia solo si la respuesta trae el identificador esperado.
- **FR-015**: La orden MUST rechazar consultar direcciones que no sean `https` salvo que el operador
  lo permita expresamente para un entorno local de pruebas.

**Procedimiento de publicación escalonada**

- **FR-016**: La guía de operación MUST incluir un procedimiento de publicación con estas etapas en
  orden: comprobaciones previas (tests, evaluación, etiquetado semántico, nunca `latest`),
  instancia de pruebas, tandas pequeñas de clientes, comprobación tras cada instancia y cierre.
- **FR-017**: Cada etapa MUST indicar la comprobación concreta (orden o pantalla), el resultado que
  se espera y el criterio para continuar o detener la tanda.
- **FR-018**: El procedimiento MUST describir la vuelta atrás: volver a la etiqueta anterior si la
  migración no se aplicó y, si ya se aplicó y no es compatible hacia atrás, parar la instancia y
  restaurar con la imagen anterior la copia previa a la migración que nombra el error.
- **FR-019**: El procedimiento MUST cerrar cada actualización con la repetición de la comprobación de
  copias (guía de validación de copias) cuando haya habido migraciones, y con la anotación de la
  nueva versión en el inventario.
- **FR-020**: La guía de operación, el README y el inventario MUST reflejar los cambios (nueva orden,
  endpoint de salud y estado de la feature).

### Key Entities

- **Versión del núcleo**: identificador semántico de la imagen que corre en una instancia; único para
  todas las instancias del mismo despliegue y coincidente con la etiqueta de la imagen.
- **Versión del esquema**: la última migración realmente aplicada a la base de datos de la instancia;
  puede diferir de la que espera el núcleo (tras volver atrás o con una migración pendiente).
- **Informe de salud**: resumen sin datos sensibles de una instancia: estado, versión del núcleo,
  versión del esquema e identificador de instancia.
- **Estado de la instancia**: correcto, degradado (algo falla pero responde) o no listo (arrancando o
  migrando). "No responde" lo atribuye la herramienta del inventario, no la instancia.
- **Registro del inventario**: ya existe (007); aquí se compara su versión anotada con la observada.
- **Informe de versiones**: resultado de la orden: una fila por instancia con estado, versiones,
  discrepancias y errores de identidad.
- **Tanda de actualización**: grupo reducido de instancias que se actualizan y comprueban antes de
  seguir con el siguiente.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: El operador conoce la versión del núcleo y del esquema de cualquier instancia en menos
  de 10 segundos, desde su panel o desde la orden del inventario, sin entrar en el servidor.
- **SC-002**: Con 10 instancias en el inventario, el informe de versiones completo está disponible en
  menos de 1 minuto, incluso si una o varias no responden.
- **SC-003**: El 100 % de las respuestas del endpoint de salud, en todos los estados, se limita a los
  campos acordados; una revisión de datos prohibidos (conversaciones, teléfonos, nombres, secretos,
  rutas, errores internos) no encuentra ninguno.
- **SC-004**: El 100 % de las instancias con base de datos caída, esquema distinto del esperado o
  arranque incompleto se reportan como no correctas; ninguna se reporta como correcta por error.
- **SC-005**: Tras cada actualización, el operador sabe en menos de 2 minutos por instancia si ha
  quedado en la versión esperada y en estado correcto.
- **SC-006**: Un operador que no ha participado en la feature completa un ensayo de publicación en
  dos instancias y una vuelta atrás simulada siguiendo solo la guía, sin consultar al desarrollador.
- **SC-007**: Ninguna versión se atribuye a una instancia equivocada: en un ensayo con una URL
  deliberadamente cruzada, el informe lo detecta en el 100 % de los casos.

## Assumptions

- La feature 007 (inventario de instancias con URL y versión anotada) y la 006 (copia previa a la
  migración, restauración) están completadas y se reutilizan sin cambios de comportamiento.
- El endpoint de salud es público y solo expone los campos mínimos acordados (estado, versiones e
  identificador de instancia); si se prefiriera protegerlo con un secreto compartido, se tratará en
  la clarificación o en el plan.
- El identificador de instancia (no secreto) se incluye para poder detectar URLs cruzadas; no
  identifica al cliente por sí solo.
- La versión del núcleo es semántica y se fija una sola vez al construir la imagen; coincide con la
  etiqueta que anota el operador en el inventario.
- Las instancias anteriores a esta feature no tienen endpoint de salud; se actualizan a esta versión
  como cualquier otra y, hasta entonces, se muestran como "sin información de versión".
- La orden de consulta se ejecuta en el equipo del operador, con el inventario y su clave igual que
  el resto de herramientas de la 007; no requiere secretos de las instancias.
- El procedimiento de publicación es documentación comprobable; no automatiza despliegues ni elige
  proveedor de hosting o de contenedores.
- Fuera de alcance: despliegue automático, orquestación de contenedores, alertas o monitorización
  continua, métricas de rendimiento y consumo (propuesta P4) y puntos de extensión (propuesta P5).
