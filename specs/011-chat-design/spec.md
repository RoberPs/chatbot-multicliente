# Feature Specification: Diseño del chat web

**Feature Branch**: `011-chat-design`

**Created**: 2026-10-02

**Status**: Draft

**Ámbito**: núcleo (genérico, aplica a todos los clientes)

**Input**: User description: "El operador puede personalizar el aspecto del chat web de su instancia desde una sección propia del panel, 'Diseño del chat', junto a 'Chat web': colores, forma, nombre del chat, logo, avatar, icono del botón, textos de bienvenida, de ayuda y del botón Enviar, y posición y tamaño. Hay un único diseño por instancia. Se aplica con variables CSS servidas desde el propio origen del chat, sin framework ni CSS libre, con fuentes del sistema e imágenes (PNG, JPEG o WebP, con límite de tamaño, sin SVG) guardadas en la base de datos. El panel muestra una vista previa en vivo y lo guardado se aplica en la siguiente petición. Se bloquea guardar si los colores no cumplen el contraste WCAG AA, y el aviso de asistente automático y el enlace de privacidad nunca se pueden quitar. El diseño se incluye en la exportación e importación de la configuración (con su formatVersion) y sin diseño guardado el chat se ve como hasta ahora. Se toca el código existente solo donde es imprescindible. Ámbito: núcleo."

## Contexto

La feature 004 añadió el chat web: un botón flotante en la web del negocio que abre un chat atendido
por el mismo asistente que WhatsApp. Su aspecto es único y fijo para todas las instancias (mismo
azul, mismo icono, mismos textos, esquina inferior derecha, mismo tamaño). La propia 004 dejó
"personalizar colores o posición del chat" para una feature posterior; esta es esa feature.

Un negocio quiere que el chat se parezca a su web: sus colores, su nombre, su logo. Hoy eso exigiría
tocar código por cliente, lo que la constitución prohíbe (Principios I a III). Esta feature lo cubre
como **configuración**: el operador (Principio VI) elige el aspecto en una sección del panel, ve una
vista previa en vivo y guarda; los visitantes lo ven en su siguiente carga del chat, sin que el
negocio cambie el fragmento que ya pegó en su web.

El diseño es **acotado a propósito**: el operador elige entre opciones previstas (colores, formas,
textos cortos, tres imágenes, posición, tamaño); no escribe estilos libres ni elige tipografías.
Eso protege tres cosas que no se negocian: que el texto siempre se lea (contraste WCAG AA), que el
visitante siempre sepa que habla con un asistente automático y pueda leer la política de
privacidad (feature 004, FR-017), y que siempre haya salida a una persona (Principio V).

### Límites del cambio

- **Sin diseño guardado**, el chat se ve exactamente como hasta ahora. Una instancia existente no
  cambia al actualizar el núcleo.
- Esta feature **solo cambia el aspecto**. No cambia la cadena de respuesta, los límites, los topes
  de uso ni de gasto, cuándo está disponible el chat, la política de retención, la página "Probar
  el bot" ni la configuración de la sección "Chat web" (webs permitidas, privacidad, topes,
  activación).
- Se toca el código existente solo donde es imprescindible para que el aspecto sea configurable.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Personalizar colores, forma, nombre y textos con vista previa (Priority: P1)

El operador abre "Diseño del chat" en el panel, elige los colores, la forma, el nombre del chat y
los textos de bienvenida, de ayuda y del botón Enviar, y ve a la vez una vista previa en vivo del
chat (el botón cerrado y el chat abierto con una conversación de ejemplo). Cuando le convence,
guarda; los visitantes del chat ven el nuevo aspecto la siguiente vez que cargan la web.

**Why this priority**: es el valor central de la feature y se puede entregar solo, sin imágenes ni
posición: con colores, nombre y textos el chat ya deja de ser genérico.

**Independent Test**: con un negocio y el chat web activado en una web permitida, cambiar colores,
forma, nombre y textos, comprobar que la vista previa cambia sin guardar, guardar y recargar la web
del negocio para comprobar que el chat real muestra lo mismo que la vista previa.

**Acceptance Scenarios**:

1. **Given** una instancia sin diseño guardado, **When** el operador abre "Diseño del chat",
   **Then** el formulario muestra los valores con los que el chat se ve hoy y la vista previa es
   idéntica al chat actual.
2. **Given** el operador cambia un color, la forma o un texto, **When** suelta el control (o termina
   de escribir), **Then** la vista previa refleja el cambio de inmediato, sin guardar y sin recargar
   la página del panel.
3. **Given** un diseño válido, **When** el operador guarda, **Then** la siguiente vez que un
   visitante carga (o recarga) la web con el chat, ve el nuevo aspecto, sin que el negocio haya
   cambiado nada en su web.
