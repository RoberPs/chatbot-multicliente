# Feature Specification: Icono del botón a tamaño completo

**Feature Branch**: `018-icono-boton-completo`

**Created**: 2026-10-30

**Status**: Draft

**Ámbito**: núcleo (genérico, aplica a todos los clientes)

**Input**: User description: "Spec de NÚCLEO. Opción en el diseño del chat web (panel → Diseño del chat) para que el icono propio del botón flotante se muestre a tamaño completo: la imagen rellena todo el círculo del botón (recortada en círculo) y solo queda un borde fino del color de acento alrededor. Hoy el icono se dibuja siempre a 28 px dentro de un botón de 56 px, con mucho fondo de acento alrededor, y el negocio no puede cambiarlo. La opción viene desactivada: las instancias existentes (y las que no tienen icono propio) se ven exactamente igual que ahora; sin icono propio la opción no tiene efecto (sigue el emoji). Se guarda con la configuración del negocio, así que entra en la exportación/importación de configuración (sube formatVersion con su actualizador; los ficheros antiguos se importan con la opción desactivada) y aparece en la vista previa del diseño del panel. No cambia el tamaño del botón ni del iframe (72 px cerrado). Accesibilidad: el botón mantiene su nombre accesible y el foco visible. Motivo: un negocio quiere que su logo se vea grande en el botón."

## Contexto

La feature 011 permitió subir un **icono propio** para el botón flotante del chat web. Ese icono se
muestra siempre pequeño, en el centro del botón (aproximadamente la mitad de su ancho), rodeado
del color principal del chat (FR-030a de la 011). Para un icono pensado como símbolo sobre un fondo
de color, eso está bien. Para un negocio cuyo icono es su **logo** (una imagen con su propio fondo y
su propio dibujo), el resultado es un logo diminuto dentro de un botón de color: no se reconoce.

Esta feature añade al diseño del chat una opción para que el icono **ocupe todo el botón**: la
imagen rellena el botón, recortada con la forma del botón, y del color principal solo queda un borde
fino alrededor que sigue marcando el contorno del botón sobre la web del negocio.

Es configuración (Principio II), no código por cliente: cualquier negocio con un icono propio puede
activarla desde el panel.

### Límites del cambio

- **La opción viene desactivada.** Una instancia existente no cambia al actualizar el núcleo, y una
  instancia sin icono propio se ve igual con la opción activada o sin ella.
- No cambia el tamaño del botón, su posición, el tamaño del chat cerrado ni abierto, ni el resto del
  diseño (logo de cabecera, avatar, colores, textos).
- No cambia cómo se suben, validan, sirven o quitan las imágenes (011).
- Enmienda solo una parte del FR-030a de la 011: con la opción activada, el fondo del botón deja de
  verse salvo como borde. El resto del FR-030a se mantiene (forma, tamaño, foco y etiqueta
  accesible del botón).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Mostrar el icono propio a tamaño completo (Priority: P1)

El operador abre "Diseño del chat" en el panel de una instancia que ya tiene un icono propio para el
botón. Activa "Icono a tamaño completo" y ve en la vista previa que la imagen rellena el botón, con
la forma del botón y un borde fino del color principal. Guarda; los visitantes ven el botón nuevo la
siguiente vez que cargan la web. Si lo desactiva y guarda, el botón vuelve a verse como antes.

**Why this priority**: es todo el valor de la feature: que el logo del negocio se reconozca en el
botón.

**Independent Test**: en una instancia con icono propio, activar la opción, guardar y comprobar en
la web del negocio que el icono rellena el botón con un borde fino del color principal; desactivarla
y comprobar que vuelve al aspecto anterior.

**Acceptance Scenarios**:

1. **Given** un diseño con icono propio y la opción desactivada, **When** el operador activa "Icono a
   tamaño completo", **Then** la vista previa muestra al momento, sin guardar, el icono rellenando el
   botón con un borde fino del color principal.
2. **Given** la opción activada en la vista previa, **When** el operador guarda, **Then** el botón del
   chat en la web del negocio muestra el icono a tamaño completo en la siguiente carga.
