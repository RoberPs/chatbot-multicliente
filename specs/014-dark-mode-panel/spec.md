# Feature Specification: Modo oscuro del panel del operador

**Feature Branch**: `014-dark-mode-panel`

**Created**: 2026-10-06

**Status**: Draft — **pendiente de implementar después del despliegue en producción**

**Ámbito**: núcleo (genérico, aplica a todos los clientes)

**Input**: User description: "para crear un modo oscuro sencillo para el panel de instancia.
Utilizando la forma y framework mas sencilla sin tener que modificar mucho codigo. Esta spec queda
pendiente para despues del despliegue y asi añadirla al funcionamiento en el entorno real."

## Contexto

El panel del operador solo existe en claro: fondo muy luminoso y tinta oscura. Quien registra la
información de un negocio pasa ahí sesiones largas, a veces de noche, y el resto de su escritorio
(editor, terminal, navegador) suele estar en oscuro. Pasar del editor al panel obliga a los ojos a
readaptarse cada vez.

El panel está bien preparado para esto: todo su color nace de nueve variables declaradas una sola
vez, y solo quedan unos trece colores escritos a mano en sitios concretos (avisos de éxito y
error, tarjetas, botones, el fondo a cuadros de la vista previa). Es decir, el modo oscuro se
resuelve en su mayor parte redefiniendo esas variables, sin añadir ninguna dependencia nueva ni
reescribir las pantallas.

Dos cosas condicionan el alcance:

- El panel tiene zonas que **muestran los colores del negocio**, no los del panel: la vista previa
  del chat web y sus muestras de color (feature 011), que ya exigen un contraste mínimo de 4,5:1
  entre los colores elegidos por el cliente. Esos colores no pueden cambiar con el tema del panel,
  o el operador dejaría de ver lo que verá el cliente final.
- El panel usa el color para informar: avisos críticos, estados correcto/aviso/peligro, bandas de
  protección y de gasto, errores de formulario. En oscuro tienen que seguir distinguiéndose y
  destacando igual, o la feature empeora el trabajo en lugar de facilitarlo.

Esta spec no viene de ninguna propuesta pendiente de
[docs/operacion-multicliente.md, sección 9.2](../../docs/operacion-multicliente.md): es una mejora
de comodidad del panel, y por eso **se implementa después del despliegue en producción**, cuando el
operador ya trabaja a diario en el entorno real y puede comprobar el resultado sobre datos
verdaderos.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - El panel acompaña al sistema (Priority: P1)

El operador tiene su ordenador en modo oscuro. Abre el panel de una instancia y aparece ya oscuro,
sin ningún destello claro al cargar, igual que el resto de sus ventanas. Cuando por la mañana su
sistema vuelve al modo claro, el panel también, sin que él haga nada.

**Why this priority**: resuelve el problema de raíz para el caso más común y es la parte más
pequeña: ninguna decisión que recordar, ningún control nuevo, ningún estado que guardar. Si solo se
entregara esto, la feature ya aportaría todo su valor principal.

**Independent Test**: se prueba a solas cambiando la preferencia de color del sistema operativo (o
simulándola en el navegador) y recorriendo el panel: todas las pantallas, incluida la de acceso,
cambian de tema y siguen siendo legibles.

**Acceptance Scenarios**:

1. **Given** el sistema del operador declara preferencia por el modo oscuro, **When** abre
   cualquier pantalla del panel, **Then** la pantalla se presenta oscura desde la primera pintura,
   sin un instante en claro.
2. **Given** el sistema declara preferencia clara o no declara ninguna, **When** abre el panel,
   **Then** se presenta en claro, exactamente como hoy.
3. **Given** el operador todavía no ha iniciado sesión, **When** llega a la pantalla de acceso,
   **Then** esa pantalla sigue el mismo tema que el resto del panel.
4. **Given** el panel está abierto con un formulario a medio rellenar, **When** el sistema cambia
   de preferencia de color, **Then** la pantalla adopta el tema nuevo y conserva todo lo escrito.

---

### User Story 2 - Elegir el tema y que se recuerde (Priority: P2)

El operador prefiere el panel oscuro aunque su sistema esté en claro (o al contrario: trabaja en
oscuro pero quiere el panel claro para revisar los colores de un chat). En la barra superior elige
entre **Automático**, **Claro** y **Oscuro**. La elección se aplica al momento y sigue puesta al
día siguiente, sin volver a pedirla.

