# Implementation Plan: Modo oscuro del panel del operador

**Branch**: `014-dark-mode-panel` | **Date**: 2026-10-06 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/014-dark-mode-panel/spec.md`

**Ámbito**: Núcleo

**Estado**: pendiente de implementar **después del despliegue en producción** (spec, Status y R11).

## Summary

El panel del operador gana modo oscuro: sigue a la preferencia del sistema y, además, ofrece un
control de tres opciones —Automático, Claro, Oscuro— en la barra superior y en la pantalla de acceso.
La elección se recuerda en una cookie propia del panel, el servidor la lee al renderizar y pinta el
tema en el atributo `data-theme` de `<html>`, así que la página llega ya con el tema correcto y no
hay destello. El modo claro queda exactamente como hoy.

Enfoque técnico: todo el tema vive en las variables CSS que el panel ya usa, más un módulo pequeño
para la cookie y una ruta que la pone.

1. **CSS** — las dos paletas se escriben una sola vez (`--c-light-*`, `--c-dark-*`) y cuatro bloques
   mapean la activa sobre 16 tokens de trabajo: claro por omisión, oscuro por media query salvo
   `data-theme="light"`, oscuro forzado por `data-theme="dark"`, y claro siempre al imprimir. Los
   trece colores que hoy están escritos a mano en el CSS pasan a tokens, se declara `color-scheme`
   en cada bloque y se añade un foco visible (R1, R2, R7, R9).
2. **Cookie** — módulo puro `src/admin/theme.ts`: lee `kb_theme` de la cabecera, valida el valor,
   devuelve el atributo para `<html>` y construye la cabecera `Set-Cookie`. Sin dependencias nuevas
   (R3, R4).
3. **Renderizado** — `renderPage` añade `layout.theme`; la pantalla de acceso recibe lo mismo; el
   atributo se pinta en `layout.eta` y `login.eta`, y el control es una parcial compartida (R3).
4. **Ruta** — `POST /admin/theme` en el ámbito `/admin` fuera del ámbito del operador, con CSRF:
   `204` para htmx y `303` a la ruta de origen validada para quien no ejecute JavaScript (R5).
5. **Instantáneo** — nueve líneas en `app.js` ponen o quitan `data-theme` al cambiar la opción, así
   que el tema cambia sin recargar y sin perder lo escrito en los formularios (R6).
6. **Intacto** — la vista previa del chat, su cuadriculado y las miniaturas de las imágenes del
   negocio no cambian de color: son colores del cliente, no del panel (R8).

Detalle de decisiones en [research.md](research.md); tokens, paletas y contrastes en
[data-model.md](data-model.md).

## Technical Context

**Language/Version**: TypeScript 5.x (strict) sobre Node.js 22 LTS (heredado)

**Primary Dependencies**: las existentes — Fastify 5, `@fastify/secure-session` y
`@fastify/csrf-protection` (ya registrados), Eta + htmx, Zod. **Sin dependencias nuevas** (FR-022):
la cookie se lee y se escribe con la cabecera, porque el proyecto no tiene `@fastify/cookie` y
`@fastify/secure-session` no decora `request.cookies` (R4). Tampoco hay proceso de construcción de
CSS: `app.css` se sirve tal cual desde [src/app.ts:315-320](../../src/app.ts#L315-L320).

**Storage**: ninguno. **Sin migración**, sin tablas y sin tocar `src/db`. La preferencia vive en la
cookie `kb_theme` del navegador (R3): **no sube `formatVersion`**, no entra en `config-transfer`, no
aparece en la exportación ni en las copias de seguridad, y el test de cobertura de columnas no se ve
afectado (FR-010).

**Testing**: Vitest —
`unit` (`src/admin/theme.ts`: cookie ausente, con `light`, con `dark`, con valor desconocido, con
otras cookies alrededor, con espacios, repetida; atributos de `Set-Cookie` en producción y fuera;
borrado en automático; validación del destino de la redirección —`/admin/x` sí, `//evil`, `http:`,
`/chat` no—. Y `tests/unit/admin/theme-css.test.ts`, que lee `app.css` y comprueba: los cuatro
bloques de mapeo declaran el mismo conjunto de 16 tokens; ningún bloque de mapeo contiene un color
literal; no queda ningún literal fuera de la paleta y de los tres tokens fijos; y todas las parejas
declaradas cumplen 4,5:1 o 3:1 con `contrastRatio` de la feature 011),
`contract` (`fastify.inject`: `data-theme` según la cookie en una página del panel y en `/admin/login`;
sin cookie, sin atributo; el control presente en las dos con su token CSRF; `POST /admin/theme` con
los tres valores, con htmx (`204`) y sin htmx (`303` al origen), valor inválido (`422`), sin CSRF
(`403`), atributos y `Max-Age` de la cookie, borrado en `auto`, redirección rechazada → `/admin`; y
que la vista previa de **Diseño del chat** no cambia con el tema),
`integration` (ninguno nuevo: no hay base de datos implicada).
Sin `eval` nuevo: el bot no cambia. La percepción (ninguna zona del tema contrario, avisos que
destacan, vista previa idéntica) se valida con la lista de [quickstart.md](quickstart.md) (R10).

