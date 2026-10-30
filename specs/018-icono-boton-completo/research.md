# Research: 018 — Icono del botón a tamaño completo y datos que el bot no ha guardado

## R1. Cómo rellenar el botón con el icono

- **Decision**: `.toggle .design-icon` pasa a `position: absolute; inset: 0; width: 100%;
  height: 100%; border-radius: inherit; object-fit: cover`. El botón ya es `position: absolute`,
  así que la imagen se coloca respecto a él.
- **Rationale**: `object-fit: cover` rellena sin deformar y recorta lo que sobra (US1, escenario
  3). `border-radius: inherit` toma el radio de la forma elegida (`--chat-radius-toggle`), así que
  la imagen sigue la forma del botón sin código por forma.
- **Alternatives considered**: `contain` a 100 %: deja bandas del color principal con iconos no
  cuadrados. Ampliar con `transform: scale`: el borde quedaría distinto según la forma.

## R2. Cómo dibujar el borde fino

- **Decision**: un anillo encima de la imagen con
  `.toggle:has(.design-icon)::after { content: ''; position: absolute; inset: 0;
  border-radius: inherit; border: 3px solid var(--chat-accent); pointer-events: none; }` y
  `box-sizing: border-box`.
- **Rationale**: dibujado sobre el mismo contorno que el botón, el anillo tiene **exactamente**
  3 px con las tres formas (FR-002), también en las esquinas; con una imagen encogida y un radio
  interior, el grosor variaría en las esquinas de la forma suave. `:has()` hace que el anillo solo
  exista cuando hay icono: sin icono, o cuando `frame.js` quita la imagen rota (011), no hay
  pseudoelemento y el botón es idéntico al de antes (FR-003). `pointer-events: none` deja el clic
  al botón.
- **Grosor**: 3 px de 56 → el icono visible ocupa 50/56 ≈ 89 % del ancho (SC-001 ≥ 85 %).
- **Navegadores sin `:has()`** (Firefox < 121, Safari < 15.4): no hay anillo y el icono se ve a
  sangre completa, sin borde. Degradación aceptable; no rompe nada.
- **Alternatives considered**: anillo siempre presente (también sin icono): sobre el fondo del
  mismo color es invisible, pero añade una capa al botón sin icono y FR-003 pide el botón idéntico.
  Clase en la plantilla cuando hay icono: el anillo seguiría tras quitar `frame.js` la imagen rota.

## R3. Foco, sombra y accesibilidad

- **Decision**: no se toca. El foco es `outline` con `outline-offset: 2px` (por fuera del botón),
  que ni la imagen ni el anillo tapan; la sombra es del botón; la etiqueta accesible está en el
  `span.sr-only` y la imagen sigue con `alt=""` (FR-005).

## R4. Dónde va la regla de los datos no guardados

- **Decision**: una regla más en `RULES` de `src/llm/prompt.ts`, justo después de la de petición de
  persona:

  > Datos del cliente: tú no guardas datos ni avisas a nadie. Nunca digas que has anotado,
  > guardado, registrado o pasado datos del cliente, ni que el negocio le llamará o se pondrá en
  > contacto con él: eso solo lo confirma el sistema cuando avisa de verdad al negocio. Si el
  > cliente te da su nombre o su teléfono sin que se los hayas pedido, no comentes nada sobre ellos,
  > remítele al negocio y marca offerContact.

- **Rationale**: es una regla de comportamiento común a todos los negocios (Principios IV y V), no
  un estilo; en el tono dependía de que el operador la recordara. `offerContact` hace que el
  sistema añada el bloque de contacto o la oferta de derivación configurada, así que el cliente
  sigue teniendo la salida real. La confirmación «He avisado a…» la escribe el sistema (plantilla
  de derivación), no el modelo, así que la regla no la afecta (FR-009).
- **Alternatives considered**: filtrar la respuesta del modelo con una expresión regular: frágil
  (paráfrasis) y podría cortar frases legítimas; regla en el tono de cada instancia: es lo que se
  hace hoy y no cubre a las instancias que no la tienen.

## R5. Cómo se prueba

- **Unitaria** (`tests/unit/llm/prompt.test.ts`): el prompt común contiene la regla y menciona
  `offerContact`.
- **Contrato** (`tests/contract/web-chat-design.test.ts`): el `frame.css` servido lleva
  `object-fit: cover`, `border-radius: inherit` y el anillo `:has(.design-icon)::after` con
  `var(--chat-accent)`; la regla de 28 px desaparece.
- **Evaluación** (`tests/eval/sc-unsaved-contact.test.ts`, `pnpm test:eval`, con coste): en los tres
  sectores de prueba, con y sin vías de aviso, el cliente da nombre y teléfono sin que se los pidan
  (solos y junto a una pregunta); la respuesta no debe contener `anot`, `guard`, `registr`,
  `apunt`, `tomo nota`, ni promesas de contacto (`te llamar`, `se pondr… en contacto`, `nos
  pondremos`, `te contactar`), salvo cuando la respuesta es la plantilla del sistema que confirma
  una derivación. Se lanza solo con permiso del operador (coste).
- **Visual**: el aspecto del botón no se puede probar con Vitest; se comprueba en la vista previa
  del panel y en la demo (quickstart).

## R6. Versión

- **Decision**: `package.json` a **0.1.4** y despliegue por la sección 5 de
  `docs/operacion-multicliente.md` (instancia de pruebas → resto). No hay migraciones, así que la
  vuelta atrás es volver a la imagen 0.1.3.
