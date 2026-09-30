# Feature Specification: Exportar e importar la configuración del negocio

**Feature Branch**: `008-config-export-import`

**Created**: 2026-09-30

**Status**: Draft

**Ámbito**: Núcleo

**Input**: User description: "El operador puede exportar la configuración del negocio de una instancia a un fichero y importarla en otra, con validación, vista previa de cambios y aplicación transaccional que respeta los avisos críticos. No incluye conversaciones ni datos de clientes finales, los destinos de avisos solo se incluyen si el operador lo pide y la importación nunca activa el negocio ni los canales. Ámbito: núcleo."

## Contexto

La información de cada negocio (datos, horarios, cierres, servicios y precios, recursos, preguntas
frecuentes, políticas, tono, contacto de derivación y configuración del chat web) vive en la base de
datos de su instancia y solo se puede registrar en el panel de esa instancia. Hoy no hay forma de
prepararla en la instancia de pruebas, revisarla con "Probar el bot" y llevarla después a producción,
ni de guardar una copia legible de la configuración antes de un cambio grande.

La restauración de copias de la feature 006 no sirve para esto: mueve la base de datos entera,
conversaciones de clientes finales incluidas, y está pensada para recuperar la misma instancia o
comprobar copias. Copiar bases de datos entre instancias está prohibido por la guía de operación
([docs/operacion-multicliente.md](../../docs/operacion-multicliente.md), sección 3).

Esta feature permite al operador, desde el panel, **exportar** la configuración del negocio a un
fichero legible y **importarla** en otra instancia (o en la misma) con validación completa, una vista
previa de lo que va a cambiar y una aplicación todo o nada que respeta la regla de avisos críticos
(FR-032 de la 001). Es la propuesta P2 de la guía y se necesita antes del segundo o tercer cliente.

Es una función del operador (Principio VI): el negocio no tiene acceso a ella, y no cambia cómo
responde el bot más allá de que la configuración importada pasa a ser la registrada.

## Clarifications

### Session 2026-09-30

- Q: Al importar, ¿cómo se combina el fichero con la configuración que ya tiene la instancia de
  destino? → A: Reemplazo completo: todas las secciones del destino pasan a ser las del fichero y lo
  que no está en el fichero se elimina; no hay importación por secciones elegidas ni fusión.
- Q: Antes de aplicar una importación, ¿debe el sistema guardar solo la configuración que había en
  el destino para poder deshacerla? → A: Sí, automáticamente: dentro de la misma operación se guarda
  la exportación de la configuración anterior (con destinos de avisos), el resultado ofrece
  descargarla y se conserva solo la de la última importación aplicada.
- Q: ¿Se puede importar en una instancia cuyo negocio ya está activo, o solo en uno en preparación?
  → A: También en activos, sin confirmación adicional: los protegen la vista previa, la regla de
  avisos críticos y la configuración anterior guardada.
- Q: ¿Debe el fichero incluir la configuración del chat web (webs permitidas, enlace de privacidad
  y topes)? → A: Sí, toda; la vista previa advierte de los cambios de webs permitidas y topes cuando
  el chat web del destino está activo.
- Q: ¿La exportación e importación se hacen solo desde el panel, o también con órdenes de terminal?
  → A: Solo desde el panel; una orden de terminal, si hace falta, será otra spec con el mismo formato
  de fichero.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - El operador exporta la configuración del negocio (Priority: P1)

El operador entra en el panel de una instancia y descarga un fichero con toda la configuración del
negocio. Al exportar puede marcar si incluye los destinos de los avisos de derivación; por defecto no
se incluyen. El fichero no contiene conversaciones, mensajes, clientes finales, consumo del chat web
ni ningún secreto de la instancia.

**Why this priority**: sin exportación no hay nada que importar, y por sí sola ya aporta valor: una
copia legible de la configuración antes de un cambio grande o para revisarla fuera del panel.

**Independent Test**: en una instancia con un negocio completo y conversaciones, exportar con y sin
destinos de avisos y comprobar que el fichero contiene toda la configuración, que los destinos solo
aparecen cuando se marcó la opción y que no aparece ningún dato de clientes finales.

**Acceptance Scenarios**:

1. **Given** un negocio con datos, horario semanal, cierres, servicios, recursos, preguntas
   frecuentes, políticas, tono, contacto de derivación y chat web configurados, **When** el
   operador exporta, **Then** descarga un fichero que contiene todos esos elementos, con las
   relaciones entre recursos y servicios, y los metadatos de la exportación (versión del formato,
   instancia de origen, fecha y hora de la exportación).