3. **Given** la opción activada y guardada, **When** el operador la desactiva y guarda, **Then** el
   botón vuelve a mostrar el icono pequeño sobre el color principal, como antes de activarla.
4. **Given** la opción activada, **When** el operador cambia la forma del chat (recta, suave o
   redondeada), **Then** la imagen sigue la forma del botón (cuadrada, con esquinas suaves o circular)
   y el borde también.
5. **Given** la opción activada, **When** el operador cambia el color principal, **Then** el borde
   del botón cambia a ese color.
6. **Given** un icono que no es cuadrado, **When** se muestra a tamaño completo, **Then** la imagen
   rellena el botón sin deformarse, recortando lo que sobra por los lados o por arriba y abajo.

---

### User Story 2 - Instancias existentes y sin icono, sin cambios (Priority: P1)

Al actualizar el núcleo, ninguna instancia cambia de aspecto. Y si una instancia activa la opción
pero no tiene icono propio (o lo quita), el botón se ve como siempre, con el icono original.

**Why this priority**: el núcleo se actualiza en todas las instancias a la vez; un cambio de aspecto
no pedido en la web de un negocio es un fallo.

**Independent Test**: actualizar una instancia con diseño guardado y otra sin diseño y comprobar que
sus botones no cambian; activar la opción sin icono propio y comprobar que el botón no cambia.

**Acceptance Scenarios**:

1. **Given** una instancia con diseño guardado antes de esta feature, **When** se actualiza el
   núcleo, **Then** la opción aparece desactivada y el botón se ve exactamente igual que antes.
2. **Given** una instancia sin diseño guardado, **When** se actualiza el núcleo, **Then** el botón se
   ve exactamente igual que antes.
3. **Given** la opción activada y sin icono propio, **When** se carga el chat, **Then** el botón
   muestra el icono original sobre el color principal, como si la opción estuviera desactivada.
4. **Given** la opción activada con icono propio, **When** el operador quita el icono y guarda,
   **Then** el botón muestra el icono original sobre el color principal.
5. **Given** la opción activada, **When** la imagen del icono no se puede cargar en el navegador del
   visitante, **Then** el botón muestra el icono original sobre el color principal, como ya hace
   hoy cuando la imagen falla.

---

### User Story 3 - La opción viaja con la configuración (Priority: P2)

El operador prepara el diseño en la instancia de pruebas, exporta la configuración y la importa en
la instancia del cliente. La opción viaja con el resto del diseño. Un fichero exportado antes de
esta feature se sigue importando, con la opción desactivada.

**Why this priority**: la exportación e importación es como se pasa la configuración entre
instancias; si la opción no viajara, habría que repetirla a mano y podría olvidarse.

**Independent Test**: exportar con la opción activada, importar en otra instancia y comprobar el
botón; importar un fichero anterior a esta feature y comprobar que la opción queda desactivada.

**Acceptance Scenarios**:

1. **Given** un diseño con la opción activada, **When** el operador exporta la configuración y la
   importa en otra instancia, **Then** la vista previa de la importación muestra el cambio de la
   opción y, al confirmar, la otra instancia queda con la opción activada.
2. **Given** un fichero exportado antes de esta feature, **When** se importa, **Then** se acepta y la
   opción queda desactivada.
3. **Given** un fichero con la opción activada y sin icono, **When** se importa, **Then** se acepta y
   el botón se ve con el icono original (US2, escenario 3).

### Edge Cases

- **Icono con fondo transparente**: lo transparente deja ver el color principal del botón detrás de
  la imagen, igual que hoy. La opción no añade un fondo nuevo.
- **Icono muy pequeño en píxeles**: se amplía para rellenar el botón y puede verse borroso; es
  responsabilidad del operador subir una imagen con resolución suficiente. El panel no lo bloquea.
- **Forma recta**: la imagen rellena un botón cuadrado, con un borde cuadrado.
- **Foco con el teclado**: el indicador de foco se ve alrededor del botón igual que hoy, sin que la
  imagen lo tape.
