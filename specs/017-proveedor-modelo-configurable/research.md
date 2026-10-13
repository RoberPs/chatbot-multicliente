# Investigación: Proveedor del modelo configurable por instancia

**Feature**: `017-proveedor-modelo-configurable` | **Fecha**: 2026-10-13 | **Spec**: [spec.md](spec.md)

Decisiones de la Fase 0. Cada una resuelve una incógnita del contexto técnico del
[plan](plan.md). Las dos asunciones que la spec marcó como riesgo —formas de credencial
distinguibles y petición barata de validación— se resuelven en R3 y R4, y **las dos se confirman
con matices que cambian el diseño**.

## R1 · Dónde va la costura del proveedor

**Decisión**: un módulo nuevo `src/llm/provider.ts` como **punto único**. Expone el tipo
`LlmProvider = 'anthropic' | 'gemini' | 'openai'`, la lista de elegibles, el nombre de la variable
de credencial de cada uno, y dos fábricas: `createChatModel(provider, opts)` y
`createSummarizer(provider, opts)`. Nadie más decide por proveedor.

**Razón**: el puerto `ChatModel` de `src/conversation/ports.ts` ya es la frontera correcta y el
dominio ya consume solo ese puerto. Lo que está filtrado no es la llamada al modelo, es **el nombre
de la variable de credencial** y la construcción del adaptador. Concentrar las dos cosas en un
módulo convierte 15 ficheros tocados en 1, y cumple FR-006 y SC-008 por construcción.

**Alternativas descartadas**:

- *Un registro dinámico de proveedores con autodescubrimiento*: más maquinaria para tres valores
  cerrados en un `enum`. La constitución pide justificar la complejidad añadida.
- *Dejar la decisión en `bot.ts`*: `bot.ts` es el punto de composición, pero la comprobación previa
  (`src/provisioning`) y las reglas de secretos necesitan la misma tabla de variables sin arrancar
  la aplicación. Tiene que vivir en un módulo que los dos puedan importar.

## R2 · Variables de entorno y compatibilidad hacia atrás

**Decisión**:

| Variable | Papel |
|---|---|
| `LLM_PROVIDER` | `anthropic` \| `gemini` \| `openai`. Ausente ⇒ `anthropic` (FR-003) |
| `ANTHROPIC_API_KEY` | Credencial cuando el proveedor es `anthropic` (se conserva el nombre) |
| `GEMINI_API_KEY` | Credencial cuando el proveedor es `gemini` |
| `OPENAI_API_KEY` | Credencial cuando el proveedor es `openai` |
| `LLM_MODEL` | **Obligatoria** salvo con `anthropic`, que conserva su valor por defecto actual |
| `LLM_EFFORT` | Sigue siendo `low` \| `medium` \| `high` del dominio (R7) |

**Razón de conservar `ANTHROPIC_API_KEY`**: los dos entornos en producción ya la tienen, y FR-003
exige que funcionen sin tocarlos. Renombrarla a algo genérico obligaría a editar ficheros de entorno
de producción en el mismo despliegue que cambia el código, que es justo lo que no queremos.

**Razón de hacer `LLM_MODEL` obligatoria fuera de Anthropic**: un valor por defecto para Gemini u
OpenAI envejecería dentro del código y, lo que es peor, un nombre de modelo equivocado se parece
mucho a un fallo del proveedor. Mejor que el entorno lo declare. Con `anthropic` se mantiene el
valor por defecto actual para no romper los entornos existentes.

**Alternativa descartada**: una sola variable `LLM_API_KEY` para los tres. Más limpia sobre el
papel, pero rompe FR-003, y además perdería la detección de secretos reutilizados entre instancias
que hoy se apoya en el nombre de la variable (R12).

## R3 · Formas de credencial: la heurística sirve, pero envejece

**Hallazgo**: las tres tienen prefijos reconocibles, pero con dos trampas comprobadas.

| Proveedor | Prefijos observados |
|---|---|
| Anthropic | `sk-ant-` (el segmento `api03` es la versión de la API, no parte estable del prefijo) |
| OpenAI | `sk-proj-` en las claves nuevas; `sk-` a secas en las antiguas, que siguen siendo válidas |
| Gemini | `AIza` en las clásicas; **`AQ.` en las nuevas de AI Studio** |