4. **Given** el operador deja vacío el nombre del chat, el texto de ayuda o el de Enviar, **When**
   guarda, **Then** el chat usa el valor por defecto de cada uno (el nombre por defecto sigue
   siendo "Asistente de" y el nombre del negocio); un texto de bienvenida vacío significa que no se
   muestra bienvenida.
5. **Given** un texto de bienvenida configurado, **When** un visitante abre el chat por primera vez,
   **Then** ve ese texto en la parte superior de la conversación, junto con el aviso de asistente
   automático, y el texto no aparece como mensaje del bot ni se guarda en la conversación.
6. **Given** el operador escribe en un texto algo que parece código o formato (`<b>`, `<script>`,
   `{{ }}`), **When** guarda, **Then** el chat lo muestra literalmente como texto y no se interpreta.
7. **Given** el operador cambia opciones y abandona la sección sin guardar, **When** vuelve, **Then**
   el formulario muestra el diseño guardado y el chat de los visitantes no ha cambiado.
8. **Given** alguien sin sesión de operador, **When** intenta abrir la sección o guardar, **Then** se
   le redirige al inicio de sesión y no se guarda nada.

---

### User Story 2 - Contraste y elementos obligatorios protegidos (Priority: P1)

El operador no puede guardar un diseño con colores ilegibles ni quitar del chat lo que el chat debe
mostrar siempre. El panel le explica qué pareja de colores falla y por qué, y el chat conserva el
aviso de asistente automático, el enlace a la política de privacidad y la salida a una persona
con cualquier diseño.

**Why this priority**: sin estas garantías la personalización pondría en riesgo la accesibilidad, la
transparencia con el visitante y el Principio V. Es parte del primer entregable, no un añadido.

**Independent Test**: probar combinaciones de colores en los límites del contraste (justo por
encima y por debajo) y comprobar que solo se guardan las que cumplen; después, con los valores más
extremos de todas las opciones (nombre largo, texto de bienvenida largo, tamaño pequeño, forma
redondeada, imágenes), comprobar que el aviso, el enlace, el campo de escritura, el botón de enviar
y el de cerrar siguen visibles y utilizables.

**Acceptance Scenarios**:

1. **Given** colores cuya pareja de texto y fondo queda por debajo de WCAG AA, **When** el operador
   intenta guardar, **Then** no se guarda, y el panel indica qué pareja falla, el contraste
   obtenido y el mínimo exigido, y el diseño guardado no cambia.
2. **Given** el operador está editando, **When** una pareja de colores deja de cumplir el contraste,
   **Then** el panel lo indica en ese momento, junto al control afectado, sin esperar a guardar.
3. **Given** un navegador del operador que no ejecuta la vista previa, **When** envía igualmente un
   diseño con colores insuficientes, **Then** el guardado se rechaza igual (la comprobación no
   depende de la vista previa).
4. **Given** cualquier diseño guardado, **When** un visitante abre el chat por primera vez, **Then**
   ve el aviso de asistente automático y el enlace a la política de privacidad, con su texto
   original, antes de escribir su primer mensaje.
5. **Given** el formulario de diseño, **When** el operador lo revisa, **Then** no existe ninguna
   opción para ocultar, editar o desactivar el aviso de asistente automático ni el enlace de
   privacidad, y una petición manipulada que lo intente no tiene efecto.
6. **Given** el diseño con el nombre más largo, la bienvenida más larga, el tamaño más pequeño y
   las tres imágenes, **When** se abre el chat, **Then** el aviso, el enlace, el campo de escritura,
   el botón de enviar y el de cerrar son visibles y utilizables, y nada queda tapado o cortado.
7. **Given** el chat no disponible (desactivado, negocio en preparación, tope de uso o de gasto
   alcanzado), **When** un visitante lo abre, **Then** ve el mensaje de no disponible y el contacto
   de derivación con el aspecto del diseño, pero el diseño no los oculta ni los altera.

---

### User Story 3 - Logo, avatar e icono del botón (Priority: P2)

El operador sube una imagen para el logo (en la cabecera del chat), otra para el avatar (junto a
los mensajes del bot) y otra para el icono del botón flotante. Las ve en la vista previa antes de
guardar, y puede sustituirlas o quitarlas una a una.

**Why this priority**: refuerza mucho la imagen de marca, pero el chat ya queda personalizado con la
US1; las imágenes añaden validaciones de seguridad que conviene entregar aparte.

**Independent Test**: subir una imagen válida en cada hueco y comprobar vista previa y chat real;
intentar subir un SVG, un fichero que no es imagen, una imagen demasiado grande y un fichero
renombrado, y comprobar que todos se rechazan sin guardar nada.

**Acceptance Scenarios**:

