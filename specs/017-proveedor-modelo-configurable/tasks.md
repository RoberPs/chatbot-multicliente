---

description: "Lista de tareas de la feature 017: proveedor del modelo configurable por instancia"
---

# Tasks: Proveedor del modelo configurable por instancia

**Input**: documentos de diseño de `/specs/017-proveedor-modelo-configurable/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md) (R1–R16),
[data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

**Ámbito**: núcleo (afecta a todas las instancias).

**Tests**: sí. La spec los exige por escrito (FR-038, SC-002, SC-011) y la constitución los exige
para los Principios IV y V antes de cerrar cualquier feature que afecte a la conversación. Se
necesitan `unit`, `contract` e `integration` (Testcontainers) **y** `eval`, esta última
**obligatoria y por proveedor** (FR-035). Dentro de cada fase, **los tests se escriben primero y
deben fallar antes de implementar**.

**Organización**: por historia de usuario, en orden de prioridad: US1 y US2 (P1), US3 y US4 (P2),
US5 (P3). Lo que comparten todas —la costura del proveedor y la forma del consumo— va en la fase 2,
que las bloquea.

## Formato: `[ID] [P?] [Story] Descripción`

- **[P]**: se puede hacer en paralelo (ficheros distintos, sin dependencias pendientes)
- **[Story]**: historia a la que pertenece (US1…US5)
- Cada tarea indica la ruta exacta del fichero

## Convenciones del proyecto que afectan a todas las tareas

- Specs, comentarios, mensajes y textos, en español.
- **En `src/` no puede haber nombres ni lógica de sector o cliente.** Un proveedor de modelo no es
  un sector, pero el nombre de su variable de credencial **solo** puede aparecer en `src/llm/`
  (FR-006, SC-008), y eso lo vigila una prueba estática (T073).
- **Una sola migración** (`0009_unmeasured_usage.sql`), con dos partes: una columna nueva, y la
  **única excepción de la feature** a la convención de solo añadir —quitar el `NOT NULL` de las dos
  columnas de caché, sin lo cual FR-024 no se puede cumplir—. Relaja, no reescribe: ninguna
  migración publicada se edita, ninguna fila se toca y ningún dato se pierde (R11,
  [data-model.md](data-model.md) §2). **`formatVersion` de `src/config-transfer/format.ts` NO sube**
  y no hay actualizador nuevo: `model_usage` es registro de consumo, no configuración del negocio
  (FR-037).
- **Variables de entorno nuevas**: `LLM_PROVIDER`, `GEMINI_API_KEY`, `OPENAI_API_KEY`. Los entornos
  de las dos instancias desplegadas **no se tocan**: sin `LLM_PROVIDER` equivale a `anthropic`
  (FR-003), y `ANTHROPIC_API_KEY` conserva su nombre.
- **Ninguna credencial, ni entera ni parcial, en ningún mensaje, registro o salida** (FR-032,
  SC-004).
- Ningún test hace red ni lee una credencial real (FR-038). Las credenciales reales solo se usan en
  `pnpm test:eval` y en los recorridos a mano del quickstart.
- Se despliega como **0.1.3**.

---

## Tramos de ejecución (parada por límite de consumo)

La implementación se parte en **dos tramos**, con una parada entre medias. No se llaman «fases»
para no confundirlos con las 9 fases internas de esta lista: un tramo agrupa varias fases.

| | Fases | Tareas | Cuántas |
|---|---|---|---|
| **Tramo 1** | 1 · Setup, 2 · Foundational, 3 · US1 | T001 – T043a | **51** |
| **Tramo 2** | 4 · US2 … 9 · Despliegue | T043b – T086 | **45** |

### Por qué el corte va al final de US1

- Es la **frontera del MVP** que ya define el plan: al terminar, una instancia elige proveedor en su
  fichero de entorno y el bot atiende clientes con los tres, derivación incluida.
- El repositorio queda **coherente y verificable por sí mismo**: suite entera en verde, sin nada a
  medio construir, y con el punto de control de refactor puro (T024) ya pasado por dentro del tramo.
- Es el único corte que no parte un puerto, un dialecto ni una migración por la mitad.

### Qué NO está hecho al parar, y por qué no pasa nada

| Pendiente | Consecuencia de parar ahí |
|---|---|
| El agujero de la credencial equivocada (US2) | Sigue abierto, **pero hoy ya lo está**: no hay regresión, solo trabajo pendiente |
| El panel no sabe pintar «sin dato» (US3) | Solo se ve si alguien configura Gemini u OpenAI **en local**. Por eso T043a deja el entorno de desarrollo en Anthropic |
| La evaluación por proveedor (US5) | **Ningún proveedor está declarado apto todavía.** Nada en el repositorio puede afirmar lo contrario: `README.md` y la documentación son tramo 2 |
| El despliegue (fase 9) | Nada se despliega. Producción sigue en 0.1.2 y con Anthropic, sin tocar sus entornos |

**Durante el tramo 1 no se sube la versión ni se toca `README.md`**: las dos cosas son tramo 2
(T078, T079), precisamente para que un repositorio parado a medias no anuncie algo que no ofrece.

---

## Phase 1: Setup

**Purpose**: dependencias y sitio para los dobles.

- [X] T001 Comprobar el emisor del certificado de `registry.npmjs.org` antes de instalar nada, con el comando de [quickstart.md](quickstart.md) §0; si el emisor es Avast, pedir al usuario que desactive su análisis HTTPS antes de seguir
- [X] T002 Añadir `openai` y `@google/genai` a `package.json` con versión fijada (sin rango) y actualizar `pnpm-lock.yaml` (R16)
- [X] T003 [P] Crear `tests/fixtures/llm/` con el README corto que explique que los dobles reproducen la forma **real** de cada API y por qué eso importa (R13)

---

## Phase 2: Foundational (prerequisitos que bloquean todas las historias)

**Purpose**: la costura única y la forma del consumo. **Al terminar esta fase, nada de lo
observable puede haber cambiado para una instancia de Anthropic** —mismas respuestas, mismos
números en el panel, mismos avisos, mismo veredicto de `instance:check`— y la suite entera tiene
que seguir en verde. Por dentro el código cambia bastante; por fuera, nadie nota nada.

Eso es posible porque los estados nuevos —`null` en un concepto de caché y las llamadas no
medidas— **solo son alcanzables con los proveedores que todavía no existen**. Es el punto de
control más valioso de la feature: es el único momento en que la suite actual sirve de juez, porque
describe el comportamiento de hoy. En cuanto haya tres adaptadores, un fallo ya no distingue entre
«lo rompió el refactor» y «lo rompió el adaptador nuevo».

**⚠️ CRÍTICO**: ninguna historia puede empezar antes de que esta fase esté completa.

### La costura (R1)

- [X] T004 Crear `src/llm/provider.ts` con el tipo cerrado `LlmProvider`, la lista `LLM_PROVIDERS` y la tabla `ProviderDescriptor` (variable de credencial y si `LLM_MODEL` es obligatoria), según [contracts/llm-provider.md](contracts/llm-provider.md) §1
- [X] T005 [P] Escribir en `tests/unit/llm/provider.test.ts` los tests del clasificador `classifyKeyShape`: `sk-ant-` → anthropic, `sk-proj-` y `sk-` → openai, `AIza` y `AQ.` → gemini, forma desconocida → `null`, **y el caso de orden** que comprueba que una clave `sk-ant-…` no se clasifica como openai (R3)
- [X] T006 Implementar `classifyKeyShape` en `src/llm/provider.ts` con una única tabla de patrones, evaluando `sk-ant-` **antes** de `sk-`, y devolviendo `null` ante cualquier forma que no reconozca (FR-028, R3, regla C4)
- [X] T007 Crear `src/llm/reply-schema.ts` moviendo `replyJsonSchema()` desde `src/llm/anthropic-chat-model.ts`, con el dialecto `anthropic` idéntico al actual (limpieza de `$schema`, `maxLength`, `minLength`, `default`)
- [X] T008 [P] Añadir en `tests/unit/llm/reply-schema.test.ts` un test de regresión que fije que el dialecto `anthropic` produce **exactamente** el mismo esquema que hoy
- [X] T009 Añadir a `src/llm/provider.ts` las fábricas `createChatModel(provider, opts)` y `createSummarizer(provider, opts)`, de momento solo con `anthropic`, devolviendo los adaptadores que ya existen (FR-013)

### Entorno (R2)

- [X] T010 Añadir a `src/config/env.ts` el esquema de `LLM_PROVIDER` (los tres valores; ausente ⇒ `anthropic`), las variables `GEMINI_API_KEY` y `OPENAI_API_KEY`, y la regla de que `LLM_MODEL` es obligatoria salvo con `anthropic`, que conserva su valor por defecto (FR-001, FR-003)
- [X] T011 Cambiar en `src/config/env.ts` las reglas que hoy exigen `ANTHROPIC_API_KEY` (el canal de WhatsApp y `EMERGENCY_CONTACT_PHONE`) para que exijan **la credencial del proveedor declarado**, nombrando su variable (FR-005)
- [X] T012 [P] Añadir en `tests/unit/config/env.test.ts` los tests de: entorno sin `LLM_PROVIDER` que sigue funcionando igual (FR-003), proveedor no elegible con mensaje que nombra los tres (FR-002), credencial del proveedor declarado ausente aunque haya otra presente (FR-004, FR-005), y `LLM_MODEL` ausente con proveedor distinto de `anthropic`
- [X] T013 Cambiar `src/config/secret-rules.ts` para que las reglas de calidad se apliquen a la variable de credencial del **proveedor declarado**, cualquiera que sea su nombre (FR-011)
- [X] T014 Cambiar `src/provisioning/fingerprint.ts` para que las tres variables de credencial se huellen con la misma clase, de modo que la reutilización del mismo secreto entre instancias se detecte aunque cada una declare un proveedor distinto (FR-012)
- [X] T015 [P] Añadir en `tests/unit/provisioning/fingerprint.test.ts` el test de dos instancias con proveedores distintos y la misma credencial, que debe seguir detectándose como secreto reutilizado

### La forma del consumo (R11)

- [X] T016 Cambiar `TokenUsage` en `src/conversation/ports.ts` para que `cacheWrite` y `cacheRead` admitan `null` («el proveedor no informa del concepto»), distinto de `0` («cero medido»), según [data-model.md](data-model.md) §1. **El `null` sale de la tabla de capacidades del proveedor, NO de un campo ausente en una respuesta**: el adaptador de Anthropic hace hoy `?? 0` y **debe seguir haciéndolo**, porque Anthropic sí informa del concepto y una respuesta que no escribió caché es un cero medido
- [X] T017 Cambiar `addTokenUsage` en `src/conversation/responder.ts` para que sume tratando `null` como «sin dato» y no como cero: `null + null = null`, `null + n = n` con el concepto marcado como parcialmente medido
- [X] T018 Añadir `unmeasuredCalls` a `ResponseUsage` en `src/usage/types.ts`, precisando que `calls` son las llamadas **con respuesta** y manteniendo la invariante `unmeasuredCalls <= calls`
- [X] T019 Cambiar el acumulador de `src/conversation/responder.ts` para que cuente en `calls` toda llamada con respuesta, cuente en `unmeasuredCalls` las que no informaron tokens, y **escriba registro de consumo siempre que haya habido respuesta**, aunque ninguna llamada informara nada (FR-025)
- [X] T020 Quitar de `src/llm/token-usage.ts` el importe de tipos del SDK de Anthropic: pasa a recibir un `TokenUsage` ya normalizado, y la extracción de campos se va a cada adaptador (FR-022, FR-023)
- [X] T021 Crear `src/db/migrations/0009_unmeasured_usage.sql` con las **dos** partes de [data-model.md](data-model.md) §2: añadir `unmeasured_calls smallint not null default 0` con `CHECK (unmeasured_calls >= 0 AND unmeasured_calls <= calls)`, y quitar el `NOT NULL` de `cache_write_tokens` y `cache_read_tokens`. Regenerar el snapshot de drizzle-kit y reflejar la nulabilidad en `src/db/schema.ts` (FR-024, FR-025b)
- [X] T021a Dejar escrito en el comentario de cabecera de la migración **por qué** se relaja el `NOT NULL`: sin eso, «no informado» y «cero medido» son indistinguibles y FR-024 no se puede cumplir. Es la única excepción de la feature a la convención de solo añadir, no reescribe nada y no pierde ningún dato. **No** se toca el `CHECK` de tokens existente: con el valor nulo la expresión da nulo y un `CHECK` acepta todo lo que no sea falso
- [X] T022 Cambiar la sentencia de inserción de `src/usage/meter.ts` para escribir `unmeasured_calls` y para persistir `NULL` en las columnas de caché cuando el proveedor no informe del concepto
- [X] T022a En esa misma sentencia, hacer que el cálculo del coste trate el nulo como cero (`coalesce(…, 0)`) **a la vez** que persiste el `NULL` en la columna del token. Si no se hace, la suma del coste da `NULL`, `cost_pico` queda nulo con `currency` no nulo, se viola `model_usage_cost_currency`, la inserción falla y el medidor —que nunca lanza— se come el error: **se perdería todo el registro de consumo de Gemini y OpenAI en silencio**
- [X] T022b [P] Añadir en `tests/integration/usage/cache-null.test.ts` el test de que una respuesta de un proveedor que no informa de la escritura de caché deja `NULL` en esa columna **y** un `cost_pico` no nulo con su moneda
- [X] T023 [P] Añadir en `tests/integration/usage/unmeasured.test.ts` el test de que una respuesta sin información de consumo deja una fila con `calls >= 1`, `unmeasured_calls >= 1` y tokens a 0, **distinguible** de una fila de consumo cero medido (SC-005)
- [X] T024 **Punto de control.** Ejecutar `pnpm lint && pnpm typecheck && pnpm test` y mirar el resultado **antes de escribir una sola línea de Gemini o de OpenAI**. Lo exigible: la suite entera en verde y **nada observable cambiado para una instancia de Anthropic**. Lo que sí cambia a propósito en esta fase —que se registre consumo aunque una llamada no informe tokens (T019), y que los conceptos de caché puedan ser nulos (T016, T021)— **no es alcanzable con Anthropic**, que informa de los cuatro conceptos, así que no debe producir ninguna diferencia visible. Si la produce, está mal

**Checkpoint**: la costura existe, el consumo sabe distinguir «sin dato» de cero, y nada ha cambiado de comportamiento. Las historias pueden empezar.

---

## Phase 3: User Story 1 - Dar de alta una instancia con el proveedor elegido (Priority: P1) 🎯 MVP

**Goal**: una instancia atiende clientes con cualquiera de los tres proveedores cambiando solo su
fichero de entorno, y nada revela quién hay detrás.

**Independent Test**: levantar una instancia con cada valor de `LLM_PROVIDER` y mantener una
conversación completa por el chat web: mismo dato registrado, misma falta de dato reconocida, misma
derivación a una persona, y ninguna pantalla del panel nombrando al proveedor
([quickstart.md](quickstart.md) §2).

### Tests de US1 ⚠️ primero, y deben fallar

- [X] T025 [P] [US1] Crear el doble de Gemini en `tests/fixtures/llm/gemini-double.ts`, con la forma real de su respuesta: `usageMetadata` con `promptTokenCount`, `candidatesTokenCount`, `thoughtsTokenCount` y `cachedContentTokenCount`, y sus señales de bloqueo por seguridad
- [X] T026 [P] [US1] Crear el doble de OpenAI en `tests/fixtures/llm/openai-double.ts`, con la forma real: `usage` con `input_tokens`, `output_tokens`, `input_tokens_details.cached_tokens` y `output_tokens_details.reasoning_tokens`, y **un rechazo como elemento de contenido con el estado en `completed`** (R10)
- [X] T027 [P] [US1] Crear el doble de Anthropic en `tests/fixtures/llm/anthropic-double.ts` extrayendo lo que ya usan los tests actuales, para que los tres compartan forma de uso
- [X] T028 [P] [US1] Escribir en `tests/unit/llm/reply-schema.test.ts` los tests de los dialectos `gemini` y `openai`, y en particular que el dialecto `openai` promueve **todo** opcional a requerido admitiendo `null` y pone `additionalProperties: false` en cada objeto (R7)
- [X] T029 [P] [US1] Escribir en `tests/unit/llm/chat-model.test.ts` la batería **común a los tres proveedores**: respuesta válida, respuesta que no es JSON, respuesta que no valida con Zod, rechazo, plazo agotado y fallo del proveedor, comprobando que cada caso produce la causa del dominio que fija [contracts/llm-provider.md](contracts/llm-provider.md) §3.3 (FR-014, FR-015, FR-016)
- [X] T029a [P] [US1] Añadir en `tests/unit/llm/chat-model.test.ts` el test de que, en los tres proveedores, **abortar la señal del dominio corta la petición** y produce `timeout`, y que el adaptador **no reintenta por su cuenta**: una petición fallida deja exactamente el número de intentos que el dominio espera (FR-020)
- [X] T030 [P] [US1] Escribir en `tests/unit/llm/token-usage.test.ts` los tests de extracción de consumo por proveedor, incluido **que en Gemini `thoughtsTokenCount` se suma a los tokens de salida** y que en Anthropic y OpenAI **no** se suma dos veces (R11, FR-022, FR-023)
- [X] T030a [P] [US1] Añadir en `tests/unit/llm/token-usage.test.ts` el test de la regla que más fácil es romper: una respuesta de **Anthropic** sin escritura de caché —campo ausente— registra **`0`**, no `null`, y por tanto el panel no dirá «sin dato» de un proveedor que sí informa. Y la contraria: **Gemini** registra `null` en ese concepto **siempre**, también cuando sí hubo lectura de caché (FR-024). **Corregido respecto a R11**: OpenAI 7.32.0 **sí** informa de la escritura de caché (`input_tokens_details.cache_write_tokens`), así que registra un número, no `null`
- [X] T031 [P] [US1] Escribir en `tests/integration/handoff/summarizer-providers.test.ts` el test de que el resumen de derivación funciona con los tres proveedores (FR-013a)

### Implementación de US1

- [X] T032 [US1] Añadir a `src/llm/reply-schema.ts` el dialecto `gemini` (misma limpieza que anthropic) y el dialecto `openai` (limpieza más promoción de opcionales a requeridos admitiendo `null`, más `additionalProperties: false`)
- [X] T033 [US1] Crear `src/llm/gemini-chat-model.ts`: esquema en `generationConfig.responseFormat.text`, esfuerzo como nivel de razonamiento, extracción de consumo con la suma de los tokens de razonamiento, y traducción de sus bloqueos de seguridad a `refusal` (R7, R8, R10, R11)
- [X] T034 [US1] Crear `src/llm/openai-chat-model.ts`: esquema en `text.format` con modo estricto, esfuerzo como esfuerzo de razonamiento, **normalización de los `null` recibidos a «ausente»** antes de pasar el objeto a Zod para que los valores por defecto del dominio se apliquen igual, y detección del rechazo **por el tipo del elemento de contenido, no por el estado** (R7, R10)
- [X] T034a [US1] En los **tres** adaptadores de conversación, dejar el plazo y los reintentos **en términos del dominio** (FR-020): propagar la señal de aborto que recibe `reply`, fijar el plazo por petición, y **desactivar la política de reintentos propia del SDK**. Es la garantía de que los dos intentos del responder siguen compartiendo un único presupuesto; un SDK que reintente por su cuenta la rompe sin que se note
- [X] T034b [US1] En los **tres** adaptadores, fijar el comportamiento de caché de contexto (FR-019, R9): conservar la marca explícita en Anthropic y **no marcar nada** en Gemini ni en OpenAI, que usan su caché automática. Dejar en el comentario el motivo de R9 —la caché explícita de Gemini tendría vida propia en el proveedor y se desincronizaría de la información del negocio, que se lee sin caché en cada respuesta— para que nadie la añada de buena fe
- [X] T035 [US1] Implementar en `src/llm/openai-chat-model.ts` la degradación declarada del esfuerzo: si el proveedor rechaza el parámetro por no admitirlo, dejar **una** línea en el registro, reintentar **una** vez sin él y recordar la decisión para el resto de la vida del proceso (FR-017, R8)
- [X] T036 [P] [US1] Crear `src/llm/gemini-summarizer.ts` con el puerto `HandoffSummarizer` y su esquema de un solo campo obligatorio (R12)
- [X] T037 [P] [US1] Crear `src/llm/openai-summarizer.ts` con el puerto `HandoffSummarizer`; su esquema no sufre el problema del modo estricto porque su único campo es obligatorio (R12)
- [X] T038 [US1] Completar las fábricas de `src/llm/provider.ts` con los tres proveedores en los **dos** puertos, y hacer que un proveedor no elegible falle antes de construir nada, con los tres nombres en el mensaje (regla C5)
- [X] T039 [US1] Cambiar `src/bot.ts` para construir los dos puertos por fábrica con el proveedor declarado, y ajustar el aviso de arranque que hoy nombra `ANTHROPIC_API_KEY` para que nombre la variable del proveedor declarado
- [X] T040 [US1] Cambiar `src/cli/bot-chat.ts` para que `pnpm bot:chat` funcione con cualquier proveedor
- [X] T041 [P] [US1] Quitar el nombre de la variable de Anthropic de `src/webchat/availability.ts` y `src/channels/web/api.ts`, sustituyéndolo por el predicado genérico «hay credencial del modelo configurada»
- [X] T042 [P] [US1] Quitar el nombre de la variable de Anthropic de `src/admin/fastify-types.ts`, `src/admin/routes/playground.ts`, `src/admin/routes/web-chat.ts` y `src/admin/views/playground.eta` (FR-008)
- [X] T043 [P] [US1] Añadir en `tests/contract/admin/no-provider-leak.test.ts` el test de que ninguna pantalla del panel ni la información de estado publicada por red nombran al proveedor (FR-007, FR-008, SC-006)

**Checkpoint**: US1 completa. El bot responde con los tres proveedores, deriva con los tres, y el panel no delata a ninguno.

### Cierre del tramo 1 🛑 PARADA

- [ ] T043a **Dejar el repositorio en estado reanudable y parar.** Concretamente: (a) `pnpm lint && pnpm typecheck && pnpm test` en verde, y **contar al usuario el resultado real**, sin redondear; (b) árbol limpio, todo commiteado, **sin subir nada a `origin`**; (c) `.env` de desarrollo con el proveedor en Anthropic, para que el panel no se encuentre con un «sin dato» que todavía no sabe pintar; (d) comprobar que `package.json` sigue en **0.1.2** y que `README.md` **no** se ha tocado, porque ningún proveedor está declarado apto aún; (e) anotar al usuario en qué tarea se paró y cuál es la primera del tramo 2

---

## Phase 4: User Story 2 - La comprobación previa descubre una credencial que no corresponde (Priority: P1)

### Reanudación del tramo 2

- [X] T043b **Antes de seguir**, comprobar que el punto de parada sigue en pie: rama `017-proveedor-modelo-configurable`, árbol limpio, `pnpm test` en verde y la migración 0009 aplicada en la base de datos local. Si algo cambió desde la parada, entenderlo antes de escribir código nuevo

**Goal**: una credencial que no corresponde al proveedor declarado se detecta antes de desplegar; y
una credencial que el proveedor rechaza degrada la instancia en vez de fallar en silencio.

**Independent Test**: pasar la comprobación sobre entornos preparados con credenciales cruzadas y
comprobar que el resultado es no apto con el mensaje correcto y sin mostrar el valor; y arrancar una
instancia con una credencial rechazada y comprobar que arranca degradada, avisa y se recupera sola
([quickstart.md](quickstart.md) §3 y §4).

### Tests de US2 ⚠️ primero, y deben fallar

- [X] T044 [P] [US2] Escribir en `tests/unit/provisioning/secrets.test.ts` los tests de severidad: credencial de otro proveedor elegible → `llm_key_other_provider` como **error**; forma no reconocida → `llm_key_format` como **aviso**; y la **regresión del fallo actual**, que hoy deja pasar una credencial de otro proveedor con un simple aviso (SC-003)
- [X] T045 [P] [US2] Escribir en `tests/unit/provisioning/check.test.ts` los tests de la tabla de decisión completa de [contracts/credential-verification.md](contracts/credential-verification.md) §4, incluido que `llm_key_unverified` («no se pudo comprobar») es **distinguible** de no haber pedido la validación (FR-028, FR-030, FR-030a)
- [X] T045a [P] [US2] Añadir en `tests/unit/provisioning/check.test.ts` la aserción de que **ni la comprobación ni la validación opcional escriben nada**, ni en el entorno ni en el inventario (FR-034). Esta feature añade a una herramienta local justo lo que podría tentar a escribir —una llamada de red cuyo veredicto se podría guardar en disco—, así que el test tiene que existir antes que la bandera
- [X] T046 [P] [US2] Escribir en `tests/unit/llm/credential-probe.test.ts` los tests de clasificación del veredicto: 2xx → `accepted`, 401 y 403 → `rejected`, 5xx, fallo de red y plazo agotado → `inconclusive`
- [X] T047 [P] [US2] Escribir en `tests/integration/llm/credential-degraded.test.ts` el test del ciclo completo: credencial rechazada al arrancar → arranca, queda degradada, aviso crítico, y al pasar a aceptada sale del degradado sola, con **una** línea de registro al entrar y **una** al salir (SC-010)
- [X] T048 [P] [US2] Escribir el test de que ningún mensaje de la comprobación ni del registro contiene ningún carácter de ninguna credencial (FR-032, SC-004)

### Implementación de US2

- [X] T049 [US2] Añadir a `src/provisioning/messages.ts` los códigos y textos de `llm_key_other_provider`, `llm_key_unused`, `llm_key_rejected` y `llm_key_unverified`, con mensaje, detalle y acción, sin mostrar valores
- [X] T050 [US2] Cambiar `src/provisioning/secrets.ts` para usar `classifyKeyShape`: emitir `llm_key_other_provider` como **`'error'`** cuando la credencial encaja con otro proveedor elegible, y dejar `llm_key_format` como aviso para la forma no reconocida (R4)
- [X] T051 [US2] Cambiar `src/provisioning/check.ts` para contemplar las tres variables de credencial en lugar de solo `ANTHROPIC_API_KEY`, y emitir `llm_key_unused` por cada credencial de otro proveedor elegible presente y sin usar (FR-033)
- [X] T052 [US2] Crear `src/llm/credential-probe.ts` con `verifyCredential(provider, apiKey, opts)`, la petición `GET` al listado de modelos de cada proveedor, las cabeceras propias de cada uno, plazo de 5 s, y la clasificación de [contracts/credential-verification.md](contracts/credential-verification.md) §1 (FR-031: la petición más barata que el proveedor admita, sin generar tokens)
- [X] T053 [US2] **Comprobación manual, una sola vez, con red**: verificar proveedor a proveedor que una credencial inválida devuelve 401 o 403, y anotar el resultado en [research.md](research.md) R5. **Si algún proveedor devolviera 2xx sin credencial válida**, usar para él la petición de generación más pequeña posible y anotar su coste. No es un test: la clasificación del veredicto ya la fija T046 con dobles, sin red ni credenciales (FR-038)
- [X] T054 [US2] Añadir la bandera `--validar-credencial` a `pnpm instance:check` en `src/cli/instance.ts` y `src/provisioning/check.ts`, **opt-in**: sin ella la comprobación sigue siendo local y sin red (FR-029, SC-009)
- [X] T055 [US2] Añadir a `src/llm/credential-probe.ts` el vigilante de dos estados con la forma de `src/db/outage.ts`: reintento cada 5 min mientras la credencial esté rechazada, una línea al entrar en degradado y una al salir, nunca una por petición (R6)
- [X] T056 [US2] Añadir a `src/usage/protection.ts` el estado de credencial rechazada, que degrada a «solo contacto del negocio» por el mismo camino que el modelo sin precio, y su aviso **crítico** en `computeWarnings` (FR-005b)
- [X] T057 [US2] Lanzar la comprobación del arranque desde `src/bot.ts` **sin bloquear**: `rejected` → degradado; `inconclusive` → arranca normal con una línea de registro; nunca fatal, nunca bucle de reinicio (FR-005a, FR-005c)
- [X] T058 [US2] Cambiar `src/provisioning/generate.ts` para que `pnpm instance:new` acepte el proveedor y emita la variable de credencial correspondiente en el entorno generado (FR-010)
- [X] T059 [US2] Registrar el proveedor declarado de cada instancia en el inventario (`src/provisioning/inventory.ts` y las órdenes que lo leen), **sin** registrar ninguna credencial (FR-009)

**Checkpoint**: US2 completa. El agujero está cerrado por los dos lados: antes de desplegar y en el arranque.

---

## Phase 5: User Story 3 - El consumo y el tope de gasto siguen midiendo (Priority: P2)

**Goal**: el operador ve el consumo con cualquier proveedor, y lo que el proveedor no informa se
dice en lugar de darse por cero.

**Independent Test**: con los dobles, comprobar qué queda registrado y qué avisos salen; y en el
panel, que «sin dato» no se parece a un cero ([quickstart.md](quickstart.md) §5).

### Tests de US3 ⚠️ primero, y deben fallar

- [X] T060 [P] [US3] Escribir en `tests/unit/usage/summary.test.ts` los tests de los tres estados por concepto —informado, no informado y parcialmente informado— y de que los totales **no** suman lo no informado como cero (FR-024, SC-012)
- [X] T061 [P] [US3] Escribir en `tests/unit/usage/protection.test.ts` los tests de severidad del aviso de consumo no medido: **crítico** con el tope activado y el negocio activo, normal en los demás casos, y **que nunca revierte ninguna escritura del operador** (FR-025a)
- [X] T062 [P] [US3] Escribir en `tests/contract/admin/usage-no-data.test.ts` el test de que la pantalla de consumo muestra «sin dato» y no `0`, con una nota que **no** nombra al proveedor

### Implementación de US3

- [X] T063 [US3] Cambiar `src/usage/summary.ts` para agregar `unmeasured_calls` y decidir por periodo si cada concepto de caché está informado, no informado o parcialmente informado, deduciéndolo de lo registrado y **no** del nombre del proveedor (R15)
- [X] T064 [US3] Añadir a `src/usage/protection.ts` el aviso de consumo no medido con la severidad de FR-025a, calculado con `computeWarnings` y nunca guardado
- [X] T065 [US3] Cambiar `src/admin/views/usage.eta` para mostrar «sin dato» distinguible del cero, con la nota genérica, el recuento de respuestas no medidas, y los totales que incluyen un hueco marcados como incompletos
- [X] T066 [US3] Comprobar que el aviso de «modelo sin precio» y su degradación a solo contacto del negocio siguen funcionando igual al cambiar de proveedor, sin recalcular el histórico (FR-026, FR-027)

**Checkpoint**: US3 completa. El tope de gasto protege lo que puede y el operador sabe cuándo la suma es incompleta.

---

## Phase 6: User Story 4 - Las diferencias entre proveedores están declaradas (Priority: P2)

**Goal**: cada diferencia entre proveedores está escrita y tiene prueba, en lugar de aparecer como
un comportamiento raro.

**Independent Test**: para cada fila de la tabla de capacidades y cada proveedor, existe una prueba
que fija el comportamiento declarado.

- [X] T067 [US4] Escribir la tabla de capacidades por proveedor en `docs/operacion-multicliente.md`, con las siete filas de [data-model.md](data-model.md) §1 y qué se conserva, qué se traduce y qué se degrada (FR-021)
- [X] T068 [P] [US4] Añadir en `tests/unit/llm/capabilities.test.ts` una prueba por fila de esa tabla y por proveedor, de modo que la documentación y el código no puedan separarse
- [X] T069 [US4] Comprobar que la degradación declarada del esfuerzo deja constancia en el arranque en los tres proveedores, y que el valor no se rechaza ni se silencia, y que el razonamiento interno se usa donde existe y se prescinde de él donde no, sin que eso cambie la forma de la respuesta (FR-017, FR-018)

**Checkpoint**: US4 completa. Nada de lo que varía entre proveedores está sin escribir.

---

## Phase 7: User Story 5 - Ningún proveedor elegible sin evaluación (Priority: P3)

**Goal**: ningún proveedor queda disponible para los clientes sin haber pasado la evaluación con el
modelo real.

**Independent Test**: existe un resultado de evaluación anotado por cada proveedor elegible, con su
modelo, su esfuerzo y su fecha.

- [X] T070 [US5] Parametrizar `pnpm test:eval` por `LLM_PROVIDER` y `LLM_MODEL` para poder correrla por proveedor sin tocar código (R14)
- [X] T071 [US5] Correr la evaluación **una vez por proveedor** con el esfuerzo por defecto y anotar en `docs/operacion-multicliente.md` proveedor, modelo, esfuerzo, fecha y veredicto (SC-007). **Cuesta dinero y está fuera de `pnpm test` a propósito**
- [X] T072 [US5] Para cada proveedor que no alcance el criterio: darle un `LLM_EFFORT` por defecto propio, razonado y escrito, y **reevaluar**. Si tras el ajuste sigue sin alcanzarlo, **no declararlo elegible** en esta versión y escribir por qué (FR-036, FR-036a)

**Checkpoint**: US5 completa. Lo que se ofrece está medido.

---

## Phase 8: Polish y asuntos transversales

- [X] T073 Añadir la prueba estática en `tests/unit/llm/seam.test.ts` que recorre `src/`, excluye `src/llm/`, y falla si encuentra el nombre de una variable de credencial de proveedor o un importe de un SDK de proveedor (reglas C1 y C2, SC-008)
- [X] T074 Migrar los 28 ficheros de `tests/` que nombran `ANTHROPIC_API_KEY` para que usen los dobles y las fábricas, sin perder ninguna cobertura existente
- [X] T075 [P] Actualizar `.env.example` con `LLM_PROVIDER`, las tres variables de credencial y la nueva obligatoriedad de `LLM_MODEL`, con comentarios en español
- [X] T076 [P] Actualizar `docs/operacion-multicliente.md`: la tabla de specs realizadas (§9.1, con su fecha), **la anotación de que la 017 adelanta a P7 con su razón (§9.2)**, la propuesta que cubre marcada como hecha, y las secciones de operación que cambien —alta de instancia, comprobación previa y pantalla de consumo—
- [X] T077 [P] Anotar en `docs/plan-despliegue-produccion.md` §6 que la decisión del 2026-10-12 queda implementada en la 017
- [X] T078 **Avisar al usuario antes** y luego actualizar `README.md` con el estado de la feature 017
- [X] T079 Subir `package.json` a **0.1.3**
- [ ] T080 Recorrer [quickstart.md](quickstart.md) completo, §1 a §6, y anotar el resultado real de cada apartado, sin redondear. El §2 es el que verifica SC-001: una instancia atiende con cualquier proveedor cambiando solo su fichero de entorno
- [ ] T081 Pasar la puerta de calidad entera: `pnpm lint && pnpm typecheck && pnpm test` y la evaluación por proveedor, y **contar al usuario el resultado real** antes de dar la feature por cerrada

---

## Estado real de la puerta de calidad (2026-10-14)

**T043a y T081 siguen SIN MARCAR, y no es un descuido.** Su condición es `pnpm test` entero en
verde, y no lo está. Lo que hay, medido y sin redondear:

| | |
|---|---|
| `pnpm lint` | **limpio** |
| `pnpm typecheck` | **limpio** |
| `pnpm test` | **4 fallos · 3577 pasadas · 3 omitidas** (3584), 292 ficheros, 2 fallidos, 50 min (2026-10-23) |

#### Tres corridas, y lo que dicen juntas

| Fecha | Fallos | Dónde |
|---|---|---|
| 2026-10-14 | 3 | `outage.test.ts` |
| 2026-10-23 (máquina cargada) | 6 | `outage` (3) · `chat-design` (3) · suite caída en `db/tls` |
| 2026-10-23 (máquina limpia) | 4 | `outage` (3) · `handoff/limits` (1) |

**Los 3 de `outage.test.ts` salen siempre.** Son previos: reproducidos en `fcb8d50` y con el cambio
de `protection.ts` revertido.

**Los demás cambian de fichero en cada corrida** y ninguno es una aserción de lógica:
`container not running`, `Test timed out`, `timeout exceeded when trying to connect`. Son el pool de
PostgreSQL y Docker sin recursos. Entre la segunda y la tercera corrida se liberaron **15,2 GB** en
Docker (imágenes y caché de construcción) y desaparecieron los de `chat-design` y `tls`, pero
apareció el de `limits` con 50 transacciones en paralelo.

**Ningún fallo es atribuible a la 017.** Los 3577 que pasan incluyen todo lo de esta feature.

Los 3 fallos están **todos** en `tests/integration/db/outage.test.ts` y **son previos a esta
feature**:

- Se reproducen **idénticos** en `fcb8d50`, el commit con el que se reanudó el tramo 2, y también
  con el cambio de `protection.ts` de la fase 5 revertido. No los ha traído la 017.
- Es **un** fallo con dos en cascada: tras recuperarse la base de datos, un `POST` del chat web
  devuelve **200** («no disponible» con el contacto del negocio) donde el test exige **202**. Al
  fallar ese `expect`, el `startServer()` de la línea siguiente no se ejecuta, así que los dos
  tests posteriores mueren al intentar parar un servidor ya parado.
- El código **falla cerrado y da el contacto**, que es lo que exige el Principio V. La causa raíz
  no está pinchada; la hipótesis es la misma clase que el fallo de saturación ya observado en esta
  máquina: presupuestos de 2 s que con Docker por medio se agotan.
- **No se ha tocado el test de la 016 para que la puerta pase.** Eso sería maquillar el resultado.

La corrida anterior dio 5 fallos. Los otros 2 **sí** eran de esta feature —la columna `PROVEEDOR`
de `instance:list` y los campos nuevos de la fila de consumo rompían aserciones existentes— y están
arreglados en `ecff89d`.

### Pendiente de decidir sobre la BD de desarrollo

`/health` responde `degraded` en local, y no por el código: la BD de desarrollo **aplicó una versión
distinta del fichero `0009_unmeasured_usage.sql`** (se aplicó durante el tramo 1 y después T021a le
añadió el comentario de cabecera). `sameSchema` compara índice, etiqueta **y hash**; los dos
primeros coinciden y el hash no:

```
esperado por el repositorio: 6313029b505498581c57d4d7a4ab7bf1c761f19ad3aa29e21211e88bee8444a1
aplicado en la BD de dev   : 4c4e4c289586bd1ea6dfb32f35739dc1fce658996edd10cbd6f84794abc98b52
```

**El esquema aplicado es el correcto**, verificado columna a columna: `unmeasured_calls smallint NOT
NULL default 0`, su `CHECK (unmeasured_calls >= 0 AND unmeasured_calls <= calls)` y las dos columnas
de caché ya nulables. Lo que cambió entre versiones fue el comentario, no la estructura.

**No afecta a producción**: allí corre la 0.1.2 con 8 migraciones y la 0009 nunca se ha desplegado;
cuando se despliegue, la BD la aplicará desde el fichero actual.

Opciones, **sin decidir** (no se toca la BD del usuario sin que lo pida):

1. Actualizar el hash de esa fila de `drizzle.__drizzle_migrations`. Conserva los datos, es
   reversible y es lo que de verdad pasó. **Recomendada.**
2. Recrear la BD de desarrollo y volver a migrar. Pierde la configuración y los datos de prueba.
3. Dejarlo. El panel y el bot funcionan; `/health` dirá `degraded` y el pie del panel marcará el
   esquema como no coincidente, lo que estorba al recorrer el quickstart (T080).

---

## Phase 9: Despliegue de la 0.1.3

**Purpose**: la feature no está terminada hasta que está en producción y comprobada. Es la fase que
la 016 cubrió con sus T051 y T052.

**Requisitos de acceso**: estas tareas necesitan el VPS y las lanza el usuario. Claude no puede leer
ficheros de entorno de producción, y la sesión de GHCR del VPS se cierra tras cada despliegue.

- [ ] T082 Construir y publicar la imagen 0.1.3 en GHCR. **Antes de construir**, comprobar el emisor del certificado de `registry.npmjs.org`: si es Avast, el `docker build` falla con un error de certificado que no se parece a lo que es
- [ ] T083 Desplegar la 0.1.3 **por tandas** en las dos instancias del VPS (instancia-1 = viajes, instancia-2 = restaurante), comprobando entre tandas que `/health` responde con la versión nueva y que las dos quedan en `Correcto`. Las dos siguen con Anthropic: **ningún entorno de producción se toca**, y eso es precisamente lo que verifica FR-003 en el sitio donde importa
- [ ] T084 Comprobar en producción, con un cliente real por cada canal, que la cadena de respuesta sigue entera: dato registrado, falta de dato reconocida y **derivación a una persona** (Principios IV y V)
- [ ] T085 Comprobar de paso que **la preferencia de tema del panel sobrevive a la actualización**: es la parte del §5 del quickstart de la 014 que no se pudo verificar el mismo día y quedó anotada en su T030
- [ ] T086 Anotar el despliegue en el inventario (`pnpm instance:versions --annotate`) y en `docs/plan-despliegue-produccion.md`, y **contar al usuario el resultado real** de T083 a T085, sin redondear

**Checkpoint**: la 0.1.3 está en producción, las dos instancias en `Correcto`, y el pendiente de la 014 resuelto.

---

## Dependencies y orden de ejecución

### Dependencias entre fases

- **Phase 1 (Setup)**: sin dependencias. T001 **antes** de T002, siempre.
- **Phase 2 (Foundational)**: depende de Setup. **Bloquea todas las historias.** Su punto de control
  (T024) no es opcional: es lo que garantiza que el refactor no cambió nada.
- **Phase 3 (US1)** y **Phase 4 (US2)**: las dos dependen de la fase 2. US2 depende además de T038
  (las fábricas completas), porque la comprobación del arranque necesita saber construir cualquier
  proveedor. **Entre las dos está la parada del tramo 1** (T043a → T043b), y esa dependencia de US2
  sobre US1 es justo lo que hace que el corte ahí no rompa nada.
- **Phase 5 (US3)**: depende de la fase 2 (T016–T023, la forma del consumo) y de US1 para poder
  verla con un proveedor que no informa de la escritura de caché.
- **Phase 6 (US4)**: depende de US1, porque documenta el comportamiento de los tres adaptadores.
- **Phase 7 (US5)**: depende de US1. Es la última porque cuesta dinero y porque un cambio posterior
  en los adaptadores invalidaría su resultado.
- **Phase 8 (Polish)**: T073 y T074 dependen de que US1 y US2 hayan terminado de limpiar. T079,
  T080 y T081 cierran la fase.
- **Phase 9 (Despliegue)**: depende de T081. Nada se despliega sin la puerta de calidad pasada, y
  T082 depende además de la comprobación del certificado de npm. T086 es la última tarea de la
  feature.

### Dentro de cada historia

- Los tests se escriben primero y deben fallar antes de implementar.
- Dialectos del esquema antes de los adaptadores que los usan.
- Adaptadores antes de las fábricas completas.
- Fábricas completas antes de la comprobación del arranque.

### Oportunidades de paralelismo

- **Fase 2**: T005, T008, T012 y T015 son ficheros distintos y van en paralelo. T016–T023 son una
  cadena: `TokenUsage` → `addTokenUsage` → `ResponseUsage` → acumulador → migración → medidor.
- **Fase 3**: los tres dobles (T025, T026, T027) en paralelo; los ficheros de test (T028–T031 y
  T029a) en paralelo; los dos resumidores nuevos (T036, T037) en paralelo; las dos limpiezas (T041,
  T042) en paralelo. Los dos adaptadores de conversación (T033, T034) **no** van en paralelo con
  T032, que es su dependencia, y T034a y T034b tocan los tres adaptadores, así que van después de
  T033 y T034.
- **Fase 4**: los ficheros de test (T044–T048 y T045a) en paralelo. La implementación es
  mayoritariamente secuencial porque T050, T051 y T054 tocan los mismos dos ficheros. T053 es
  manual y con red: no bloquea a ninguna otra tarea.
- **Fase 5**: los tres tests (T060–T062) en paralelo.
- **Fase 8**: T075, T076 y T077 en paralelo; T078 exige avisar antes.

---

## Parallel Example: fase 3 (US1)

```bash
# Los tres dobles, a la vez:
Task: "Doble de Gemini en tests/fixtures/llm/gemini-double.ts"
Task: "Doble de OpenAI en tests/fixtures/llm/openai-double.ts"
Task: "Doble de Anthropic en tests/fixtures/llm/anthropic-double.ts"