**Trampa 1 · `sk-ant-` es un subconjunto de `sk-`.** Una comprobación ingenua de «empieza por
`sk-`» clasificaría una clave de Anthropic como de OpenAI. El orden de evaluación importa: primero
`sk-ant-` → Anthropic; después `sk-` → OpenAI; `AIza` o `AQ.` → Gemini.

**Trampa 2 · Google ha cambiado el prefijo.** Hay informes de que AI Studio ya solo emite claves
`AQ.` y de que esas claves fallan contra algún extremo REST clásico. El dato viene de un foro de
desarrolladores de Google, no de la documentación, así que se trata como **probable, no firme**.

**Decisión**: la comprobación de forma es un **clasificador conservador**:

1. Vive en una sola tabla de patrones dentro de `src/llm/provider.ts`, para que actualizarla sea una
   línea.
2. Solo da veredicto cuando la credencial encaja **inequívocamente** con el patrón de un proveedor
   elegible **distinto** del declarado. Entonces es **error** y el entorno queda no apto (FR-028).
3. Una forma que no reconoce **no se rechaza nunca** (es el caso límite que ya fija la spec). Esto es
   lo que hace que un cambio de prefijo del proveedor degrade a «no detecto nada» en lugar de a
   «rechazo claves buenas».

**Razón**: el valor de la comprobación es cazar el error humano frecuente —pegar la clave en la
variable de otro proveedor—, no autenticar. Un clasificador que se equivoca hacia el silencio es
seguro; uno que se equivoca hacia el rechazo bloquea despliegues legítimos cuando el proveedor
cambie de formato, y ya hemos visto que cambian.

**Lo que esto implica para la spec**: FR-028 se cumple, con la salvedad de que su cobertura es la de
los prefijos conocidos el día que se escribe. R4 es la defensa que no envejece.

## R4 · La comprobación ya existe y es un aviso: ahí está el agujero

**Hallazgo clave**, que reduce el trabajo y precisa el Problema 3 de la spec: el código **ya tiene**
una comprobación de forma. `src/provisioning/secrets.ts:73` emite `llm_key_format` cuando
`ANTHROPIC_API_KEY` no empieza por `sk-ant-`, con el mensaje «ANTHROPIC_API_KEY no empieza por
sk-ant-».

Pero:

1. La emite como **`'warning'`**, no como error. Un aviso no deja el entorno no apto, así que
   `pnpm instance:check` **pasa**. Esto es, literalmente, el fallo que la feature existe para cerrar.
2. Solo conoce el prefijo de Anthropic, así que no sabe decir *de quién* es la clave que encontró.
3. `src/provisioning/check.ts:300` descarta para esa variable cualquier código que no sea
   `llm_key_format`, así que la regla general de calidad de secretos no la cubre.

**Decisión**: no se añade un mecanismo nuevo. Se **sube** el existente:

- `llm_key_format` pasa a **`'error'`** cuando la credencial encaja con otro proveedor elegible.
- Se añade un código nuevo `llm_key_other_provider` con el mensaje que nombra la variable, a qué
  proveedor parece pertenecer la credencial y qué hacer, sin mostrar ningún carácter (FR-032).
- `llm_key_format` se queda como **aviso** para el caso «no reconozco esta forma», que por R3 no
  debe bloquear.

**Razón**: reutilizar el camino que ya existe deja el cambio pequeño y verificable, y la prueba
`tests/unit/provisioning/secrets.test.ts:59` que hoy fija el comportamiento sirve de punto de
partida para la prueba de regresión.

## R5 · Petición barata de validación de credencial

**Decisión**: una petición `GET` al extremo de **listado de modelos** de cada proveedor, con la
credencial, y esta clasificación:

| Respuesta | Veredicto |
|---|---|
| 2xx | credencial **aceptada** |
| 401, 403 | credencial **rechazada** |
| cualquier otra cosa (red, 5xx, tiempo agotado, DNS) | **no concluyente** |

Cabeceras por proveedor: Anthropic usa `x-api-key` más `anthropic-version`; OpenAI usa
`Authorization: Bearer`; Gemini usa la clave en `x-goog-api-key`. La implementación fija el detalle
contra la documentación vigente de cada uno en el momento de escribirla.