**Why this priority**: cubre a quien no quiere depender del sistema, pero solo tiene sentido una
vez existe el tema oscuro. Es la parte que añade un control y una preferencia que recordar.

**Independent Test**: se prueba a solas eligiendo cada una de las tres opciones, recargando,
cerrando sesión y volviendo a entrar, y cerrando y reabriendo el navegador: la elección se respeta
en todos los casos.

**Acceptance Scenarios**:

1. **Given** el panel en cualquier pantalla, **When** el operador abre el control de tema,
   **Then** ve las tres opciones y cuál está activa.
2. **Given** el sistema en claro, **When** el operador elige **Oscuro**, **Then** el panel pasa a
   oscuro de inmediato, sin perder el contenido de los formularios en curso.
3. **Given** el operador eligió **Oscuro**, **When** vuelve a abrir el panel al día siguiente en el
   mismo navegador, **Then** sigue en oscuro aunque su sistema esté en claro.
4. **Given** el operador eligió **Oscuro**, **When** cierra sesión y vuelve a entrar, **Then** la
   pantalla de acceso y el panel siguen en oscuro.
5. **Given** el operador eligió **Claro** u **Oscuro**, **When** vuelve a elegir **Automático**,
   **Then** el panel vuelve a seguir la preferencia del sistema.
6. **Given** la instancia se reinicia o se actualiza a una versión nueva, **When** el operador
   vuelve al panel, **Then** su elección de tema sigue puesta.
7. **Given** el operador entra desde otro ordenador o otro navegador, **When** abre el panel,
   **Then** empieza en **Automático**, porque la preferencia es de cada navegador.

---

### User Story 3 - Nada se vuelve ilegible ni engañoso en oscuro (Priority: P3)

El operador recorre el panel entero en oscuro: portada con avisos, horarios, servicios, preguntas
frecuentes, derivaciones, consumo, exportar e importar. Todo se lee con comodidad, los avisos
críticos siguen saltando a la vista, y la vista previa del chat sigue mostrando los colores exactos
que verá el cliente final del negocio.

**Why this priority**: es lo que convierte el tema oscuro en algo utilizable en lugar de un cambio
cosmético con zonas rotas. Se verifica sobre lo entregado en P1, así que va después, pero sin ella
la feature no puede darse por terminada.

**Independent Test**: se prueba a solas recorriendo todas las secciones del panel en oscuro y
comprobando automáticamente el contraste de cada pareja de texto y fondo, más una comparación de la
vista previa del chat entre los dos temas.

**Acceptance Scenarios**:

1. **Given** el panel en oscuro, **When** se recorre cualquier sección, **Then** no aparece ninguna
   zona que siga en claro (tarjetas, tablas, avisos, bandas, pie de versión) ni ningún texto por
   debajo del contraste mínimo.
2. **Given** un negocio con avisos críticos, **When** el operador abre la portada en oscuro,
   **Then** los avisos críticos siguen distinguiéndose de los no críticos y destacando sobre el
   resto del contenido.
3. **Given** un formulario con un campo mal rellenado, **When** el panel muestra el error en
   oscuro, **Then** el error es legible, se distingue del contenido normal y sigue teniendo su
   texto, sin depender solo del color.
4. **Given** un negocio con un diseño de chat de colores claros, **When** el operador abre
   **Diseño del chat** en oscuro, **Then** la vista previa muestra esos colores claros sin
   alterarlos, y solo se oscurece el marco del panel que la rodea.
5. **Given** ese mismo diseño de chat, **When** el panel calcula el aviso de contraste de los
   colores elegidos, **Then** el resultado es el mismo en claro y en oscuro.
6. **Given** el panel en oscuro, **When** el operador recorre la pantalla con el teclado, **Then**
   el elemento enfocado se distingue claramente en todo momento.
7. **Given** el panel en oscuro, **When** el operador imprime una pantalla o la guarda como PDF,
   **Then** el resultado sale legible sobre fondo claro.

---

### Edge Cases

- **Preferencia guardada ausente, vacía o con un valor desconocido** (primera visita, navegador
  que no la conserva, manipulación manual): el panel se comporta como **Automático**, sin error
  visible ni pantalla en blanco.
- **Navegador sin JavaScript o con el control no disponible**: el panel sigue completamente
  usable; el tema cae en **Automático** y el control, si se usa, puede recargar la pantalla en
  lugar de cambiar al instante.
- **Navegador que no sabe declarar la preferencia del sistema**: el panel se presenta en claro,
  como hoy, y el control explícito sigue funcionando.