2. **Given** una instancia con destinos de avisos de derivación configurados, **When** el operador
   exporta sin marcar la opción, **Then** el fichero no contiene esos destinos y lo indica en sus
   metadatos; **When** exporta marcándola, **Then** el fichero los contiene.
3. **Given** una instancia con conversaciones, mensajes y clientes finales de todos los canales,
   **When** el operador exporta, **Then** el fichero no contiene ningún número, nombre, texto de
   mensaje ni identificador de cliente final, ni recuentos de consumo del chat web.
4. **Given** un negocio en preparación o con avisos críticos, **When** el operador exporta, **Then**
   la exportación se permite igualmente y el fichero refleja el estado actual de la configuración.
5. **Given** un usuario sin sesión de operador, **When** intenta exportar, **Then** se le deniega el
   acceso igual que al resto del panel.

---

### User Story 2 - El operador importa un fichero con vista previa y confirmación (Priority: P1)

El operador sube en el panel de la instancia de destino un fichero exportado. El sistema lo valida
entero y, si es válido, muestra una vista previa: qué se añade, qué cambia y qué se elimina en cada
sección, los avisos que tendrá el negocio después de importar y si la importación se podrá aplicar.
Solo al confirmar se aplica, todo o nada. La importación no cambia el estado del negocio ni del chat
web de la instancia de destino.

**Why this priority**: es el objetivo de la feature: preparar y revisar la configuración en pruebas
y llevarla a producción sin reescribirla a mano.

**Independent Test**: exportar la configuración de una instancia de pruebas, importarla en otra con
una configuración distinta, revisar la vista previa, confirmar y comprobar que la configuración del
destino queda igual a la exportada, salvo el estado del negocio, el estado del chat web y los
destinos de avisos no incluidos, que conservan sus valores.

**Acceptance Scenarios**:

1. **Given** un fichero válido, **When** el operador lo sube, **Then** ve, antes de que se cambie
   nada, por cada sección los elementos que se añadirán, modificarán y eliminarán (con el valor
   actual y el nuevo en los campos que cambian), los metadatos del fichero y la lista de avisos que
   tendría el negocio tras importar, con los críticos destacados.
2. **Given** la vista previa de un fichero válido, **When** el operador confirma, **Then** la
   configuración del destino pasa a ser la del fichero en todas las secciones incluidas, en una
   sola operación, y el bot responde desde ese momento con la configuración importada.
3. **Given** la vista previa, **When** el operador cancela o abandona, **Then** no cambia nada en el
   destino.
4. **Given** un negocio de destino en preparación, **When** se importa un fichero de un negocio
   activo, **Then** el negocio de destino sigue en preparación.
5. **Given** un chat web de destino desactivado, **When** se importa un fichero cuyo origen tenía el
   chat web activado, **Then** se importan las webs permitidas, el enlace de privacidad y los topes,
   pero el chat web sigue desactivado.
6. **Given** un negocio de destino activo, **When** la configuración importada le dejaría un aviso
   crítico, **Then** la vista previa lo advierte y dice que la importación será rechazada, y si el
   operador confirma, no cambia nada y se le indica el aviso que lo impide.
9. **Given** una importación aplicada, **When** el operador ve el resultado o vuelve más tarde al
   panel, **Then** puede descargar la configuración que tenía el destino justo antes de importar e
   importarla para deshacer el cambio.
7. **Given** un fichero sin destinos de avisos, **When** se importa, **Then** los destinos de avisos
   del destino se conservan tal como estaban.
8. **Given** un fichero con destinos de avisos, **When** el operador ve la vista previa, **Then** se
   le advierte de que la instancia empezará a enviar los avisos de derivación a esos destinos y
   puede elegir importarlos o no; si no los importa, se conservan los del destino.

---

### User Story 3 - El operador ve rechazado un fichero inválido sin que cambie nada (Priority: P2)

Si el fichero está dañado, no es una exportación, es de una versión del formato que la instancia no
entiende, o algún elemento no cumple las reglas del dominio (un precio negativo, un horario con fin
anterior al inicio, un teléfono no válido…), la importación se rechaza antes de la vista previa con
la lista de errores por sección y elemento, y no cambia nada.

**Why this priority**: protege la instancia de destino, pero la exportación e importación de
ficheros correctos ya aporta el valor principal.

**Independent Test**: subir ficheros manipulados (ilegibles, con campos desconocidos, versión futura,
valores fuera de rango, referencias rotas entre recursos y servicios) y comprobar que cada uno se
rechaza con un error comprensible y que la configuración del destino no cambia.

