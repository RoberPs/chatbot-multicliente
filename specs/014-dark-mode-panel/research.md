# Research: Modo oscuro del panel del operador

Decisiones previas al diseño (Phase 0). No queda ningún NEEDS CLARIFICATION: las tres preguntas de
alcance se resolvieron con el usuario antes de escribir la spec y están en sus Assumptions.

## R1. Mecanismo del tema: tokens CSS en tres capas, sin JavaScript obligatorio

**Decisión**: el tema vive entero en las variables CSS de `:root`, en cuatro bloques de mapeo:

```css
:root { /* paletas y mapeo claro (lo de hoy) */ }
@media (prefers-color-scheme: dark) { :root:not([data-theme='light']) { /* mapeo oscuro */ } }
:root[data-theme='dark'] { /* mapeo oscuro forzado */ }
@media print { :root { /* mapeo claro, siempre */ } }
```

El atributo `data-theme` de `<html>` lo escribe el servidor al renderizar (R3), así que la primera
pintura ya llega con el tema correcto (FR-003) y el panel no necesita JavaScript para tener tema.

**Razón**: el panel ya concentra su color en nueve variables; añadir mapeos es la forma con menos
código y cero dependencias (FR-022). El selector `:root:not([data-theme='light'])` hace que la
preferencia del sistema se aplique salvo que el operador haya elegido claro, y `data-theme="dark"`
la fuerza — los tres estados de FR-008 sin una línea de JavaScript.

**Alternativas descartadas**:

- **`light-dark()` de CSS** (un solo valor por token: `--bg: light-dark(#f6f7f9, #11151b)`). Es más
  compacto, pero no admite respaldo: una propiedad personalizada acepta cualquier secuencia de
  tokens, así que un navegador sin soporte la guarda como válida y falla al sustituirla
  (*invalid at computed-value time*), dejando el panel sin fondo. Exigiría envolverlo todo en
  `@supports` y complica leer y comprobar la paleta. Descartada por riesgo, no por elegancia.