1. **Given** una imagen PNG, JPEG o WebP dentro del límite de tamaño, **When** el operador la elige
   como logo, avatar o icono, **Then** la vista previa la muestra antes de guardar y, al guardar, el
   chat real la muestra en su sitio.
2. **Given** un fichero SVG, **When** el operador intenta subirlo, **Then** se rechaza con un mensaje
   que indica los formatos admitidos y no se guarda.
3. **Given** un fichero que dice ser PNG pero cuyo contenido no lo es (un SVG, un HTML o un
   ejecutable renombrado, o un fichero dañado o vacío), **When** el operador intenta subirlo,
   **Then** se rechaza, porque se valida el contenido real y no el nombre ni el tipo declarado.
4. **Given** una imagen que supera el tamaño máximo, **When** el operador intenta subirla, **Then** se
   rechaza indicando el máximo permitido, y la imagen anterior (si la había) se conserva.
5. **Given** un diseño con imágenes guardadas, **When** el operador sustituye una de ellas y guarda,
   **Then** el chat muestra la nueva en la siguiente carga y no la anterior, aunque el navegador
   del visitante la tuviera guardada.
6. **Given** un logo, un avatar o un icono guardados, **When** el operador pulsa "Quitar" en uno y
   guarda, **Then** ese elemento vuelve a su aspecto original (sin logo, sin avatar, icono
   original del botón) y los demás se conservan.
7. **Given** una imagen de proporciones distintas a su hueco, **When** se muestra en el chat,
   **Then** se ajusta sin deformarse y sin cambiar la disposición ni el tamaño del chat.
8. **Given** imágenes guardadas, **When** el chat se muestra en la web del negocio, **Then** todas
   se sirven desde la propia instancia y el navegador del visitante no contacta con ningún otro
   servidor.

---

### User Story 4 - Posición y tamaño del chat (Priority: P2)

El operador elige en qué esquina inferior de la web aparece el botón y el chat (derecha o
izquierda) y el tamaño del chat abierto (pequeño, mediano o grande), por ejemplo para que no tape
un elemento de la web del negocio. Lo ve en la vista previa y lo guarda; el cambio llega a la web
del negocio sin que este cambie su fragmento.

**Why this priority**: resuelve choques con la web del negocio, pero es secundario frente al aspecto
y obliga a que el fragmento ya pegado se adapte a lo que el chat le pida.

**Independent Test**: guardar posición izquierda y tamaño grande, recargar una web con el fragmento
original pegado antes de esta feature y comprobar que el botón y el chat abierto aparecen en la
esquina izquierda con el tamaño elegido.

**Acceptance Scenarios**:

1. **Given** sin diseño guardado, **When** se muestra el chat, **Then** está en la esquina inferior
   derecha con el tamaño mediano actual.
2. **Given** posición "inferior izquierda", **When** un visitante carga la web, **Then** el botón y
   el chat abierto aparecen en la esquina inferior izquierda.
3. **Given** cada tamaño (pequeño, mediano, grande), **When** el visitante abre el chat, **Then** el
   chat abierto tiene el tamaño elegido y en todos los casos se ve completo en pantallas grandes.
4. **Given** una pantalla pequeña (teléfono), **When** el visitante abre el chat con cualquier
   tamaño, **Then** el chat no sobrepasa el área visible y sigue siendo utilizable.
5. **Given** una web con el fragmento pegado antes de esta feature, **When** el operador guarda una
   posición o un tamaño nuevos, **Then** el negocio no tiene que cambiar nada en su web para
   verlos.
6. **Given** el operador cambia posición o tamaño, **When** mira la vista previa, **Then** la vista
   previa muestra la esquina y el tamaño elegidos.

---

### User Story 5 - El diseño viaja con la exportación e importación de la configuración (Priority: P2)

Al exportar la configuración del negocio (feature 008), el fichero incluye el diseño del chat con
sus imágenes. Al importarlo en otra instancia, la vista previa de la importación muestra los
cambios de diseño, y al confirmar el destino queda con el mismo diseño. Los ficheros exportados
antes de esta feature siguen pudiendo importarse.

**Why this priority**: es lo que permite preparar el diseño en la instancia de pruebas y llevarlo a
producción como el resto de la configuración, y lo que mantiene la exportación completa. Depende
de que el diseño exista (US1).

**Independent Test**: guardar un diseño completo en una instancia, exportar, importar en otra
instancia con otro diseño, revisar la vista previa, confirmar y comprobar que el destino queda con
el diseño del origen (incluidas las imágenes) y que su chat web mantiene su estado de activación.

**Acceptance Scenarios**:

1. **Given** una instancia con un diseño guardado, **When** el operador exporta, **Then** el fichero
   incluye el diseño completo (opciones, textos e imágenes) en su propia sección.