**Razón**: listar modelos no genera tokens, así que no consume presupuesto del cliente (FR-031) y
cuesta una petición. La separación entre «rechazada» y «no concluyente» es la que sostiene FR-030 y
FR-030a: solo un 401/403 es un veredicto.

**Riesgo asumido y acotado**: la búsqueda no encontró documentación oficial que confirme que los tres
extremos de listado exigen credencial; los resultados eran de pasarelas de terceros, y al menos una
devuelve el listado **sin** autenticar. Si algún proveedor no pidiera credencial para listar, un 2xx
no probaría nada. **Mitigación**: la implementación verifica proveedor a proveedor que una credencial
inválida da 401/403, con una prueba que lo fija; si alguno no cumpliera, se usa para él la petición
de generación más pequeña posible y se anota el coste.

## R6 · Comprobación de la credencial al arrancar (FR-005a/b/c)

**Decisión**: `src/llm/credential-probe.ts`, con la clasificación de R5, lanzado desde `bot.ts`
después de construir el modelo y **sin bloquear el arranque**:

- **Rechazada** → la instancia entra en degradado declarado. Se reutiliza el camino que ya existe:
  `src/usage/protection.ts` ya sabe degradar a «solo contacto del negocio» (es lo que hace con el
  modelo sin precio) y `src/webchat/availability.ts` ya tiene el motivo `no_bot`. Se añade un estado
  de credencial rechazada a `protectionState` y un aviso crítico a `computeWarnings`.
- **No concluyente** → se arranca con normalidad, se anota en el registro de actividad y no se
  degrada nada.
- **Reintento**: un vigilante con la misma forma que `src/db/outage.ts` de la 016 —dos estados, sin
  una línea de registro por petición— que reintenta cada **5 minutos** mientras la credencial esté
  rechazada y sale del degradado solo cuando pase a aceptada.

**Razón de los 5 minutos**: es la cadencia que la spec dejó sin cuantificar. 5 min son 288
peticiones de listado al día en el peor caso, que no generan tokens, y acotan la recuperación
automática a «como mucho 5 minutos después de arreglar la clave». Un minuto no compra nada
—arreglar una credencial no es instantáneo— y una hora convierte la recuperación en una llamada de
soporte.

**Razón de que no sea fatal**: es la lección de la 016. Su Fallo 1 fue exactamente un proceso que
moría al arrancar sin una dependencia disponible, y el resultado fue un bucle de reinicio con el
proxy devolviendo 502. Una credencial rechazada **no** debe poder producir eso, y además el
Principio V exige que el cliente final siga teniendo salida a una persona: el degradado la da, el
bucle de reinicio no.

## R7 · Salida estructurada: tres dialectos del mismo JSON Schema

El dominio exige que la respuesta valide contra `modelReplySchema` (Zod). Hoy el esquema se deriva
con `z.toJSONSchema` y se limpia quitando `$schema`, `maxLength`, `minLength` y `default`, porque la
salida estructurada de Anthropic no admite restricciones de longitud; Zod las revalida al recibir.
Los tres proveedores piden el esquema en sitios distintos y con reglas distintas:

| Proveedor | Dónde va el esquema | Reglas propias |
|---|---|---|
| Anthropic | `output_config.format` = `{ type: 'json_schema', schema }` | sin `minLength`/`maxLength` (ya resuelto) |
| OpenAI | `text.format` = `{ type: 'json_schema', name, strict: true, schema }` | **modo estricto**: `additionalProperties: false` en todo objeto y **todas** las propiedades en `required` |
| Gemini | `generationConfig.responseFormat.text` = `{ mimeType: 'application/json', schema }` | «el modelo ignora las propiedades no admitidas»: tolerante |

**El problema real está en OpenAI.** Su modo estricto **no admite propiedades opcionales**, y
`modelReplySchema` tiene opcionales: los campos de la derivación (005) faltan en la respuesta y Zod
les pone su valor por defecto.

**Decisión**: la preparación del esquema se parametriza por proveedor en
`src/llm/reply-schema.ts`, con una función por dialecto sobre el mismo esquema base:

- **Anthropic**: la limpieza actual, sin cambios.
- **Gemini**: la misma limpieza (sus propiedades no admitidas se ignoran, así que quitarlas es
  inofensivo y deja un esquema más pequeño, que su documentación agradece).