- **Fragmentos recargados sin recargar la pantalla** (listados y formularios que se actualizan por
  partes): el contenido nuevo aparece ya con el tema activo, nunca en el tema contrario.
- **Imágenes subidas por el negocio** (logotipo, avatar del chat) con fondo transparente o claro:
  se muestran tal cual, sin invertir ni teñir; si quedan sobre fondo oscuro, se les da un soporte
  que las mantenga visibles.
- **Dos pestañas del panel abiertas**: cambiar el tema en una no rompe la otra; la otra lo adopta
  al recargar o al recibir contenido nuevo.
- **Negocio sin nombre, sin avisos o sin datos**: los estados vacíos también quedan legibles en
  oscuro.

## Requirements *(mandatory)*

### Functional Requirements

**Tema automático (P1)**

- **FR-001**: El panel MUST presentarse en modo oscuro cuando el navegador del operador declara
  preferencia por el modo oscuro, y en modo claro cuando declara preferencia clara o no declara
  ninguna.
- **FR-002**: El comportamiento de FR-001 MUST aplicarse a todas las pantallas del panel, incluida
  la de acceso antes de iniciar sesión.
- **FR-003**: La primera presentación de cada pantalla MUST llegar ya con el tema correcto: el
  operador MUST NOT percibir un instante en el tema contrario.
- **FR-004**: Cuando la preferencia del sistema cambia con el panel abierto, la pantalla MUST
  adoptar el tema nuevo sin recargarse y sin perder lo que el operador haya escrito.
- **FR-005**: El modo claro MUST conservar la apariencia actual del panel: esta feature MUST NOT
  cambiar los colores, los tamaños ni la disposición de lo que el operador ya ve hoy.

**Elección explícita y memoria (P2)**

- **FR-006**: El panel MUST ofrecer, desde todas sus pantallas, un control con tres opciones
  —**Automático**, **Claro** y **Oscuro**— e indicar cuál está activa.
- **FR-007**: Elegir una opción MUST aplicarse de inmediato, sin perder el contenido de los
  formularios en curso.
- **FR-008**: Con **Claro** u **Oscuro** elegidos, el panel MUST ignorar la preferencia del
  sistema; con **Automático** MUST volver a seguirla.
- **FR-009**: La preferencia elegida MUST recordarse para las visitas siguientes del mismo
  navegador, y MUST sobrevivir al cierre de sesión, al reinicio de la instancia y a una
  actualización de versión.
- **FR-010**: La preferencia MUST ser de cada navegador y dispositivo: MUST NOT formar parte de la
  configuración del negocio, MUST NOT aparecer al exportar ni al importar la configuración, MUST
  NOT entrar en las copias de seguridad y MUST NOT requerir cambios en el esquema de la base de
  datos ni en el formato de configuración.
- **FR-011**: Si la preferencia guardada falta, está vacía o tiene un valor desconocido, el panel
  MUST comportarse como **Automático** sin mostrar ningún error.
- **FR-012**: El control MUST seguir siendo utilizable sin JavaScript, aunque en ese caso el cambio
  se aplique recargando la pantalla; y sin el control, el panel MUST seguir funcionando en
  **Automático**.
- **FR-013**: El cambio de tema MUST NOT exponer ninguna acción capaz de modificar la configuración
  del negocio ni de alterar datos, y MUST respetar las mismas protecciones que el resto del panel.

**Legibilidad y significado del color (P3)**

- **FR-014**: En modo oscuro, toda pareja de texto y su fondo MUST alcanzar un contraste de 4,5:1,
  o de 3:1 para texto grande, igual que ya se exige al diseño del chat.
- **FR-015**: En modo oscuro, los bordes de los controles de formulario y la marca del elemento
  enfocado por teclado MUST alcanzar un contraste de 3:1 contra su fondo.
- **FR-016**: Los estados que hoy se distinguen por color —correcto, aviso, crítico, error de
  formulario, borrador frente a activo— MUST seguir distinguiéndose entre sí en modo oscuro, y MUST
  NOT depender solo del color: conservan su texto o su etiqueta.
- **FR-017**: Los avisos críticos y las bandas de protección y de gasto MUST seguir destacando
  sobre el resto del contenido en modo oscuro.
- **FR-018**: Ninguna zona del panel MUST quedar con los colores del tema contrario al activo,
  incluidos tarjetas, tablas, listados, bandas, mensajes y pie de versión.