**Target Platform**: servidor Linux (contenedor `node:22-slim`); panel en navegadores actuales de
escritorio. Un navegador que no sepa declarar la preferencia del sistema recibe el panel claro de
hoy y el control explícito sigue funcionando.

**Project Type**: servicio web (monolito modular). Cambios solo en `src/admin` y una línea de
registro en `src/app.ts`. El dominio (`src/knowledge`, `src/conversation`, `src/webchat`), los
canales, `src/db` y `src/config-transfer` no se tocan.

**Performance Goals**: coste por página, el parseo de una cabecera de cookie (microsegundos) y una
cadena de dos atributos: sin consultas nuevas. `app.css` crece unos 90 líneas (~2 KB sin comprimir)
y sigue siendo la misma hoja para los dos temas, así que conserva su `Cache-Control: public,
max-age=3600`. Las páginas del panel ya salen con `Cache-Control: no-store`
([src/app.ts:292](../../src/app.ts#L292)), así que depender de una cookie no necesita `Vary`.

**Constraints**: la CSP del panel no cambia (`script-src 'self'`, `style-src 'self'`, sin `inline`),
y por eso el tema se resuelve en el servidor y no con un script previo al CSS (R1); el modo claro
MUST quedar idéntico al actual (FR-005), lo que obliga a que la paleta clara sea copia literal de
los valores de hoy; nada de lo que la spec no menciona cambia en el panel; `src/` sigue sin nombres
ni reglas de ningún sector.

**Scale/Scope**: un tema por navegador; 16 tokens y 3 colores fijos; 15 secciones del panel más la
pantalla de acceso; una ruta nueva, un módulo nuevo, una parcial nueva y seis ficheros existentes
tocados.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principio | Cómo se cumple | Estado |
|---|---|---|
| I. Base común única | Spec de núcleo. El tema es el mismo para todas las instancias; ningún nombre de sector o cliente entra en `src/`, ni como color ni como texto. No hay rama por tipo de negocio. | ✅ |
| II. Configuración antes que código | No aplica como configuración del negocio: el tema es una preferencia del operador en su navegador, no un dato del negocio, y por eso **no** entra en el modelo de configuración (FR-010). Llega a todas las instancias sin que ninguna configure nada. | ✅ |
| III. Personalizaciones aisladas | No es una extensión y no añade puntos de extensión. La cookie es del navegador del operador: ninguna instancia afecta a otra. | ✅ |
| IV. Solo información registrada | La cadena de respuesta, el prompt y el snapshot no se tocan. El tema solo afecta a la presentación del panel; el bot no lo ve. | ✅ |
| V. Siempre hay salida a una persona | El chat web que ven los clientes finales queda fuera del alcance (FR-023): el aviso de asistente automático, el enlace de privacidad y la salida a una persona no cambian. En el panel, el contacto de derivación y el recuadro «Contacto que usa el bot» siguen visibles y con contraste comprobado (FR-014, FR-017). | ✅ |
| VI. El operador registra la información | El control es del operador y no da al negocio ninguna vía nueva: la ruta solo pone una cookie, no lee ni escribe configuración (R5, FR-013). | ✅ |
| Restricciones: canales | No toca ningún canal de atención ni la cadena de respuesta. | ✅ |
| Restricciones: aislamiento | Nada se guarda en la instancia; la cookie va limitada a `Path=/admin` de su propio origen. | ✅ |
| Flujo: pruebas de IV y V | La feature no afecta a la conversación, así que no hace falta prueba nueva de IV y V; las existentes siguen en la suite. Un test de contrato comprueba además que la vista previa del chat no cambia con el tema. | ✅ |

**Convenciones de CLAUDE.md**:

- *El dominio no depende de HTTP*: no se toca el dominio. `src/admin/theme.ts` es puro (cadenas de
  entrada y de salida) y las cabeceras las manejan las rutas. El test de contraste importa
  `src/webchat/design/contrast.ts`, pero solo desde `tests/`: no se crea ninguna dependencia de
  producción entre el panel y el dominio del chat. ✅
- *Avisos y escrituras en transacción*: no hay escritura de configuración, así que no hay
  transacción, ni recálculo de avisos, ni FR-032 que vigilar. ✅
- *Migraciones de solo añadir* y *`formatVersion` + actualizador*: no aplica, no hay migración ni
  configuración nueva del negocio. ✅
- *Importes en céntimos, horarios en hora local*: no aplica. ✅
- *Specs, comentarios y mensajes en español*: los comentarios del CSS y del módulo, y los textos del
  control («Tema», «Automático», «Claro», «Oscuro»), en español. ✅

Sin desviaciones: no hace falta Complexity Tracking.

**Re-evaluación tras el diseño (Phase 1)**: sin cambios. El diseño no añade dependencias, no toca la
base de datos ni el formato de configuración, no cambia la CSP ni las cabeceras de seguridad, no
abre ninguna ruta que lea o escriba datos y deja el modo claro idéntico. La única superficie nueva
expuesta sin sesión es `POST /admin/theme`, que exige token CSRF, valida tres valores con Zod, no
consulta la base de datos y solo escribe una cookie sin valor de autorización. ✅

## Project Structure

### Documentation (this feature)

```text
specs/014-dark-mode-panel/
├── plan.md              # Este fichero
├── research.md           # Phase 0: decisiones R1–R11
├── data-model.md         # Phase 1: tokens, paletas, contrastes, estados de la preferencia
├── quickstart.md          # Phase 1: validación de punta a punta (y en producción)
├── contracts/
│   ├── admin-theme.md     # POST /admin/theme, cookie kb_theme, data-theme, control
│   └── panel-theme-css.md # contrato del CSS: tokens, bloques de mapeo, zonas fijas
├── checklists/
│   └── requirements.md    # calidad de la spec
└── tasks.md               # Phase 2 (/speckit-tasks; no lo crea este comando)
```

### Source Code (repository root)

```text
src/
├── admin/
│   ├── theme.ts                      # NUEVO — puro: leer/escribir kb_theme, atributo, destino seguro
│   ├── render.ts                     # + layout.theme en renderPage
│   ├── routes/theme.ts               # NUEVO — POST /admin/theme (204 htmx / 303 normal)
│   ├── auth/routes.ts                # la pantalla de acceso recibe el tema
│   └── views/
│       ├── layout.eta                # <html data-theme> + control en la barra superior
│       ├── login.eta                 # <html data-theme> + control
│       ├── partials/theme-switch.eta # NUEVO — las tres opciones, con CSRF y `next`
│       ├── app.css                   # paletas, 4 bloques de mapeo, 13 literales → tokens,
│       │                             #   color-scheme, foco visible, @media print
│       └── app.js                    # aplicar el tema al instante, sin recargar
└── app.ts                            # registra routes/theme en /admin, fuera del ámbito de operador

tests/
├── unit/admin/
│   ├── theme.test.ts                 # NUEVO — cookie, Set-Cookie, atributo, destino validado
│   └── theme-css.test.ts             # NUEVO — tokens de los 4 bloques, literales, contrastes
├── contract/admin/
│   ├── theme.test.ts                 # NUEVO — data-theme, control, POST (CSRF, htmx, 303, 422)
│   └── chat-design.test.ts           # (amplía) la vista previa no cambia con el tema del panel
└── (sin cambios en integration: no hay base de datos implicada)
```

**Structure Decision**: monolito modular existente, sin módulo de dominio nuevo. El tema es asunto
del panel y se queda entero en `src/admin`: un módulo puro para la cookie, una ruta que la pone, una
parcial para el control y el CSS. `src/app.ts` solo gana la línea de registro de la ruta. No se crea
`src/theme/` ni nada en el dominio, porque nada fuera del panel necesita conocer el tema.

## Complexity Tracking

No aplica: el Constitution Check no tiene desviaciones.