- **OpenAI**: la limpieza actual **más** promover todo opcional a requerido admitiendo `null`
  (`type: ['string', 'null']`), y `additionalProperties: false` en cada objeto. El adaptador
  convierte los `null` recibidos en «ausente» antes de pasar el objeto a Zod, para que los valores
  por defecto del dominio sigan aplicándose igual que con los otros dos.

**Razón**: el dominio no se toca. `modelReplySchema` sigue siendo la única verdad y la única puerta
(FR-014); lo que varía es la traducción de ida y la normalización de vuelta, que es exactamente el
trabajo de un adaptador.

**Alternativa descartada**: hacer obligatorios los campos de la derivación en el esquema del dominio
para que los tres coincidan. Cambiaría el contrato del dominio y el prompt para acomodar una
limitación de un proveedor, y afectaría al comportamiento con los otros dos.

## R8 · Esfuerzo y razonamiento interno

| Proveedor | Mando | Traducción de `LLM_EFFORT` |
|---|---|---|
| Anthropic | `output_config.effort` + `thinking: { type: 'adaptive' }` | directa: `low`/`medium`/`high` |
| Gemini | `generationConfig.thinkingConfig.thinkingLevel`, valores `minimal`/`low`/`medium`/`high` | directa a `low`/`medium`/`high` |
| OpenAI | `reasoning: { effort }` en los modelos de razonamiento | directa; **sin efecto** en un modelo sin razonamiento |

**Decisión**: traducción directa en los tres, porque los tres tienen un mando de tres posiciones o
más. `minimal` de Gemini no se usa: no hay posición del dominio que le corresponda, y la
documentación avisa de que no está admitido en todos sus modelos.

**Degradación declarada (FR-017)**: si el modelo configurado no admite el mando —caso típico, un
modelo de OpenAI sin razonamiento—, el adaptador **no envía** el parámetro y deja constancia una vez
en el arranque: el ajuste no se rechaza ni se silencia. No se intenta adivinar por el nombre del
modelo si admite razonamiento; se envía y, si el proveedor lo rechaza por parámetro no admitido, se
anota y se reintenta sin él una sola vez, recordando la decisión para el resto de la vida del
proceso.

**Riesgo anotado para la evaluación (R13)**: Gemini documenta que `thinkingLevel` por defecto es
`medium` en varios de sus modelos y que en algunos **el razonamiento no se puede apagar del todo**.
Esto refuerza lo que ya decía la spec: `LLM_EFFORT=medium` se calibró contra un modelo de Anthropic
y no hay motivo para suponer que significa lo mismo en los otros dos.

## R9 · Caché de contexto

| Proveedor | Mecanismo | Qué informa |
|---|---|---|
| Anthropic | `cache_control: { type: 'ephemeral' }` explícito en los bloques de sistema | escritura y lectura, por separado |
| OpenAI | caché automática, sin marcar nada en la petición | solo lectura (`cached_tokens`) |
| Gemini | implícita (automática) y explícita (contenido en caché) | solo lectura (`cachedContentTokenCount`) |

**Decisión**: se conserva la marca explícita en Anthropic. En OpenAI y Gemini no se marca nada —no
hay nada que marcar— y se usa la caché automática. La **escritura** de caché queda como **no
informada** en esos dos, que es el caso de FR-024: en el panel sale «sin dato», no cero.

**Razón de no usar la caché explícita de Gemini**: obliga a gestionar el ciclo de vida de un objeto
de caché en el proveedor (crearlo, renovarlo, borrarlo), con su propio coste de almacenamiento. El
prompt del sistema se lee en cada respuesta desde `KnowledgeReader.getSnapshot()` sin caché por
decisión del producto, así que un contenido en caché con vida propia en el proveedor se quedaría
desincronizado de la información del negocio. La caché implícita da el ahorro sin ese riesgo.

## R10 · Señales de rechazo y traducción de fallos

El dominio tiene cuatro causas y FR-016 prohíbe que crezcan: `timeout`, `refusal`,
`invalid_output`, `api_error`.

| Proveedor | Señal de rechazo |
|---|---|
| Anthropic | `stop_reason === 'refusal'` |
| OpenAI | un elemento de contenido con `type: 'refusal'` dentro de `output`, **con el estado en `completed`** |
| Gemini | bloqueo por seguridad: motivo de bloqueo del prompt, o motivo de fin del candidato por seguridad |

