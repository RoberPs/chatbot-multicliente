# Research: Consumo y coste por instancia

**Feature**: 010-usage-cost-cap | **Fecha**: 2026-10-01

Decisiones técnicas que resuelven lo que la spec deja al plan. Cada una: decisión, motivo y
alternativas descartadas.

---

## R1. Cómo llegan los tokens del adaptador al dominio

**Decisión**: los puertos `ChatModel.reply` y `HandoffSummarizer.summarize` reciben en sus opciones
un receptor opcional `onUsage(usage: TokenUsage)`. El adaptador de Anthropic lo llama con
`response.usage` **siempre que haya respuesta del proveedor**, también si después la descarta
(`refusal`, `stop_reason` distinto de `end_turn`, JSON no válido). Si la llamada lanza antes de
tener respuesta (error HTTP, corte de red, plazo agotado), no hay `usage` y no se llama
(FR-004, US1-6).

`TokenUsage = { input, output, cacheWrite, cacheRead }` (enteros ≥ 0) sale de
`input_tokens`, `output_tokens`, `cache_creation_input_tokens ?? 0` y
`cache_read_input_tokens ?? 0` del tipo `Usage` del SDK instalado (`@anthropic-ai/sdk` 0.128). Los
tokens de razonamiento (`thinking: adaptive`) ya van dentro de `output_tokens`.

**Motivo**: el receptor no cambia el valor de retorno, así que los dobles de prueba existentes
siguen valiendo; y cubre el caso de "respuesta recibida pero descartada", que con un valor de
retorno se perdería al lanzar `ChatModelError`.

**Alternativas**: devolver `{ reply, usage }` (rompe todos los dobles y pierde el uso en los
errores); envolver el cliente HTTP del SDK (acopla el dominio a la forma del SDK); leer las
cabeceras de la respuesta (no traen tokens).

## R2. Un registro por respuesta, no por llamada

**Decisión**: el responder acumula los `TokenUsage` de todos los intentos de una respuesta (el
reintento del verificador, FR-002) y devuelve `response.usage = { calls, tokens }`; el procesador
guarda **un** registro con `calls` = número de llamadas que informaron tokens. El resumen de
derivación es otro registro con `purpose = handoff_summary`. Si ninguna llamada informó tokens, no
hay registro.

**Motivo**: "respuestas con modelo" es la unidad que el operador factura y compara con el tope del
chat web; con `calls` se conserva el dato de los reintentos sin multiplicar filas.

**Alternativas**: una fila por llamada (más filas y la cuenta de respuestas exige agrupar por un
identificador de respuesta, que sería un identificador de conversación encubierto, FR-003).

## R3. Cuándo y cómo se guarda el registro sin retrasar la respuesta

**Decisión**: el procesador llama a `usageMeter.record(...)` **justo después** de que el responder
devuelva y **antes** de entregar, fuera de la transacción del saliente. Es una sola sentencia
`INSERT … SELECT` (R5) con `await`, envuelta en `try/catch`: si falla, se registra
`usage_record_failed` y la respuesta sigue su curso (FR-005). Igual para el resumen, dentro de
`HandoffService.start`.

**Motivo**: guardarlo antes de entregar hace que la siguiente comprobación del tope ya lo vea
(edge case de respuestas simultáneas, SC-007); fuera de la transacción del saliente, un fallo del
registro no tumba la respuesta. Una inserción indexada cuesta milisegundos (SC-006 < 100 ms).

**Alternativas**: dentro de la transacción del saliente (un fallo impediría responder, viola
FR-005); en segundo plano sin esperar (el siguiente mensaje podría no ver el gasto y el proceso
podría cerrarse con inserciones a medias).

## R4. Unidades: precios, coste y tope en enteros

**Decisión**:

| Magnitud | Columna | Unidad | Ejemplo |
|---|---|---|---|
| Precio por tipo de token | `*_micros_per_mtok` (`bigint`) | millonésimas de la moneda por millón de tokens | 3,75 USD/MTok → `3 750 000` |
| Coste de un registro | `cost_pico` (`bigint`, nulo = sin precio) | billonésimas (10⁻¹²) de la moneda | Σ tokens × precio |
| Tope mensual | `monthly_cap_cents` (`integer`) | céntimos | 50,00 USD → `5000` |

`cost_pico = input × p_in + output × p_out + cacheWrite × p_cw + cacheRead × p_cr`, **exacto en
enteros**: tokens × (millonésimas por millón de tokens) = billonésimas. La comparación con el tope
también es entera: `gastado_pico ≥ cap_cents × 10¹⁰`; y el aviso del 80 %:
`gastado_pico × 100 ≥ cap_cents × 10¹⁰ × 80`. En el panel los precios se escriben en decimal con
hasta 6 decimales y el tope con hasta 2.

**Motivo**: la convención del proyecto es "importes en enteros" (céntimos); un céntimo no basta para
el coste de una respuesta (una respuesta típica cuesta décimas de céntimo: FR-010 pide que no se
redondee a cero). Con enteros, los totales del panel coinciden **exactamente** con la suma a mano
(SC-002) y no hay coma flotante en ningún paso. Rango: un registro de 200 000 tokens a 100 USD/MTok
son 2·10¹³ billonésimas; un `bigint` admite 9,2·10¹⁸, y las sumas se hacen en `numeric` de
PostgreSQL.

**Alternativas**: `numeric(20,10)` (exacto, pero Drizzle lo devuelve como texto y rompe la
convención de enteros); coste en millonésimas redondeado por registro (los totales dejarían de ser
la suma exacta de precio × tokens); `double` (descartado por exactitud).

## R5. El coste se calcula al insertar, con el precio vigente

**Decisión**: el registro se inserta con una sola sentencia que lee el precio y la moneda en el
mismo instante:

```sql
insert into model_usage (…, cost_pico, currency)
select …, case when p.model is null then null else $in*p.input_… + … end,
          case when p.model is null then null else s.currency end
from usage_settings s left join model_price p on p.model = $model
```

La aritmética se replica en una función pura (`costPico`) que usan los tests para comprobar el SQL.
Cambiar un precio después **no** toca registros anteriores (FR-011, clarificación 1); un registro
sin precio queda con `cost_pico` y `currency` nulos para siempre (FR-012).

**Motivo**: una sola ida y vuelta (R3) y ninguna ventana entre leer el precio y guardar.

**Alternativas**: leer el precio en TS y luego insertar (dos consultas); histórico de precios y
coste calculado al consultar (la spec lo descarta: los costes se congelan al registrar).

## R6. Día y mes local del registro

**Decisión**: cada registro guarda `at` (`timestamptz`) y `day` (`date`, día local del negocio en
ese momento, con la zona del snapshot que ya tiene quien registra), calculado con `localDay` de
`src/webchat/usage.ts` (que se mueve a `src/knowledge/time/local-date.ts` para compartirlo). "Hoy" y
"este mes" se resuelven con `localDay` / `localMonthRange` en la zona actual y se consultan por
`day` (índice). Si el negocio cambia de zona, los registros antiguos conservan su día.

**Motivo**: mismo criterio que el uso del chat web (004, R9): nada se pasa a UTC (convención) y el
corte de mes es el del negocio (FR-008, US3-8).

**Alternativas**: agrupar `at` con `AT TIME ZONE` en cada consulta (no aprovecha el índice y cambia
el pasado si cambia la zona).

## R7. Comprobación del tope sin caché y con una sola consulta

**Decisión**: `spendCapState(tx, now, timezone)` lee en **una** consulta los ajustes
(`usage_settings`) y la suma `sum(cost_pico) filter (where currency = s.currency)` de los días del
mes local en curso, y devuelve `{ level: 'none' | 'normal' | 'warning' | 'reached', spentPico,
capCents, currency }`. Se llama:

- en el **procesador**, antes de llamar al modelo, para los canales con `policy.spendCap`
  (WhatsApp y web; no el playground, FR-019);