# Los tests, a la vez (y deben fallar):
Task: "Dialectos del esquema en tests/unit/llm/reply-schema.test.ts"
Task: "Bateria comun de los tres proveedores en tests/unit/llm/chat-model.test.ts"
Task: "Extraccion de consumo en tests/unit/llm/token-usage.test.ts"
Task: "Resumen de derivacion en tests/integration/handoff/summarizer-providers.test.ts"
```

---

## Implementation Strategy

### Tramo 1 · MVP (US1)

1. Fase 1 (Setup) y fase 2 (Foundational), con su punto de control de refactor puro (T024).
2. Fase 3 (US1).
3. **PARAR Y VALIDAR**: quickstart §1 y §2 con los tres proveedores.
4. Esto ya es entregable: una instancia puede elegir proveedor y atender clientes.
5. **T043a cierra el tramo** y es donde se detiene el proceso por el límite de consumo de la
   cuenta. El tramo 2 arranca en T043b, que comprueba que el punto de parada sigue en pie.

### Entrega incremental

1. Setup + Foundational → la costura existe y nada cambió.
2. US1 → elegir proveedor funciona. **MVP.**
3. US2 → el agujero de la credencial queda cerrado por los dos lados.
4. US3 → el consumo deja de mentir con ceros.
5. US4 → las diferencias quedan escritas y probadas.
6. US5 → se mide lo que se ofrece, y se retira lo que no da la talla.
7. Fase 8 y fase 9 → 0.1.3, documentación, y la feature en producción y comprobada.

### Riesgo de orden que conviene no invertir

**US2 depende de US1**, aunque las dos sean P1. La comprobación del arranque necesita poder
construir cualquier proveedor, así que las fábricas completas (T038) van antes. Y **US5 va al
final** porque cuesta dinero: cualquier cambio en los adaptadores después de evaluar obliga a
evaluar otra vez.

---

## Notes

- `[P]` = ficheros distintos, sin dependencias pendientes.
- La etiqueta `[Story]` traza cada tarea a su historia.
- Confirmar que los tests fallan antes de implementar.
- Hacer commit por tarea o por grupo lógico.
- **No lanzar dos corridas de pruebas a la vez**: la suite levanta su propio PostgreSQL y en máquina
  cargada el test del corte va justo de tiempo. La suite entera tarda unos 32 min.
- **El push a `origin` no se hace en esta feature**: se hace al final del proyecto, y solo
  pidiéndolo.