**Acceptance Scenarios**:

1. **Given** un fichero que no es una exportación válida (formato ilegible o sin los metadatos
   obligatorios), **When** el operador lo sube, **Then** se rechaza con un mensaje que lo dice.
2. **Given** un fichero con una versión del formato posterior a la que entiende la instancia,
   **When** el operador lo sube, **Then** se rechaza indicando que hay que actualizar la instancia
   de destino a una versión del núcleo igual o posterior a la de origen.
3. **Given** un fichero con elementos que no cumplen las reglas del dominio o con referencias rotas
   entre recursos y servicios, **When** el operador lo sube, **Then** se rechaza con la lista
   completa de errores, cada uno con su sección, el elemento afectado y el motivo.
4. **Given** un fichero rechazado, **When** el operador revisa el panel, **Then** la configuración
   y los avisos del destino son los mismos que antes de subirlo.

---

### Edge Cases

- **La configuración del destino cambia entre la vista previa y la confirmación** (otra pestaña,
  otro operador): la confirmación se rechaza sin aplicar nada y se pide volver a generar la vista
  previa.
- **Fichero exportado de la misma instancia**: se permite; sirve para volver a una configuración
  anterior. La vista previa lo indica.
- **Zona horaria o moneda del fichero distinta de la del destino**: se importan las del fichero, y
  la vista previa destaca ese cambio porque afecta a cómo se leen todos los horarios y precios.
- **Fichero de una versión anterior del formato**: se acepta si la instancia sigue entendiendo esa
  versión; los datos que esa versión no tenía se tratan como vacíos o con su valor por defecto, y la
  vista previa lo muestra como cambio.
- **Webs permitidas distintas entre origen y destino con el chat web del destino activo** (por
  ejemplo, una web de pruebas en el origen): se importan las del fichero, y la vista previa advierte
  de las webs que dejarán de poder usar el chat antes de confirmar.
- **Chat web del destino activado y fichero sin webs permitidas o sin enlace de privacidad**: la
  importación se rechaza sin aplicar nada, igual que el panel no deja guardar esa configuración
  con el chat web activado; la vista previa lo anticipa y pide desactivar antes el chat web o
  corregir el fichero.
- **Fichero vacío de una sección** (por ejemplo, sin preguntas frecuentes): se interpreta como que el
  negocio no tiene elementos en esa sección, y la vista previa muestra que se eliminarán los del
  destino.
- **Fichero demasiado grande**: se rechaza antes de procesarlo, con el tamaño máximo en el mensaje.
- **Conversaciones en curso durante la importación**: siguen su curso; cada respuesta posterior a
  la importación usa la configuración importada, y las derivaciones activas no se interrumpen.
- **Destinos de avisos incluidos pero la instancia de destino no tiene la vía configurada** (sin
  WhatsApp o sin correo): se importan igualmente y aparecen los avisos normales que ya existen para
  ese caso.
- **Fallo a mitad de la aplicación** (caída de la conexión con la base de datos, reinicio): no queda
  ninguna parte de la importación aplicada.
- **Fichero con campos que la instancia no conoce dentro de una versión del formato que sí entiende**:
  se rechaza, para no perder datos en silencio.

## Requirements *(mandatory)*

### Functional Requirements

**Contenido del fichero**

- **FR-001**: El sistema MUST permitir al operador, desde el panel, exportar la configuración del
  negocio de la instancia a un único fichero descargable, legible por una persona y con formato
  estable y documentado.
- **FR-002**: El fichero MUST incluir: datos del negocio (salvo su estado), horario semanal, cierres,
  servicios con sus precios y duraciones, recursos con sus servicios, horarios y ausencias, preguntas
  frecuentes, políticas, tono, contacto de derivación con sus canales y horario, y configuración del
  chat web (webs permitidas, enlace de privacidad y topes diarios y mensuales, sin su estado de
  activación). El orden de presentación de cada lista MUST conservarse.
- **FR-003**: El fichero MUST incluir metadatos: versión del formato, identificador de la instancia de
  origen, fecha y hora de la exportación, versión del esquema de datos de origen y si contiene o no
  destinos de avisos de derivación.
- **FR-004**: El fichero MUST NOT contener conversaciones, mensajes, clientes finales, derivaciones y
  sus avisos enviados, recuentos de uso del chat web, credenciales, secretos ni variables de entorno
  de la instancia. El estado del negocio y el estado de activación del chat web se pueden indicar
  como información, pero MUST NOT importarse.