2. **Given** un fichero con diseño, **When** el operador lo importa y confirma, **Then** el diseño
   del destino pasa a ser el del fichero, y el estado de activación del chat web del destino no
   cambia.
3. **Given** un fichero con diseño distinto al del destino, **When** el operador ve la vista previa
   de la importación, **Then** ve el diseño como una sección más, con cada opción que cambia (valor
   actual y nuevo) y cada imagen marcada como añadida, cambiada o eliminada.
4. **Given** un fichero sin diseño (porque su origen no tenía diseño guardado o porque se exportó
   antes de esta feature), **When** se importa en un destino con diseño, **Then** la vista previa
   anuncia que el diseño del destino se eliminará y, al confirmar, el destino vuelve al aspecto
   original (reemplazo completo, como el resto de la configuración).
5. **Given** un fichero con un diseño que no cumple las reglas (colores con contraste insuficiente,
   imagen no válida o demasiado grande, texto demasiado largo, opción desconocida), **When** el
   operador lo sube, **Then** se rechaza el fichero entero, con el error de cada campo, y no cambia
   nada.
6. **Given** una importación aplicada, **When** el operador descarga la configuración anterior que
   guarda el sistema y la importa, **Then** el destino recupera también su diseño anterior.
7. **Given** un diseño con las tres imágenes en su tamaño máximo, **When** el operador exporta,
   **Then** el fichero sigue dentro del límite de tamaño de importación.

---

### User Story 6 - Volver al aspecto original (Priority: P3)

El operador puede descartar el diseño guardado con una acción de "Restaurar el aspecto original",
tras confirmarla, y el chat vuelve a verse como antes de personalizarlo.

**Why this priority**: es una comodidad; el operador puede igualmente reponer los valores a mano.

**Independent Test**: con un diseño guardado con imágenes, restaurar el aspecto original y comprobar
que el chat real y el formulario vuelven a los valores por defecto y que las imágenes ya no se
sirven.

**Acceptance Scenarios**:

1. **Given** un diseño guardado, **When** el operador pulsa "Restaurar el aspecto original" y lo
   confirma, **Then** el diseño guardado (imágenes incluidas) se elimina y el chat se ve como el
   original en la siguiente carga.
2. **Given** el operador pulsa la acción pero no confirma, **When** vuelve al formulario, **Then** no
   cambia nada.
3. **Given** una instancia sin diseño guardado, **When** el operador abre la sección, **Then** la
   acción de restaurar no aparece o indica que no hay nada que restaurar.

---

### Edge Cases

- **Chat web desactivado o negocio en preparación**: el operador puede preparar y guardar el diseño
  igualmente y ver la vista previa. Guardar el diseño no activa ni desactiva el chat.
- **Dos pestañas o dos sesiones del panel**: gana el último guardado; al abrir la sección siempre se
  ve el diseño vigente.
- **Cambio de diseño con visitantes con el chat abierto**: su conversación no se interrumpe; ven el
  nuevo aspecto cuando vuelven a cargar el chat.
- **Imagen con fondo transparente sobre un color oscuro, o de poco contraste con su fondo**: el
  sistema no puede juzgarlo; la vista previa lo muestra tal cual antes de guardar. El contraste
  WCAG AA se exige a los colores elegidos, no al contenido de las imágenes.
- **Imagen animada o con metadatos**: se acepta como imagen; el sistema no garantiza conservar la
  animación ni los metadatos (el plan decide si se normaliza), y en ningún caso se ejecuta nada.
- **Nombre del chat que sugiere una persona** (por ejemplo, un nombre propio): se permite, porque el
  aviso de asistente automático es obligatorio e inamovible; el operador es responsable del nombre.
- **Imagen que no se puede leer al servirla** (dato dañado o ausente): el chat muestra ese elemento
  con su aspecto original y sigue funcionando; nunca queda sin chat por un fallo de diseño.
- **Diseño guardado con una opción que una versión posterior del núcleo ya no admite**: el chat usa
  el valor original de esa opción y la sección lo señala al operador al abrirla.
- **Texto con emojis, saltos de línea o idioma distinto del español**: los emojis y varios idiomas se
  admiten; los saltos de línea solo en el texto de bienvenida (hasta el límite); el resto de textos
  es de una línea.
- **Texto con enlaces**: se muestra como texto plano, sin enlace pulsable; los únicos enlaces del
  chat siguen siendo el de privacidad y los `https://` de las respuestas del bot (004, FR-020a).
- **Importación de un fichero con diseño en un destino con el chat web activado**: el diseño se
  aplica igual; la importación no cambia el estado de activación y la vista previa de la importación
  lo muestra como una sección más.