- **FR-019**: Las zonas en las que el panel muestra colores o imágenes del negocio —vista previa del
  chat, muestras de color, logotipo y avatar subidos— MUST mostrarlos sin alterarlos en ningún
  tema; solo cambia el marco del panel que las rodea.
- **FR-020**: El aviso de contraste del diseño del chat MUST calcularse siempre sobre los colores
  elegidos por el negocio y MUST dar el mismo resultado en los dos temas del panel.
- **FR-021**: Al imprimir una pantalla del panel o guardarla como PDF, el resultado MUST ser
  legible sobre fondo claro, sea cual sea el tema activo.

**Simplicidad (restricción transversal)**

- **FR-022**: La feature MUST NOT añadir ninguna dependencia externa nueva (ni biblioteca, ni
  framework de estilos, ni recurso servido desde fuera de la instancia).
- **FR-023**: La feature MUST NOT introducir nombres, textos ni lógica de ningún sector o cliente
  en el núcleo, ni cambiar el comportamiento del bot, de los canales de atención ni del chat web
  que ven los clientes finales.

### Key Entities

- **Preferencia de tema del panel**: la elección del operador entre **Automático**, **Claro** y
  **Oscuro**. Vive en el navegador del operador, no en los datos del negocio: no se exporta, no se
  copia con las copias de seguridad y no se comparte entre navegadores ni dispositivos. En ausencia
  de valor válido, equivale a **Automático**.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Un operador con el sistema en oscuro abre cualquiera de las pantallas del panel y la
  ve oscura desde el primer momento, sin ningún destello claro perceptible, en el 100% de las
  cargas.
- **SC-002**: Cambiar el tema se consigue desde cualquier pantalla en 2 interacciones y menos de 5
  segundos, sin abandonar la pantalla en la que se estaba.
- **SC-003**: La elección de tema se respeta en el 100% de las visitas posteriores del mismo
  navegador, incluidas las que siguen a un cierre de sesión, un reinicio de la instancia o una
  actualización de versión.
- **SC-004**: El 100% de las parejas de texto y fondo del panel en modo oscuro cumplen el contraste
  mínimo (4,5:1, o 3:1 en texto grande), comprobado de forma automática y repetible.
- **SC-005**: Un recorrido por todas las secciones del panel en modo oscuro no encuentra ninguna
  zona con los colores del tema contrario ni ningún texto ilegible.
- **SC-006**: La apariencia del panel en modo claro es idéntica a la anterior a la feature, y los
  colores del chat del negocio se ven exactamente iguales en los dos temas.
- **SC-007**: La feature se entrega sin ninguna dependencia externa nueva, sin migraciones de base
  de datos y sin subir el formato de configuración del negocio.
- **SC-008**: Tras la entrega, el operador trabaja una jornada completa en el entorno real con el
  tema que prefiere y no necesita volver al tema anterior para leer o verificar ninguna sección.

## Assumptions

- **Momento de entrega**: la feature se implementa **después** del despliegue en producción y se
  valida sobre la instancia real, con datos verdaderos. No bloquea ni condiciona el despliegue.
- **Mecanismo de memoria elegido**: la preferencia se recuerda en el propio navegador mediante una
  marca que el servidor ya conoce al generar la pantalla, para poder cumplir FR-003 (nada de
  destello claro) sin tocar la base de datos ni el formato de configuración. Es por navegador y
  dispositivo por decisión expresa, no por limitación.
- **Alcance de pantallas**: entra todo el panel del operador, incluida la pantalla de acceso. El
  chat web que ven los clientes finales queda fuera: su diseño ya lo configura cada negocio
  (feature 011) y cambiarlo sería otra feature.
- **Un solo par de temas**: claro y oscuro. No entran temas por marca, variantes de alto contraste,
  cambio de tipografía ni ajuste del tamaño de letra.
- **Navegadores**: se asume un navegador actual, capaz de declarar la preferencia de color del
  sistema. Los que no la declaran reciben el modo claro actual, que sigue siendo plenamente
  utilizable.
- **Base de partida**: el panel ya concentra su color en un conjunto reducido de variables, y los
  pocos colores escritos a mano que quedan se pasan a esas variables como parte de la feature. De
  ahí que no haga falta reescribir pantallas.
- **Umbral de contraste**: se reutiliza el mismo criterio que el panel ya aplica al diseño del chat
  (4,5:1), para no introducir una regla distinta en el mismo producto.
- **Ámbito núcleo**: el modo oscuro es del núcleo y llega igual a todas las instancias; ninguna
  instancia necesita configuración para tenerlo.