- **FR-005**: Los destinos de los avisos de derivación MUST incluirse solo si el operador lo marca
  expresamente al exportar; por defecto no se incluyen.
- **FR-006**: Los identificadores internos de la instancia de origen MUST NOT ser necesarios para
  importar: las relaciones entre elementos del fichero (recursos y servicios) MUST expresarse de
  forma que se reconstruyan en el destino.

**Validación**

- **FR-007**: El sistema MUST validar el fichero completo antes de mostrar la vista previa, con las
  mismas reglas del dominio que aplica el panel al registrar cada dato (formatos, rangos, teléfonos,
  horarios, importes, enlaces, coherencia entre elementos).
- **FR-008**: Si el fichero no es válido, el sistema MUST rechazarlo sin modificar nada y mostrar
  todos los errores encontrados, cada uno con su sección, el elemento afectado y el motivo.
- **FR-009**: El sistema MUST rechazar ficheros con una versión del formato posterior a la que
  entiende la instancia, y MUST aceptar las versiones anteriores que sigan soportadas.
- **FR-010**: El sistema MUST rechazar ficheros de más de 5 MB y ficheros con campos no
  reconocidos para su versión del formato.

**Vista previa**

- **FR-011**: Antes de aplicar, el sistema MUST mostrar una vista previa con: los metadatos del
  fichero; por sección, los elementos que se añaden, se modifican (con el valor actual y el nuevo de
  cada campo que cambia) y se eliminan; y los cambios de zona horaria y moneda destacados. Si el
  chat web del destino está activo, MUST advertir de forma destacada de cualquier cambio en sus webs
  permitidas (en especial, las que dejarán de poder usar el chat) y en sus topes.
- **FR-012**: La vista previa MUST mostrar los avisos que tendría el negocio tras importar, calculados
  igual que en el panel, con los críticos destacados, y MUST indicar si la importación será rechazada
  por la regla de avisos críticos.
- **FR-013**: Si el fichero contiene destinos de avisos de derivación, la vista previa MUST advertir
  de que la instancia enviará los avisos a esos destinos y MUST permitir al operador elegir si los
  importa; si no los importa, los del destino se conservan.
- **FR-014**: Generar la vista previa MUST NOT modificar nada en la instancia de destino.

**Aplicación**

- **FR-015**: Al confirmar, el sistema MUST aplicar la importación en una sola operación todo o
  nada: o queda aplicada entera o no queda aplicada ninguna parte.
- **FR-016**: La importación MUST reemplazar la configuración del destino en todas las secciones
  (FR-002) a la vez: los elementos del destino que no están en el fichero se eliminan y los del
  fichero se crean o actualizan. El operador MUST NOT poder elegir secciones ni fusionar con la
  configuración del destino; las únicas excepciones son las de FR-017 y FR-021.
- **FR-017**: La importación MUST NOT cambiar el estado del negocio (en preparación o activo) ni el
  estado de activación del chat web del destino, ni nada fuera de la configuración del negocio
  (conversaciones, derivaciones en curso, uso del chat web, entorno).
- **FR-018**: La importación MUST permitirse tanto en negocios en preparación como activos, con el
  mismo flujo de vista previa y confirmación. Si el negocio del destino está activo y la
  configuración resultante tiene algún aviso crítico, la importación MUST rechazarse sin aplicar
  nada, indicando los avisos que lo impiden (FR-032 de la 001). Del mismo modo, si el chat web del
  destino está activado y el fichero no trae webs permitidas o enlace de privacidad, la
  importación MUST rechazarse sin aplicar nada.
- **FR-019**: Si la configuración del destino ha cambiado desde que se generó la vista previa, la
  confirmación MUST rechazarse sin aplicar nada y pedir una vista previa nueva.
- **FR-020**: Tras aplicar, el sistema MUST mostrar el resultado (elementos añadidos, modificados y
  eliminados por sección y avisos vigentes) y el bot MUST usar la configuración importada desde la
  siguiente respuesta en todos los canales.
- **FR-021**: Los destinos de avisos de derivación del destino MUST cambiar solo si el fichero los
  contiene y el operador eligió importarlos.
- **FR-022**: Dentro de la misma operación de FR-015, antes de reemplazar nada, el sistema MUST
  guardar en la instancia la exportación de la configuración que tenía el destino, con sus destinos
  de avisos. El resultado de la importación y el panel MUST ofrecer descargarla, con la fecha de la
  importación a la que precede. Se conserva solo la de la última importación aplicada; una
  importación rechazada no la sustituye.