- **Restauración de una copia de seguridad (006)**: el diseño, con sus imágenes, vuelve con la copia,
  porque forma parte de los datos de la instancia.
- **Usuario con ajustes de accesibilidad del navegador** (zoom, tamaño de letra, movimiento
  reducido): el diseño no los desactiva; el chat sigue legible y utilizable con zoom.
- **Cambio de versión del núcleo con instancias ya desplegadas (009)**: las instancias que no
  guardan diseño se ven igual que antes; las que sí lo guardan lo conservan al actualizar.

## Requirements *(mandatory)*

### Sección del panel y alcance del diseño

- **FR-001**: El panel MUST ofrecer una sección propia "Diseño del chat", junto a la sección "Chat
  web", accesible solo con sesión de operador y con la misma protección frente a peticiones
  falsificadas que el resto del panel (Principio VI: el negocio no la usa).
- **FR-002**: Cada instancia MUST tener como máximo un diseño del chat. No hay varios diseños,
  borradores, versiones ni programación por fechas: lo guardado es lo que se aplica.
- **FR-003**: El diseño MUST permitir configurar exactamente: cinco colores (principal, texto sobre
  el principal, fondo del chat, texto del chat, fondo de los mensajes del bot), la forma (tres
  niveles: recta, suave, redondeada), el nombre del chat, el logo, el avatar, el icono del botón,
  el texto de bienvenida, el texto de ayuda del campo de escritura, la etiqueta del botón Enviar,
  la posición (esquina inferior derecha o izquierda) y el tamaño del chat abierto (pequeño,
  mediano, grande).
- **FR-004**: El operador MUST poder elegir solo entre las opciones previstas en FR-003. El sistema
  MUST NOT permitir estilos libres, código, tipografías elegidas por el operador ni recursos
  externos; el texto del chat usa siempre las fuentes del sistema del visitante.
- **FR-005**: Los textos (nombre, bienvenida, ayuda y etiqueta de Enviar) MUST ser texto plano con
  longitud máxima (40, 280, 80 y 20 caracteres respectivamente), sin formato ni enlaces, y MUST
  mostrarse siempre literalmente como texto. Vacío significa el valor por defecto, salvo la
  bienvenida, cuyo vacío significa que no hay bienvenida.
- **FR-006**: Los colores MUST ser opacos (sin transparencia).
- **FR-007**: El texto de bienvenida y el nombre del chat MUST ser texto de la interfaz, no mensajes
  de la conversación: no se guardan como mensajes, no los pronuncia el bot y no sustituyen el
  saludo del bot ni el aviso de asistente automático.

### Vista previa

- **FR-008**: La sección MUST mostrar una vista previa en vivo del chat con el botón cerrado y el
  chat abierto con una conversación de ejemplo claramente marcada como ejemplo, que se actualiza al
  cambiar cualquier opción, sin guardar y sin recargar la página.
- **FR-009**: La vista previa MUST usar el mismo aspecto que el chat real: lo que se ve en la vista
  previa es lo que el chat mostrará al guardar, incluidos los elementos obligatorios de FR-021 y
  FR-022. Debe mostrar también las imágenes elegidas aún sin guardar.
- **FR-010**: La vista previa MUST NOT crear conversaciones, generar respuestas del modelo ni contar
  para los límites, los topes de uso o de gasto ni el consumo. Debe funcionar con el chat web
  desactivado y con el negocio en preparación, y MUST NOT ser accesible para los visitantes.
- **FR-011**: Abandonar la sección sin guardar MUST NOT dejar guardado ningún cambio ni ninguna
  imagen subida a medias.

### Guardado y aplicación

- **FR-012**: Lo guardado MUST aplicarse a todos los visitantes en la siguiente petición del chat
  (la siguiente vez que se carga o recarga), sin esperas ni cachés que muestren el aspecto anterior,
  imágenes incluidas.
- **FR-013**: El diseño MUST aplicarse sin que el negocio cambie el fragmento que ya tiene pegado en
  su web, también para la posición y el tamaño.
- **FR-014**: Guardar el diseño MUST NOT activar ni desactivar el chat web ni modificar su
  configuración (webs permitidas, enlace de privacidad, topes). El diseño puede guardarse con el
  chat desactivado.
- **FR-015**: Sin diseño guardado, el chat MUST verse exactamente como hasta ahora (colores, forma,
  nombre por defecto, icono, textos, posición y tamaño), y el formulario MUST mostrar esos
  valores.
- **FR-016**: El operador MUST poder restaurar el aspecto original, que elimina el diseño guardado
  con sus imágenes, tras una confirmación expresa.
- **FR-017**: Si dos guardados coinciden, MUST prevalecer el último; al abrir la sección MUST
  mostrarse siempre el diseño vigente.