**Decisión**: cada adaptador tiene su propia función `toChatModelError`, con la misma firma que la
que ya existe para Anthropic, y la tabla de traducción:

- rechazo del proveedor → `refusal`
- tiempo agotado o aborto por nuestra señal → `timeout`
- respuesta que no es JSON, no valida contra Zod, o viene truncada por tope de salida →
  `invalid_output`
- cualquier otro fallo del proveedor → `api_error`, con el código HTTP cuando lo haya

**Aviso de implementación**: en OpenAI el rechazo llega con estado `completed`, así que **no se puede
mirar solo el estado**; hay que inspeccionar el tipo de los elementos de contenido. Un adaptador que
confíe en el estado tratará un rechazo como respuesta válida vacía y el cliente final recibirá algo
sin sentido.

## R11 · Consumo: campos por proveedor y el estado «no medido»

| Concepto del dominio | Anthropic | OpenAI | Gemini |
|---|---|---|---|
| `input` | `usage.input_tokens` | `usage.input_tokens` | `usageMetadata.promptTokenCount` |
| `output` | `usage.output_tokens` (incluye razonamiento) | `usage.output_tokens` (incluye `output_tokens_details.reasoning_tokens`) | `candidatesTokenCount` + `thoughtsTokenCount` |
| `cacheRead` | `cache_read_input_tokens` | `input_tokens_details.cached_tokens` | `cachedContentTokenCount` |
| `cacheWrite` | `cache_creation_input_tokens` | `input_tokens_details.cache_write_tokens` (ver corrección) | **no informado** |

**Corrección comprobada contra el SDK instalado (2026-10-13, durante la implementación).** Esta
tabla daba por hecho que OpenAI no informa de la escritura de caché, y **es falso** con `openai`
7.32.0: `ResponseUsage.InputTokensDetails` declara `cache_write_tokens: number`, **no opcional**,
junto a `cached_tokens`. Comprobado en
`node_modules/openai/resources/responses/responses.d.ts`.

Consecuencias, y van en la dirección de FR-024, no en contra:

- **OpenAI informa de los cuatro conceptos**, igual que Anthropic. Su `cacheWrite` es un **número**,
  nunca `null`. Escribir `null` ahí sería exactamente el error que FR-024 prohíbe, en su versión
  espejo: el panel afirmaría que el modelo no informa de un dato del que sí informa.
- **El `null` queda solo para Gemini**, y eso sí está confirmado contra su SDK:
  `GenerateContentResponseUsageMetadata` (`@google/genai` 2.29.0) no tiene ningún campo de escritura
  de caché; solo `cachedContentTokenCount`, que es lectura.
- La fila «Tokens de escritura de caché» de la tabla de capacidades de
  [data-model.md](data-model.md) §1 pasa a ser: `anthropic` sí, `openai` sí, `gemini` **no
  informado**.
- Lo que **no** cambia: la relajación del `NOT NULL` sigue siendo imprescindible, porque Gemini sola
  ya exige representar los tres estados. La migración, el medidor y el panel no se tocan.

Confirmado también de Gemini en el mismo repaso: `thoughtsTokenCount` va **aparte** de
`candidatesTokenCount`, como avisaba esta sección.

**Aviso de implementación para Gemini**: los tokens de razonamiento se informan **aparte** en
`thoughtsTokenCount` y no están dentro de `candidatesTokenCount`. Sumarlos es obligatorio: si no, el
consumo de salida se subestima y el tope de gasto protege menos de lo que cree. En Anthropic y
OpenAI el razonamiento ya va dentro de los tokens de salida, así que **no** se suma dos veces.

**Decisión sobre `src/llm/token-usage.ts`**: deja de importar tipos del SDK de Anthropic (FR-023).
Pasa a recibir un `TokenUsage` ya normalizado, y la extracción de los campos vive en cada adaptador.

**`null` viene de la capacidad del proveedor, no de un campo ausente.** Anthropic **sí** informa de
la escritura de caché; cuando una respuesta concreta no escribió nada, el campo llega ausente y el
adaptador hace hoy `?? 0`. Eso debe seguir igual: es un **cero medido**. El `null` se reserva para
Gemini y OpenAI, que no informan del concepto nunca. Si se cambiara ese `?? 0` por `?? null`, una
instancia de Anthropic sin escritura de caché pasaría a mostrar «sin dato» donde hoy muestra `0`, y
el panel afirmaría que el modelo no informa de un dato del que sí informa.