- **Posición a la izquierda**: la opción funciona igual en las dos esquinas.
- **Diseño guardado y opción guardada a la vez**: la opción forma parte del mismo "Guardar" del
  diseño (todo o nada, 011); si el guardado se rechaza por otro campo, la opción tampoco se guarda.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: El diseño del chat MUST incluir una opción "Icono a tamaño completo", activada o
  desactivada, que el operador cambia en la sección "Diseño del chat" del panel.
- **FR-002**: La opción MUST venir desactivada por defecto, en los diseños nuevos y en los ya
  guardados antes de esta feature.
- **FR-003**: Con la opción activada **y** un icono propio, el icono MUST rellenar todo el botón
  flotante, recortado con la forma del botón y sin deformarse (recortando lo que sobre), salvo un
  borde fino del color principal alrededor.
- **FR-004**: El borde MUST ser del color principal del chat, tener el mismo grosor con cualquier
  forma y verse alrededor de todo el contorno del botón.
- **FR-005**: Con la opción desactivada, o sin icono propio, o si el icono no se puede cargar en el
  navegador, el botón MUST verse exactamente igual que antes de esta feature.
- **FR-006**: La opción MUST NOT cambiar el tamaño ni la posición del botón, el tamaño del chat
  cerrado ni abierto, ni ningún otro elemento del diseño.
- **FR-007**: El botón MUST conservar su etiqueta accesible ("Abrir el chat"), su indicador de foco
  visible con el teclado y su comportamiento al pulsarlo, con la opción activada o sin ella. La
  imagen sigue siendo decorativa.
- **FR-008**: La vista previa del panel MUST reflejar la opción al momento, sin guardar, igual que
  el resto del diseño.
- **FR-009**: La opción MUST guardarse con el resto del diseño en el mismo "Guardar" (todo o nada) y
  aplicarse en la siguiente carga del chat.
- **FR-010**: El formulario MUST indicar junto a la opción que solo tiene efecto si hay un icono
  propio, para que el operador no espere un cambio sin él.
- **FR-011**: La opción MUST incluirse en la exportación de la configuración y aplicarse en la
  importación, y la vista previa de la importación MUST mostrar su cambio cuando lo haya.
- **FR-012**: La versión del formato de la configuración MUST subir, y un fichero de una versión
  anterior MUST importarse con la opción desactivada.
- **FR-013**: El resumen de la sección "Diseño del chat" en el panel MUST seguir siendo correcto con
  la opción activada (no puede indicar que el diseño está sin configurar ni ocultar que hay icono).

### Key Entities

- **Diseño del chat** (011): gana un dato nuevo, **icono a tamaño completo** (sí/no, por defecto
  no). Hay un único diseño por instancia, así que hay una única opción por instancia.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Con la opción activada, el icono ocupa al menos el 85 % del ancho del botón, frente
  a aproximadamente el 50 % de hoy.
- **SC-002**: Tras actualizar el núcleo, el 100 % de las instancias existentes muestran el botón sin
  ningún cambio visible hasta que el operador active la opción.
- **SC-003**: El operador activa la opción y ve el resultado en la vista previa en menos de 10
  segundos, sin guardar ni recargar.
- **SC-004**: Una configuración exportada con la opción activada se importa en otra instancia y el
  botón queda igual en las dos, sin pasos manuales.
- **SC-005**: Todo fichero de configuración exportado antes de esta feature se sigue importando sin
  errores.

## Assumptions

- "Borde fino" es un grosor fijo de pocos píxeles (del orden de 2 a 3 px) que el operador no elige;
  se fija en el plan. Si se quisiera configurable, sería otra feature.
- La imagen se recorta con la forma del botón elegida en el diseño (recta, suave o redondeada), no
  siempre en círculo: con la forma redondeada, que es la de por defecto, el resultado es el círculo
  descrito por el negocio que lo pidió.
- La opción solo afecta al icono del botón flotante; el logo de la cabecera y el avatar no cambian.
- No se valida la resolución ni la proporción de la imagen más allá de lo que ya valida la 011.
- La sombra del botón se mantiene como hoy.
- Ejemplo ilustrativo (no requisito): un centro cuyo icono es su logo circular sobre fondo blanco
  quiere que el logo se vea entero en el botón, con un borde fino de su color corporativo.