- **FR-018**: Si un valor guardado no puede aplicarse (dato dañado, imagen ilegible, opción ya no
  admitida), el chat MUST seguir funcionando y mostrar ese elemento con su aspecto original; nunca
  puede quedar sin chat por un fallo del diseño.

### Contraste y accesibilidad

- **FR-019**: El sistema MUST rechazar guardar un diseño si alguna de estas parejas incumple WCAG
  2.x nivel AA: texto sobre el principal frente al principal (mínimo 4,5:1), texto del chat frente
  al fondo del chat (4,5:1), texto del chat frente al fondo de los mensajes del bot (4,5:1), y
  color principal frente al fondo del chat y frente al fondo de los mensajes del bot (4,5:1, porque
  el principal también es el color de los enlaces de las respuestas del bot). Además, todo texto
  que el chat muestre, incluidos el texto atenuado, los avisos de derivación y los mensajes del
  propio chat, MUST cumplir AA frente a su fondo con cualquier diseño que se pueda guardar, aunque
  su color no sea una de las cinco opciones.
- **FR-020**: La comprobación de FR-019 MUST hacerse siempre al guardar, con independencia de la
  vista previa; mientras el operador edita, el panel MUST indicar qué pareja incumple, el contraste
  obtenido y el mínimo, junto al control afectado. El rechazo no cambia el diseño guardado.
- **FR-021**: El aviso de asistente automático y el enlace a la política de privacidad (004,
  FR-017) MUST mostrarse siempre donde hoy se muestran, con su texto actual (no editable), antes del
  primer mensaje del visitante. El diseño MUST NOT incluir ninguna opción para quitarlos, ocultarlos
  o cambiarlos, y ninguna combinación de opciones (nombre, textos, imágenes, forma, tamaño,
  posición) puede taparlos, recortarlos ni dejarlos ilegibles.
- **FR-022**: El diseño MUST NOT ocultar, alterar ni retrasar la salida a una persona (el contacto
  de derivación, los avisos de derivación y el mensaje de no disponible con su contacto), el campo
  de escritura, el botón de enviar (cuya etiqueta nunca puede quedar vacía), el botón de cerrar ni
  el indicador de foco del teclado (Principio V).
- **FR-023**: Los enlaces del chat MUST distinguirse por algo más que el color; el diseño MUST NOT
  cambiar los tamaños de letra del chat ni impedir el zoom del navegador del visitante.
- **FR-024**: Las imágenes del diseño MUST ir con texto alternativo (el nombre del chat) o marcadas
  como decorativas, de modo que no aporten ruido a quien usa lector de pantalla.

### Imágenes

- **FR-025**: El logo, el avatar y el icono del botón MUST ser opcionales y subirse por el operador
  desde el panel. Solo se admiten imágenes PNG, JPEG o WebP; SVG y cualquier otro formato MUST
  rechazarse.
- **FR-026**: El formato MUST validarse por el contenido real del fichero, no por su nombre ni por
  el tipo que declare. Se rechaza cualquier fichero vacío, dañado o que no sea realmente una imagen
  de esos formatos (un SVG, HTML o ejecutable renombrado, por ejemplo).
- **FR-027**: Cada imagen MUST tener un tamaño máximo de 256 KB (y el plan fijará unas dimensiones
  máximas razonables). Una imagen que lo supere se rechaza con el máximo en el mensaje, sin guardar
  nada y conservando la que hubiera.
- **FR-028**: Las imágenes MUST guardarse con los datos de la instancia (por tanto, en sus copias de
  seguridad y restauraciones, feature 006) y servirse desde el propio origen del chat. El operador
  MUST NOT poder indicar la dirección de una imagen externa y ninguna imagen se carga desde otro
  servidor.
- **FR-029**: El operador MUST poder sustituir o quitar cada imagen por separado. Quitarla devuelve
  ese elemento a su aspecto original (sin logo, sin avatar, icono original del botón).
- **FR-030**: Las imágenes MUST mostrarse siempre dentro de su hueco, ajustadas sin deformarse y sin
  alterar la disposición ni el tamaño del chat.
- **FR-031**: Una imagen sustituida o quitada MUST dejar de mostrarse en la siguiente carga, aunque
  el navegador del visitante tuviera la anterior guardada.
- **FR-032**: Las imágenes MUST servirse con su tipo real y sin que el navegador pueda
  interpretarlas como otro tipo de contenido.

### Posición y tamaño

- **FR-033**: Por defecto la posición es la esquina inferior derecha y el tamaño es el mediano
  actual. El botón flotante y el chat abierto MUST aparecer en la esquina elegida y el chat abierto
  con el tamaño elegido.