**Seguridad y trazabilidad**

- **FR-023**: Exportar, previsualizar e importar MUST estar disponibles solo para el operador con
  sesión iniciada y con la misma protección frente a peticiones falsificadas que el resto del panel.
- **FR-024**: El sistema MUST registrar cada exportación e importación (aplicada, rechazada o
  cancelada) con fecha, resultado, instancia de origen del fichero y recuentos por sección, sin
  registrar el contenido de la configuración, teléfonos, correos ni textos.
- **FR-025**: La exportación e importación MUST funcionar igual para cualquier negocio de cualquier
  sector, sin nombres ni reglas de un sector o cliente en el núcleo.

### Key Entities

- **Fichero de configuración**: exportación legible de la configuración de un negocio. Contiene los
  metadatos (versión del formato, instancia de origen, fecha, versión del esquema, si incluye
  destinos de avisos) y una sección por cada parte de la configuración (FR-002).
- **Vista previa de importación**: resultado de comparar un fichero válido con la configuración
  actual del destino: cambios por sección, avisos resultantes, si se aplicará o se rechazará, y la
  referencia de la configuración del destino con la que se comparó (para detectar cambios antes de
  confirmar). No modifica nada.
- **Configuración anterior a la importación**: exportación de la configuración del destino guardada
  automáticamente al aplicar una importación (FR-022), con el mismo formato que el fichero de
  configuración y los destinos de avisos incluidos. Solo existe una, la de la última importación
  aplicada.
- **Registro de importación o exportación**: anotación técnica de cada operación, con fecha,
  resultado, instancia de origen y recuentos, sin contenido.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Exportar la configuración de un negocio completo en una instancia de pruebas e
  importarla en una instancia vacía deja en el destino una configuración equivalente: las
  respuestas del bot a las mismas preguntas de prueba sobre horarios, servicios, precios y preguntas
  frecuentes son las mismas en las dos instancias.
- **SC-002**: Exportar e importar el fichero resultante en la misma instancia produce una vista
  previa sin cambios.
- **SC-003**: En el 100 % de las pruebas con conversaciones y clientes finales en el origen, el
  fichero exportado no contiene ningún dato de clientes finales; y sin marcar la opción, ningún
  destino de avisos de derivación.
- **SC-004**: En el 100 % de las importaciones, el estado del negocio y del chat web del destino es
  el mismo antes y después.
- **SC-005**: En el 100 % de las importaciones rechazadas (fichero inválido, versión futura, aviso
  crítico en un negocio activo, chat web activado que quedaría sin webs o sin enlace de privacidad,
  cambio concurrente o fallo a mitad), la configuración del destino
  es idéntica a la de antes.
- **SC-006**: El operador pasa la configuración de un negocio completo de la instancia de pruebas a
  producción en menos de 5 minutos, frente a volver a registrarla a mano.
- **SC-007**: La vista previa y la aplicación de un negocio con 200 servicios, 50 recursos y 200
  preguntas frecuentes tardan cada una menos de 5 segundos.

## Assumptions

- La importación es un **reemplazo completo** (FR-016): no hay importación de secciones sueltas, ni
  parcial por elementos, ni fusión con la configuración del destino. Para volver atrás, el operador
  descarga la configuración anterior guardada automáticamente (FR-022) y la importa.
- La exportación y la importación se hacen solo desde el panel de cada instancia; no hay
  sincronización automática entre instancias ni órdenes de terminal en esta feature. Si más adelante
  se añade una orden de terminal, será con otra spec y el mismo formato de fichero.
- El fichero no va cifrado ni firmado: contiene datos del negocio, no de clientes finales ni
  secretos, y lo maneja solo el operador. Si incluye destinos de avisos, contiene un teléfono o correo
  del negocio y el operador lo guarda con el mismo cuidado que el inventario.
- Las plantillas por sector no forman parte del núcleo: si se preparan ficheros de ejemplo, viven en
  `tests/fixtures/` o fuera del repositorio.
- La zona horaria y la moneda forman parte de la configuración del negocio y se importan con ella.
- Los contactos de derivación (teléfono, WhatsApp o correo públicos del negocio) son datos del
  negocio, no de clientes finales, y se exportan siempre; lo opcional son solo los destinos internos
  de los avisos (feature 005).
- Se reutilizan la sesión del operador, la protección CSRF, las reglas de validación del dominio y el
  cálculo de avisos existentes (features 001, 003, 004 y 005).