- en la **recepción** del chat web (descartar con motivo `spend_cap`) y en
  `webChatAvailability` (estado "no disponible", FR-017), junto al tope de respuestas de la 004;
- en el **panel** (aviso de todas las pantallas) y en el **informe de salud** (R11).

Sin caché (FR-016, FR-022): subir o desactivar el tope, o empezar el mes, vale desde el siguiente
mensaje.

**Motivo**: el mes tiene como mucho decenas de miles de filas con índice por `day`; la suma cuesta
milisegundos y evita mantener un agregado que habría que cuadrar con restauraciones (FR-025).

**Alternativas**: tabla agregada por día y canal (más rápida, pero otra escritura por respuesta y
un estado que puede desincronizarse); caché en memoria (viola FR-016).

## R8. Qué responde el bot con el tope alcanzado

**Decisión**:

- **WhatsApp**: plantilla nueva `R-CAP` = el cuerpo de `unavailableReply` ("Ahora mismo no puedo
  atenderte por este chat.") + CONTACTO del negocio (o el de emergencia de la instancia, FR-016),
  sin saludo y **sin llamar al modelo**. Se le adjunta una salida de modelo **sintética**
  (`body` = el texto de `R-CAP`, todas las banderas a `false`) y `handoffDetected` = el detector
  determinista de la 002, de modo que `handoffTurn` decide la derivación igual que siempre
  (FR-018, Principio V): una petición de persona con vías pide los datos o inicia la derivación;
  sin vías, queda `R-CAP` con su contacto. Sin modelo no se reconocen quejas ni ofertas: se tratan
  como petición de persona si el detector la ve, y en cualquier caso la respuesta lleva contacto.
- **Chat web**: el mismo estado "no disponible" de la 004 (FR-017). La API y el frame responden con
  `reason: "quota"` —el visitante no necesita distinguir el tope de gasto del de respuestas— y los
  mensajes ya aceptados reciben `R-UNAVAILABLE`. El contacto del estado "no disponible" es la
  salida a una persona del canal, como en la 004.
- **"Probar el bot"**: sin cambios; responde con el modelo y suma al gasto (FR-019, clarificación 4).

**Motivo**: reutiliza la decisión pura de la 005 sin bifurcarla; el contacto va siempre, así que el
Principio V se cumple aunque el detector no reconozca la petición.

**Alternativas**: reutilizar `R-UNAVAILABLE` en WhatsApp (se perdería en las trazas y en el registro
de actividad por qué no se llamó al modelo); un motivo nuevo `spend_cap` en la API pública del chat
web (revela al visitante un dato de facturación del negocio y cambia el contrato de la 004).

## R9. Resumen de derivación con el tope alcanzado

**Decisión**: `HandoffService.start` recibe `modelSummary: boolean`. Con `false` (el procesador lo
pasa cuando el tope está alcanzado) usa directamente `fallbackSummary` (extracto literal de la 005)
y registra `handoff_summary_fallback` con `reason: 'spend_cap'`; no llama al modelo ni registra
consumo (US3-5). Con `true`, el resumen se registra con `purpose = handoff_summary` y el canal de la
conversación (US1-4).

**Motivo**: el aviso al negocio nunca se queda sin motivo (005) y no gasta con el tope alcanzado.

## R10. Evento "tope alcanzado" una sola vez por mes

**Decisión**: `usage_settings.cap_notified_month` (`date`, primer día del mes local). Al detectar
`reached`, `UPDATE usage_settings SET cap_notified_month = $mes WHERE cap_notified_month IS
DISTINCT FROM $mes RETURNING 1`; solo quien actualiza la fila emite `spend_cap_reached`
(FR-023).

**Motivo**: sobrevive a reinicios y a varias comprobaciones simultáneas (el `QuotaWatch` de la 004
es solo de proceso y puede repetirse tras reiniciar).

## R11. Estado del tope en `/health` y en `instance:versions`

**Decisión**:

- El sondeo de salud de la 009 (pool propio, `READ ONLY`, tope de 2 s) añade, **solo si el esquema
  aplicado es el esperado**, una consulta de `spendCapState` con la zona de `business`. El informe
  gana `spendCap: 'none' | 'normal' | 'warning' | 'reached' | null` (`null` si no se pudo leer).
  **No cambia `status`** ni el código HTTP. Solo lo incluye la vista completa (con secreto);
  la vista sin credencial sigue siendo `{status}` (FR-023a, US3-12).
- `instance:versions` añade la columna **Tope** («sin tope», «normal», «≥80 %», «alcanzado», «—»)
  y el campo `spendCap` en `--json`. Un valor ausente o desconocido (instancia anterior a la 010)
  es `null` / «—». No interviene en la clasificación de la fila ni en el código de salida
  (FR-023b).

**Motivo**: reutiliza el canal ya protegido de la 009; sin importes ni precios en ninguna salida.

**Alternativas**: un endpoint nuevo (otra superficie y otro secreto que gestionar).

## R12. Aviso en todas las pantallas del panel

**Decisión**: `renderPage` calcula en cada petición, como la línea de versión de la 009, un
`layout.spend` con `spendCapState` + "¿el modelo actual (`LLM_MODEL`) tiene precio?". El layout
pinta, por orden de gravedad:

1. tope **alcanzado** — "El bot responde solo con el contacto del negocio";
2. tope activo y **modelo actual sin precio** — nombra el modelo y dice que su consumo no cuenta
   (FR-021);
3. **≥ 80 %** — porcentaje consumido (redondeado hacia abajo).

No entran en `computeWarnings`: no son configuración del negocio, no cuentan en el contador de
avisos ni bloquean activar el negocio (FR-020, FR-021). Si la consulta falla, la página se sirve
sin aviso.

**Alternativas**: meterlos en `computeWarnings` (mezclaría estado de facturación de la instancia
con la validez de la configuración y afectaría a FR-032).

## R13. Moneda de coste

**Decisión**: `usage_settings.currency` (ISO 4217, por defecto `USD`, FR-026). Cada registro con
precio guarda también la moneda con la que se valoró. Cambiar la moneda solo se permite con la
tabla de precios vacía (error de campo si no); el gasto del tope suma solo los registros en la
moneda actual, y la pantalla "Consumo" muestra un total por moneda si en un periodo hay más de una.

**Motivo**: evita reinterpretar costes ya congelados con otra moneda sin añadir conversión.

## R14. Retención de 13 meses

**Decisión**: la pasada horaria de `src/conversation/retention.ts` borra también los registros con
`day` anterior al primer día del mes local de hace 12 meses (zona leída de `business`; si no hay
negocio, UTC). Los precios y los ajustes no caducan.

**Motivo**: FR-006, en el mismo proceso que ya borra conversaciones y días de uso del chat web.

## R15. Exportación, importación y copias

**Decisión**: las tablas nuevas (`model_usage`, `model_price`, `usage_settings`) **no** son tablas
de configuración del negocio: no se añaden a `CONFIG_TABLES` del test de cobertura, no viajan en el
fichero de la 008 ni se tocan al importar (FR-024), y **no sube `formatVersion`**. La regla de
CLAUDE.md ("toda migración que añada configuración del negocio sube `formatVersion`") no aplica
porque son ajustes de la instancia y de su contrato (spec, edge case de exportar e importar). Un
test lo fija. Las copias de la 006 las incluyen sin cambios (FR-025): la migración nueva es de solo
añadir.

## R16. Rendimiento

**Decisión**: objetivo de diseño ≤ 10 ms añadidos por respuesta (una consulta de tope + una
inserción). La prueba de integración de rendimiento existente compara la mediana con y sin
medición y exige < 100 ms de diferencia (SC-006).

## Sin incógnitas abiertas

No queda ningún NEEDS CLARIFICATION: las unidades, la forma de captar los tokens, el texto con el
tope alcanzado, la forma del estado en la salud y la retención quedan fijados arriba.