- **FR-034**: En pantallas pequeñas el chat abierto MUST NOT sobrepasar el área visible con ningún
  tamaño, como ocurre hoy.

### Exportación e importación

- **FR-035**: La exportación de la configuración (feature 008) MUST incluir el diseño del chat,
  imágenes incluidas, en una sección propia, y la versión del formato de exportación MUST subir.
  Los ficheros de versiones anteriores MUST seguir pudiendo importarse; sin sección de diseño, se
  interpretan como sin diseño guardado.
- **FR-036**: La importación MUST validar el diseño con las mismas reglas que el panel (opciones,
  longitudes, imágenes, contraste). Si algo no es válido, MUST rechazarse el fichero entero con la
  lista de errores por campo y sin cambiar nada.
- **FR-037**: La importación MUST reemplazar el diseño del destino por el del fichero (o eliminarlo
  si el fichero no trae diseño), igual que el resto de secciones, sin cambiar el estado de
  activación del chat web ni su configuración. La vista previa de la importación MUST mostrar el
  diseño como una sección más: cada opción que cambia con su valor actual y nuevo, y cada imagen
  como añadida, cambiada o eliminada.
- **FR-038**: La configuración anterior que guarda la importación (008, FR-022) MUST incluir el
  diseño del destino, de modo que importarla restaura también el diseño.
- **FR-039**: El diseño con las tres imágenes en su tamaño máximo MUST caber en el límite de tamaño
  de los ficheros de importación.

### Seguridad y trazabilidad

- **FR-040**: Ningún contenido del operador (textos, nombres de fichero, imágenes) MUST ejecutarse
  ni interpretarse como código en la web del negocio, en el chat ni en el panel.
- **FR-041**: Aplicar el diseño MUST NOT hacer que el navegador del visitante contacte con
  servidores distintos de la instancia, ni usar cookies, ni recoger ningún dato del visitante.
- **FR-042**: El sistema MUST registrar cada guardado, restauración e importación del diseño con
  fecha y resultado, sin registrar textos ni imágenes.

### Núcleo y no regresión

- **FR-043**: El comportamiento del chat web que esta feature no menciona MUST NOT cambiar: cadena
  de respuesta, límites, topes, disponibilidad, retención, "Probar el bot" y la sección "Chat web".
  Las pruebas existentes de la 004 y la 010 MUST seguir cumpliéndose.
- **FR-044**: La feature MUST ser genérica: sus valores por defecto y sus textos no pueden contener
  nombres ni reglas de ningún sector ni cliente (Principio I).

### Key Entities

- **Diseño del chat**: configuración de aspecto del chat web de la instancia, única. Contiene los
  cinco colores, la forma, el nombre del chat, los textos de bienvenida, ayuda y Enviar, la posición,
  el tamaño y las referencias a las tres imágenes. Su ausencia significa "aspecto original". Forma
  parte de la configuración del negocio que se exporta y se importa.
- **Imagen del diseño**: logo, avatar o icono del botón. Tiene un formato (PNG, JPEG o WebP), un
  contenido validado, un tamaño y el hueco al que pertenece; es opcional y propia de la instancia.
- **Vista previa del diseño**: representación en el panel del chat con las opciones en edición y sin
  guardar. No es un dato persistente, no genera conversaciones y no es visible para los visitantes.
- **Elementos obligatorios del chat**: el aviso de asistente automático, el enlace de privacidad, la
  salida a una persona, el campo de escritura con el botón de enviar y el botón de cerrar. Existen
  siempre; el diseño solo puede cambiar su color y forma dentro de las reglas de contraste.
- **Sección de diseño de la exportación**: parte del fichero de configuración (008) que lleva el
  diseño del chat con sus imágenes y la versión del formato.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Un operador que no conoce la función cambia los colores, el nombre y los textos de su
  chat y ve el resultado en la web del negocio en menos de 5 minutos.
- **SC-002**: En la vista previa, cada cambio de una opción se ve en menos de 1 segundo, y en las
  pruebas de comparación el chat real con el diseño guardado se ve igual que la vista previa en el
  100 % de las opciones.
- **SC-003**: El 100 % de los intentos de guardar un diseño con alguna pareja de colores por debajo
  de WCAG AA se rechaza, y el 0 % de los diseños guardados incumple AA en algún texto del chat
  (también el atenuado y los avisos de derivación), tanto desde el panel como desde la
  importación.
- **SC-004**: Con cualquier combinación de opciones, incluidos los valores extremos de longitud,
  tamaño, forma e imágenes, el aviso de asistente automático, el enlace de privacidad, el campo de
  escritura, el botón de enviar y el de cerrar están visibles y son utilizables en el 100 % de los
  casos de prueba, en pantallas de escritorio y de teléfono.