**El estado «no medido» y la migración.** `ResponseUsage` ya tiene `calls`, que cuenta las llamadas
que **informaron** tokens (`src/conversation/responder.ts:379`). La tentación es usar `calls = 0`
como discriminador, y **no se puede**: la migración publicada `0006_usage.sql:28` tiene
`CONSTRAINT model_usage_calls CHECK (calls >= 1)`, y las migraciones publicadas no se editan nunca.

**Decisión**: una migración con dos partes, detalladas en [data-model.md](data-model.md) §2.

1. **Aditiva**: una columna `unmeasured_calls smallint not null default 0` en `model_usage`. El
   significado de `calls` se precisa sin cambiarlo: llamadas con respuesta. Para todo lo ya
   registrado, `unmeasured_calls = 0` y `calls` significa exactamente lo que significaba, así que
   **el histórico no se reinterpreta** (FR-026).
2. **Relajación acotada**: quitar el `NOT NULL` de `cache_write_tokens` y `cache_read_tokens`.

**Razón de no relajar el `CHECK (calls >= 1)`**: quitar un `CHECK` publicado para volver a ponerlo
dejaría el histórico con un `calls = 0` cuyo significado depende de la fecha de la fila. La columna
nueva es más barata de entender y de probar.

**Razón de sí quitar el `NOT NULL` de las dos columnas de caché**: sin eso, los tres estados que
FR-024 exige distinguir **no son representables**. Con `integer NOT NULL`, un «no informado» y un
«cero medido» aterrizan los dos como `0`, y la deducción que R15 encarga al panel es imposible.
`unmeasured_calls` no cubre este caso: cuenta llamadas sin **ningún** dato de consumo, no distingue
concepto por concepto. Quitar un `NOT NULL` es una relajación, no una reescritura: no edita ninguna
migración publicada, no toca ninguna fila y no pierde ningún dato. Es la única excepción de la
feature a la convención de solo añadir, y está acotada a estas dos columnas.

**Trampa que esto abre, y que hay que cerrar en el medidor**: la sentencia de inserción de
`src/usage/meter.ts` calcula el coste sumando los cuatro conceptos por su precio. Con un `NULL` en
medio, la suma entera da `NULL`, `cost_pico` queda nulo mientras `currency` no, y eso **viola** la
restricción `model_usage_cost_currency`. La inserción fallaría y el medidor, que nunca lanza, se
comería el error: **se perdería todo el registro de consumo de Gemini y OpenAI en silencio**. El
coste tiene que tratar el nulo como cero y a la vez persistir `NULL` en la columna del token.

**Sin subir `formatVersion`** (FR-037): `model_usage` es registro de consumo, no configuración del
negocio. No entra en la transferencia de configuración, así que no hay actualizador que escribir. El
test de cobertura de columnas vigila las tablas de configuración, no esta.

## R12 · Hay dos puertos de modelo, no uno

**Hallazgo**: la spec habla del modelo de conversación, pero el programa llama al proveedor por
**dos** sitios. Además de `ChatModel`, existe `HandoffSummarizer`
(`src/llm/anthropic-summarizer.ts`), que resume la conversación al derivar al negocio (005) y usa el
mismo SDK, el mismo modelo, esfuerzo `low` y su propia salida estructurada `{ summary }`.

**Decisión**: los dos puertos se tratan igual y las dos fábricas viven en R1. El resumidor es más
fácil que el principal: su esquema es un objeto de un solo campo obligatorio, así que no sufre el
problema del modo estricto de OpenAI (R7). Su traducción de fallos es la propia, más laxa: hoy lanza
`Error` genérico, y eso no cambia.

**Por qué importa**: si solo se migrase `ChatModel`, una instancia con Gemini funcionaría en la
conversación y **fallaría justo al derivar al negocio**, que es el momento más sensible del producto
y el que protege el Principio V. Esto obliga a añadir una regla a la spec (FR-013a).

## R13 · Pruebas sin red ni credenciales