- **Clase en `<body>` aplicada por JavaScript**: obliga a un script antes de la primera pintura, y
  la CSP del panel es `script-src 'self'` sin `inline` ([src/app.ts:55-64](../../src/app.ts#L55-L64)):
  no hay forma de ejecutarlo antes del CSS sin relajar la CSP. Incumpliría FR-003.
- **Dos hojas de estilo y elegir una**: duplica el mantenimiento y añade una petición.
- **Framework de estilos** (Tailwind, Pico, Bootstrap): reescribiría las 20 plantillas y añadiría
  dependencia y proceso de construcción. Lo contrario de lo que pide la spec.

## R2. Una sola copia de cada color: paletas nombradas + mapeo

**Decisión**: los colores se escriben **una vez** como paleta (`--c-light-*`, `--c-dark-*`) en
`:root`, y los cuatro bloques de R1 solo mapean la paleta activa sobre los tokens de trabajo
(`--bg: var(--c-dark-bg)`, …). Ningún bloque de mapeo contiene un color literal.

**Razón**: el mapeo oscuro aparece dos veces (media query y atributo) y el claro otras dos (normal
e impresión); con la paleta aparte, repetir el mapeo no duplica ningún valor y un test puede
comprobar que los cuatro bloques declaran exactamente el mismo conjunto de tokens.

## R3. Dónde se recuerda la preferencia: cookie propia del panel

**Decisión**: cookie `kb_theme` con valor `light` o `dark`. **Automático = ausencia de cookie**
(también si el valor no es uno de los dos: se ignora, FR-011). El servidor la lee al renderizar y
pinta `<html data-theme="light|dark">`, o `<html>` sin atributo en automático.

**Razón**: es lo único que cumple FR-003 (sin destello) y FR-010 (nada en la base de datos) a la vez.
El servidor ya conoce el valor antes de generar la página, así que no hay un instante con el tema
contrario, y no hace falta migración, ni subir `formatVersion`, ni tocar `config-transfer`, ni las
copias de seguridad.

**Alternativas descartadas**:

- **Guardarlo en la sesión** (`request.session`): `endOperatorSession` hace `session.delete()` y el
  login hace `session.regenerate()`, así que la preferencia se perdería al cerrar sesión
  ([src/admin/auth/plugin.ts:40-51](../../src/admin/auth/plugin.ts#L40-L51)), y además caduca a las
  8 h. Incumpliría FR-009 y el escenario US2-4.
- **`localStorage`**: solo se puede leer desde JavaScript, y la CSP prohíbe el script inline que
  haría falta para aplicarlo antes de pintar. Incumpliría FR-003.
- **Columna en la base de datos**: migración, `formatVersion`, actualizador y cobertura de columnas
  para una preferencia visual que la spec quiere por navegador. Descartada en la spec (FR-010).

## R4. Atributos de la cookie, sin dependencia nueva

**Decisión**: `kb_theme=<valor>; Path=/admin; Max-Age=31536000; HttpOnly; SameSite=Lax` y `Secure`
cuando `NODE_ENV === 'production'` (igual que la cookie de sesión). Se lee parseando
`request.headers.cookie` y se escribe con `reply.header('set-cookie', …)`, en un módulo puro de una
veintena de líneas.

**Razón**: el proyecto no tiene `@fastify/cookie` y FR-022 prohíbe añadir dependencias;
`@fastify/secure-session` no decora `request.cookies`. Parsear un nombre concreto es trivial y se
prueba sin servidor.

- `Path=/admin`: la cookie no viaja al chat web ni a los webhooks, y cubre `/admin/login` (US2-4).
- `HttpOnly`: nada necesita leerla desde JavaScript (R6), así que se cierra el acceso.
- `SameSite=Lax` (no `Strict`): con `Strict` el primer acceso al panel desde un enlace externo
  llegaría sin cookie y el operador vería un destello en el tema contrario. La cookie no autoriza
  nada, así que `Lax` no abre ninguna vía: el CSRF lo siguen cubriendo la sesión y el token.
- `Max-Age` de un año: FR-009 (sobrevive a cierre de sesión, reinicio y actualización).

## R5. La ruta que cambia el tema

**Decisión**: `POST /admin/theme` registrada en el ámbito `/admin` **fuera** del ámbito del
operador, con `csrfOnPost` aplicado explícitamente. Cuerpo `theme=auto|light|dark` validado con Zod;
`auto` borra la cookie (`Max-Age=0`). Respuesta:

- petición de htmx → `204` sin contenido (el navegador ya aplicó el cambio, R6);
- petición normal → `303` a la ruta de origen, tomada del campo `next` y aceptada solo si empieza
  por `/admin` y no contiene `//` ni `:` (sin esa validación sería una redirección abierta).

**Razón**: así el control también funciona en la pantalla de acceso (FR-006), que ya emite token
CSRF. La ruta no lee ni escribe datos del negocio ni consulta la base de datos: solo valida tres
valores y pone una cookie, con el límite de peticiones global ya aplicado (FR-013).

**Alternativa descartada**: dejarla dentro del ámbito del operador (heredaría `requireOperator`
gratis) obligaría a quitar el control de la pantalla de acceso e incumpliría FR-006.

## R6. Cambio inmediato con htmx, y sin JavaScript

**Decisión**: el control es un `<form>` con tres opciones y `hx-post="/admin/theme"` y
`hx-swap="none"`. `app.js` escucha el cambio y aplica el tema al momento sobre
`document.documentElement`: `dataset.theme = 'light' | 'dark'`, o `delete dataset.theme` para
automático. Sin JavaScript, el `action` del formulario lo envía como POST normal y el `303` vuelve
a la misma pantalla (FR-012).

**Razón**: `hx-boost` sustituye el contenido de `<body>`, no los atributos de `<html>`, así que una
respuesta completa no cambiaría el tema hasta recargar. Aplicarlo en el navegador lo hace instantáneo
y, sobre todo, **no recarga**: lo escrito en los formularios se conserva (FR-007). Son nueve líneas
en `app.js`, que ya existe y se sirve desde el propio origen.

**Consecuencia para FR-004**: en automático no hay atributo, así que el cambio de preferencia del
sistema lo resuelve la media query sola, en caliente y sin recargar ni perder nada escrito. No hace
falta `matchMedia` ni ningún listener.

## R7. Paleta oscura y contrastes

**Decisión**: 16 tokens de trabajo. Los nueve de hoy más siete que hoy están escritos a mano en el
CSS y pasan a ser tokens: `--on-accent`, `--field`, `--control-line`, `--flash-bg`, `--flash-line`,
`--error-bg`, `--error-line`.

| Token | Claro (= hoy) | Oscuro | Contraste en oscuro |
|---|---|---|---|
| `--bg` | `#f6f7f9` | `#11151b` | — |
| `--card` | `#fff` | `#181d26` | — |
| `--field` | `#fff` | `#0d1117` | — |
| `--fg` | `#1d2330` | `#e6e9ef` | 15,05 sobre `--bg`; 13,90 sobre `--card`; 15,56 sobre `--field` |
| `--muted` | `#5f6878` | `#a3adbd` | 8,08 / 7,46 |
| `--accent` | `#1f5fbf` | `#7fb0ff` | 8,33 / 7,69 / 8,61 |
| `--on-accent` | `#fff` | `#0b1017` | 8,68 sobre `--accent` |
| `--ok` | `#1f7a4a` | `#6cc98f` | 9,06 / 8,36 |
| `--warn` | `#9a6200` | `#e5b969` | 10,01 / 9,24 |
| `--danger` | `#b3261e` | `#ff9b91` | 9,02 / 8,33 |
| `--line` | `#d9dde4` | `#2c3442` | separadores (decorativos) |
| `--control-line` | `#d9dde4` | `#6b7686` | 4,11 sobre `--field`; 3,98 / 3,67 |
| `--flash-bg` | `#e8f5ec` | `#102c1d` | `--ok` 7,42; `--fg` 12,33 |
| `--flash-line` | `#b7dcc4` | `#3f8a5d` | 4,36 sobre `--bg` |
| `--error-bg` | `#fdecea` | `#331418` | `--danger` 8,25; `--fg` 13,77 |
| `--error-line` | `#f1b7b2` | `#a85a60` | 3,75 sobre `--bg` |

Todas las parejas de texto superan 4,5 con holgura (la más baja, 6,83) y los bordes de control
superan 3. Las cifras se comprueban en un test unitario con `contrastRatio` de
[src/webchat/design/contrast.ts](../../src/webchat/design/contrast.ts), que ya implementa WCAG 2.x
para la feature 011: un umbral único en el producto, sin código nuevo de contraste.

**Nota sobre `--control-line`**: hoy el borde de los campos (`#d9dde4` sobre blanco, razón 1,27) no
llegaría a 3:1, pero FR-005 prohíbe cambiar la apariencia del modo claro, así que el token conserva
ese valor en claro y solo cumple 3:1 en oscuro, que es lo que exige FR-015. La asimetría es
deliberada y queda anotada aquí para que no se lea como un descuido.

**`color-scheme`**: cada bloque de mapeo declara también `color-scheme: light` o `dark`. Es lo que
hace que las barras de desplazamiento, los selectores de fecha y hora, los menús de `select` y los
cuadros de diálogo del navegador cambien de tema; sin ella quedarían zonas claras que FR-018
prohíbe, y no hay forma de darles estilo desde el CSS.

**Foco**: se añade `:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px }`, que
en oscuro da 8,33 contra el fondo (FR-015). Hoy el foco depende del dibujo del navegador, que sobre
fondo oscuro puede desaparecer.

## R8. Lo que NO cambia con el tema

**Decisión**: tres zonas usan colores fijos, con tokens propios al margen de la paleta
(`--fixed-sample`, `--fixed-canvas-a`, `--fixed-canvas-b`):

1. **La vista previa del chat** no necesita nada: son `<iframe>` con un documento propio
   (`chat-design/preview.eta`) que carga `frame.css` y la hoja del diseño del negocio, no `app.css`
   ([src/admin/views/chat-design/preview.eta:1-9](../../src/admin/views/chat-design/preview.eta#L1-L9)).
   FR-019 y FR-020 se cumplen por construcción: el tema del panel no entra en ese documento y el
   aviso de contraste se calcula en el servidor sobre los colores del negocio.
2. **El cuadriculado de detrás de la vista previa** (`#f6f7f9` / `#eef0f3`) representa la web del
   negocio, no el panel: se queda claro. Oscurecerlo haría que el operador juzgara el chat sobre un
   fondo que sus clientes no van a ver.
3. **Las miniaturas de las imágenes del negocio** (logotipo y avatar) y los `input[type='color']`
   conservan fondo claro fijo: son imágenes con transparencia que el negocio compone sobre su web
   clara, y sobre fondo oscuro se verían distintas de como se verán de verdad (edge case de la spec).

**Nombre en las plantillas**: el tema del panel viaja como `it.layout.theme`; `it.theme` ya está
ocupado en la vista previa por el tema del **chat** del negocio. Son dos cosas distintas y no se
cruzan.

## R9. Impresión

**Decisión**: `@media print` mapea siempre la paleta clara y `color-scheme: light`.

**Razón**: FR-021. Es un cuarto bloque de mapeo de R1, sin colores propios. Imprimir un panel oscuro
gasta tinta y, en muchas impresoras, los fondos no salen y el texto claro queda invisible.

## R10. Qué se prueba automáticamente y qué a ojo

**Decisión**:

- **Automático**: el parseo y la escritura de la cookie; el atributo `data-theme` que llega al HTML
  según la cookie, en panel y acceso; la ruta (CSRF, valores válidos e inválidos, htmx y sin htmx,
  atributos de la cookie, redirección validada); y un test que **lee `app.css`** y comprueba que los
  cuatro bloques de mapeo declaran el mismo conjunto de tokens, que ningún bloque de mapeo contiene
  un literal, que no queda ningún color literal fuera de la paleta y de los tres tokens fijos, y que
  todas las parejas declaradas cumplen 4,5:1 y 3:1.
- **A ojo, con la lista de [quickstart.md](quickstart.md)**: que ninguna de las 15 secciones tenga
  una zona del tema contrario, que los avisos críticos sigan destacando y que la vista previa del
  chat se vea igual en los dos temas. Un test no puede juzgar esto: el navegador no está en la
  suite y lo que se valida es percepción.

**Razón**: el test de CSS cubre lo que de verdad se rompe al añadir color nuevo (un token olvidado
en un bloque, un literal colado, una pareja sin contraste) sin montar un navegador, que sería una
dependencia nueva prohibida por FR-022.

## R11. Momento de entrega

**Decisión**: la feature se implementa después del despliegue y su validación final (SC-008) se hace
sobre la instancia real, con la lista de quickstart.

**Razón**: lo pidió el usuario y no hay ninguna dependencia técnica en el otro sentido: el modo
oscuro no toca la base de datos, el formato de configuración, los canales ni el bot, así que entra
como una actualización de núcleo normal, por el procedimiento por tandas de la feature 009.