- **SC-005**: Tras guardar un diseño, el 100 % de las cargas siguientes del chat muestran el diseño
  nuevo (imágenes incluidas), sin que el negocio cambie nada en su web.
- **SC-006**: En una instancia sin diseño guardado, el chat se ve y se comporta igual que antes de
  esta feature en el 100 % de las pruebas de no regresión de la 004 y la 010.
- **SC-007**: El 100 % de los ficheros de imagen no permitidos (SVG, otros formatos, renombrados,
  dañados, vacíos o por encima del límite) se rechaza y el 0 % se guarda o se sirve.
- **SC-008**: Exportar el diseño de una instancia e importarlo en otra la deja con el mismo
  diseño (imágenes incluidas); al volver a importar el mismo fichero, la vista previa de la
  importación no muestra cambios de diseño; y el 100 % de las importaciones conserva el estado de
  activación del chat web del destino.
- **SC-009**: Con un diseño completo (cinco colores, textos y las tres imágenes) el botón del chat
  se muestra en menos de 2 segundos en el 95 % de las cargas, con una conexión de banda ancha
  normal.
- **SC-010**: En el 100 % de las pruebas de seguridad, ningún texto o imagen del diseño se ejecuta
  como código en el chat ni en el panel, y el chat con diseño no hace ninguna petición a otros
  servidores.

## Dependencias

- **Feature 004** (canal web): el chat, su aviso de asistente automático, el enlace de privacidad,
  el mensaje de no disponible y el fragmento para la web. Esta feature cambia su aspecto, no su
  comportamiento.
- **Feature 008** (exportar e importar): el diseño se añade al fichero de configuración, a la
  vista previa de la importación y a la configuración anterior guardada; sube la versión del
  formato de exportación.
- **Feature 001** (panel): la sesión del operador y la protección de las acciones del panel.
- **Feature 006** (copias de seguridad): el diseño, con sus imágenes, viaja con las copias porque
  vive en los datos de la instancia.
- **Feature 010** (consumo y gasto): el chat con un tope alcanzado sigue mostrándose con el
  diseño; la vista previa no cuenta para el consumo.

## Assumptions

- Hay un único diseño por instancia, sin temas, borradores ni histórico de versiones. El operador
  que quiera volver atrás usa la restauración del aspecto original (US6), la configuración
  anterior de la 008 o una copia de seguridad.
- El diseño solo afecta al chat web público. La página "Probar el bot" y el resto del panel
  conservan su aspecto.
- No hay modo oscuro automático ni un segundo juego de colores: el chat usa los colores elegidos
  con independencia del tema del visitante.
- "Forma" son tres niveles (recta, suave, redondeada) que se aplican a la vez al chat, a las burbujas
  de mensajes, a los botones y al botón flotante; el nivel "redondeada" hace circular el botón
  flotante.
- "Texto de ayuda" es el texto que se ve en el campo de escritura vacío (hoy "Escribe tu mensaje").
  "Texto de bienvenida" es un bloque informativo en la parte superior del chat; no es una respuesta
  del bot y no lleva datos del negocio, que solo da el bot a partir de lo registrado (Principio IV).
  El contenido de los textos es responsabilidad del operador, y el panel lo recuerda junto al
  campo.
- Los valores por defecto son los del chat de la 004: mismos colores, icono, "Asistente de" más el
  nombre del negocio, "Escribe tu mensaje", "Enviar", sin bienvenida, esquina inferior derecha y
  tamaño mediano. Esos colores cumplen WCAG AA (el contraste más bajo, el del texto atenuado, es
  de 5,6:1), así que el aspecto original es un diseño válido.
- El contraste exigido se aplica a las parejas de colores de FR-019 y a todo texto del chat. Los
  colores que el chat deriva de los elegidos (texto atenuado, bordes, aviso de derivación) los
  calcula el sistema para cumplir AA; el plan decide cómo. El contenido de las imágenes no se
  evalúa; el operador lo ve en la vista previa.
- Los tamaños concretos de "pequeño" y "grande", las dimensiones máximas de las imágenes y el
  tratamiento de imágenes animadas o con metadatos los fija el plan; el tamaño "mediano" es el
  actual.
- El límite de 256 KB por imagen es un valor por defecto razonable para logos y avatares; con tres
  imágenes ocupa muy por debajo del límite de 5 MB del fichero de importación (008, FR-010).
- Los textos por defecto y los de las opciones están en español, como el resto del producto; el
  operador puede escribir los suyos en cualquier idioma.
- Un solo operador por instancia usa el panel (credencial única), por lo que no se necesita
  control de edición concurrente más allá de "gana el último guardado".
- El operador, no el negocio, configura el diseño (Principio VI) y es responsable de que refleje
  la imagen del negocio.