**Decisión**: tres dobles de proveedor en `tests/fixtures/llm/`, uno por proveedor, que devuelven
respuestas preparadas con la forma **real** de cada API —incluidos sus campos de consumo y sus
señales de rechazo—, y que se inyectan por la opción `client` que los adaptadores ya aceptan para
pruebas. Ningún test hace red ni lee una credencial real (FR-038).

**Razón**: es el patrón que el repositorio ya usa (`AnthropicChatModelOptions.client`). Mantiene
`pnpm test` ejecutable por cualquiera y sin coste, que es lo que SC-011 exige.

**Lo que los dobles no pueden probar**: que los campos de la forma real sean los correctos. Esa es
la función de la evaluación (R14) y de los recorridos a mano del [quickstart](quickstart.md). Es una
limitación conocida y aceptada: una prueba con un doble verifica nuestra traducción, no la API del
proveedor.

## R14 · Evaluación por proveedor y modelo por defecto

**Decisión**: `pnpm test:eval` se parametriza por `LLM_PROVIDER` y `LLM_MODEL` y se corre **una vez
por proveedor elegible**, con el `LLM_EFFORT` por defecto. El resultado de cada corrida se anota en
`docs/operacion-multicliente.md` con proveedor, modelo, esfuerzo, fecha y veredicto.

**Si un proveedor no alcanza el criterio** (FR-036): se le da un `LLM_EFFORT` por defecto propio,
razonado, y se reevalúa. Si sigue sin alcanzarlo, no se declara elegible en esta versión.

**Qué modelo se usa en cada corrida**: lo declara el entorno de evaluación, no el código. La
investigación encontró que los catálogos de Gemini y OpenAI se mueven rápido, así que fijar nombres
de modelo en el repositorio los dejaría obsoletos entre features. Esto es coherente con R2, donde
`LLM_MODEL` es obligatoria fuera de Anthropic.

## R15 · El panel distingue «sin dato» de cero, sin decir quién es el proveedor

**Decisión**: los conceptos de consumo que el proveedor no informa se presentan como «sin dato» en
`src/admin/views/usage.eta`, con una nota genérica —«el modelo configurado no informa de este
dato»—, y quedan **fuera** de los totales. La capacidad se deduce de los datos registrados, no del
nombre del proveedor: si en el periodo no hay ni una fila con escritura de caché informada, el
concepto sale como «sin dato».

**Razón**: cumple FR-024 y FR-008 a la vez. El panel no necesita saber quién es el proveedor para
saber que un dato no llegó, y deducirlo de lo registrado evita tener que pasar la identidad del
proveedor a la capa de presentación, que es justo lo que FR-006 prohíbe.

**Lo que hace posible esa deducción** es la segunda parte de la migración de R11: con las columnas
de caché nulables, «no informado» es `NULL` y «cero medido» es `0`, y el periodo se clasifica
contando filas con el concepto no nulo. Sin esa relajación, esta decisión no se podía implementar.

**Alternativa descartada**: deducir la capacidad del nombre del modelo, que ya está en cada fila.
No necesita migración, pero mete una tabla de capacidades por modelo en la capa de presentación, que
es casi exactamente lo que FR-006 y FR-008 prohíben.

## R16 · SDK o `fetch` para los dos proveedores nuevos

**Decisión**: SDK oficial de cada proveedor (`openai` y `@google/genai`), con la versión fijada, y
`@anthropic-ai/sdk` donde ya está.

**Razón**: los adaptadores necesitan plazo por petición, señal de aborto, política de reintentos y
tipos de error distinguibles para R10. Escribir eso a mano sobre `fetch` para dos proveedores es
precisamente el tipo de código que falla en los casos raros, que son los que importan aquí. Los SDK
quedan contenidos en `src/llm/`, que es su sitio.

**Alternativa descartada**: `fetch` directo contra REST, para no añadir dos dependencias. Ahorra
peso a cambio de reescribir el manejo de errores y los tiempos de espera tres veces. La frontera del
adaptador ya contiene la dependencia, así que el peso no se filtra al dominio.

**Nota de seguridad del proceso**: añadir dependencias con `pnpm` en esta máquina exige comprobar
antes el emisor del certificado de `registry.npmjs.org`. Si el análisis HTTPS de Avast está activo,
la instalación falla con un error de certificado que no se parece a lo que es.
