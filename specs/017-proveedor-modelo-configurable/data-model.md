# Modelo de datos: Proveedor del modelo configurable por instancia

**Feature**: `017-proveedor-modelo-configurable` | **Fecha**: 2026-10-13

La feature casi no toca datos persistidos: el proveedor es **entorno**, no configuración del
negocio. El único cambio en la base de datos es una columna aditiva para el consumo no medido
(R11). Lo demás son tipos del dominio.

## 1. Tipos del dominio (sin persistencia)

### `LlmProvider`

```text
LlmProvider = 'anthropic' | 'gemini' | 'openai'
```

Cerrado. Vive en `src/llm/provider.ts` (R1). Validado con Zod en el arranque y en la comprobación
previa; un valor distinto es error y el mensaje nombra los tres elegibles (FR-002).

### `ProviderDescriptor`

Una entrada por proveedor, en la tabla única de R1:

| Campo | Tipo | Para qué |
|---|---|---|
| `provider` | `LlmProvider` | identidad |
| `keyVariable` | `string` | `ANTHROPIC_API_KEY` \| `GEMINI_API_KEY` \| `OPENAI_API_KEY` |
| `keyPatterns` | `RegExp[]` | clasificador conservador de forma (R3) |
| `modelRequired` | `boolean` | `false` solo en Anthropic, que conserva su valor por defecto (R2) |

**Regla de orden (R3)**: el clasificador evalúa `sk-ant-` **antes** de `sk-`, porque el primero es
subconjunto del segundo. Una forma no reconocida no da veredicto.

### `CredentialVerdict`

```text
CredentialVerdict = 'accepted' | 'rejected' | 'inconclusive'
```

Lo produce la petición de validación (R5) y lo consumen dos sitios distintos: la comprobación previa
(FR-029, FR-030, FR-030a) y la comprobación del arranque (FR-005a/b/c). `inconclusive` **nunca** es
un veredicto sobre la credencial: es la ausencia de veredicto.

### `ProviderCapabilities`

Lo que cada adaptador declara que su proveedor conserva, traduce o no tiene. Es la tabla que FR-021
obliga a escribir y la que fija las pruebas:

| Capacidad | `anthropic` | `gemini` | `openai` |
|---|---|---|---|
| Esquema de salida obligado | sí | sí (tolerante) | sí (modo estricto) |
| Mando de esfuerzo | sí | sí | según modelo |
| Razonamiento interno | sí | sí (no siempre apagable) | según modelo |
| Marca explícita de caché | sí | no | no |
| Tokens de lectura de caché | sí | sí | sí |
| Tokens de escritura de caché | sí | **no informado** | sí (corregido, ver R11) |
| Señal propia de rechazo | sí | sí (bloqueo de seguridad) | sí (elemento de contenido) |

### `TokenUsage` (ampliado)

Hoy: `{ input, output, cacheWrite, cacheRead }`, todos `number`.

**Cambio**: `cacheWrite` y `cacheRead` pasan a `number | null`, donde `null` significa **el
proveedor no informa de este concepto** (FR-024), frente a `0`, que significa cero medido.

**Regla crítica: `null` sale de la capacidad del proveedor, nunca de un campo ausente.** La
distinción es por proveedor, no por respuesta:

| Situación | Valor | Por qué |
|---|---|---|
| Gemini, escritura de caché | `null` | ese proveedor **nunca** informa del concepto |
| OpenAI, escritura de caché | número | **corregido en la implementación**: `openai` 7.32.0 declara `input_tokens_details.cache_write_tokens`, así que sí informa (R11) |
| Anthropic, respuesta que no escribió caché | **`0`** | Anthropic **sí** informa del concepto; esta respuesta no escribió nada, y eso es un cero medido |

El adaptador de Anthropic hace hoy `u.cache_creation_input_tokens ?? 0` y **debe seguir
haciéndolo**. Cambiarlo por `?? null` —la lectura literal de «null si no lo informa»— haría que una
instancia de Anthropic sin escritura de caché mostrase «sin dato» donde hoy muestra `0`, afirmando
en el panel que el modelo no informa de un dato del que sí informa. Es un cambio observable en
producción y en la dirección contraria a FR-024.

**Impacto**: `addTokenUsage` (`src/conversation/responder.ts`) tiene que sumar tratando `null` como
«sin dato» y no como cero: la suma de `null` con `null` es `null`; la de `null` con un número es ese
número, y el concepto pasa a estar parcialmente medido, que es el caso límite que la spec previó
para un proveedor que deja de informar a mitad de periodo.

### `ResponseUsage` (ampliado)

| Campo | Antes | Ahora |
|---|---|---|
| `calls` | llamadas que informaron tokens | **llamadas con respuesta** (se precisa, no cambia para el histórico) |
| `unmeasuredCalls` | — | llamadas con respuesta que **no** informaron tokens |
| `tokens` | `TokenUsage` | `TokenUsage` con `null` admitido en los dos conceptos de caché |

**Invariante**: `unmeasuredCalls <= calls`, y `calls >= 1` siempre que haya habido respuesta. Si
todas las llamadas fueron no medidas, `calls == unmeasuredCalls` y los tokens son 0, lo que es
distinguible de un consumo cero medido (`unmeasuredCalls == 0`).

## 2. Cambio en la base de datos

### Migración `0009_unmeasured_usage.sql` — aditiva, con una relajación acotada

```text
-- 1. Llamadas con respuesta que no informaron tokens (aditivo puro)
ALTER TABLE model_usage
  ADD COLUMN unmeasured_calls smallint NOT NULL DEFAULT 0;

ALTER TABLE model_usage
  ADD CONSTRAINT model_usage_unmeasured
  CHECK (unmeasured_calls >= 0 AND unmeasured_calls <= calls);

-- 2. «No informado» deja de ser indistinguible de «cero medido»
ALTER TABLE model_usage ALTER COLUMN cache_write_tokens DROP NOT NULL;
ALTER TABLE model_usage ALTER COLUMN cache_read_tokens  DROP NOT NULL;
```

**Por qué una columna y no `calls = 0`** (R11): la migración publicada `0006_usage.sql` tiene
`CHECK (calls >= 1)`, y las migraciones publicadas no se editan nunca. Quitar ese `CHECK` para
volver a ponerlo no es una migración de solo añadir y dejaría un `calls = 0` cuyo significado
dependería de la fecha de la fila.

**Por qué hay que quitar el `NOT NULL` de las dos columnas de caché**: sin eso, los tres estados que
FR-024 exige distinguir **no son representables**. Las columnas eran `integer NOT NULL`, así que un
«no informado» y un «cero medido» aterrizaban los dos como `0`, y la deducción que R15 encarga al
panel —«si en el periodo no hay ni una fila que informe el concepto, sale sin dato»— era imposible
de hacer. `unmeasured_calls` no sirve para esto: cuenta llamadas sin **ningún** dato de consumo, no
distingue concepto por concepto.

**Sobre la convención de «solo añadir»**: quitar un `NOT NULL` es una relajación, no una
reescritura. No edita ninguna migración publicada, no toca ni una fila existente y no pierde ningún
dato: toda fila anterior conserva su valor. Es la única excepción de la feature y está acotada a
estas dos columnas.

**Dos trampas de implementación que esto abre**:

1. **El `CHECK` de tokens existente no hay que tocarlo.** `model_usage_tokens` comprueba
   `cache_write_tokens >= 0`; con el valor a `NULL` la expresión da `NULL`, y un `CHECK` acepta todo
   lo que no sea falso. Sigue valiendo tal cual.
2. **El cálculo del coste sí hay que tocarlo, y si no se toca falla en silencio.** La sentencia de
   `src/usage/meter.ts` suma `cacheWrite * precio + cacheRead * precio`. Con un `NULL` en medio, la
   suma entera da `NULL`, `cost_pico` queda nulo mientras `currency` no lo queda, y eso **viola** la
   restricción `model_usage_cost_currency`. La inserción fallaría, y como el medidor nunca lanza
   —registra `usage_record_failed` y devuelve—, se perdería **todo** el registro de consumo de
   Gemini y OpenAI sin que nadie se enterase. El coste debe tratar el nulo como cero
   (`coalesce(…, 0)`) y **a la vez** persistir `NULL` en la columna del token.

**Efecto en el histórico**: ninguno. Toda fila existente queda con `unmeasured_calls = 0`, que es
exactamente lo que ocurrió: todas sus llamadas informaron tokens. El coste congelado no se toca
(FR-026).

**`formatVersion` no sube** (FR-037): `model_usage` es registro de consumo, no configuración del
negocio, y no entra en la transferencia de configuración. No hay actualizador que escribir.

### Lectura agregada

`src/usage/summary.ts` suma hoy `calls`. Pasa a sumar también `unmeasured_calls`, y a decidir por
periodo si un concepto de caché está **informado**, **no informado** o **parcialmente informado**,
que es lo que el panel necesita para R15. Ahora sí se puede deducir del dato:

| En el periodo | Estado |
|---|---|
| Ninguna fila con el concepto no nulo | **no informado** → «sin dato» |
| Todas las filas con el concepto no nulo | **informado** → la suma |
| Unas sí y otras no | **parcialmente informado** → la suma más la marca de parcial |

La suma ignora los nulos, como hace `sum()` de forma natural, así que un periodo parcial no
subestima lo que sí se midió.

## 3. Estado en memoria

### Estado de la credencial (R6)

Vigilante de dos estados en `src/llm/credential-probe.ts`, con la forma de `src/db/outage.ts`
(016):

```text
ok ──rechazada──▶ degradado ──aceptada──▶ ok
```

- Entrada en `degradado`: una línea de registro, un aviso crítico en `computeWarnings`, y la
  instancia responde solo con el contacto del negocio.
- Mientras `degradado`: reintento cada 5 minutos. **Una** línea de registro al entrar y **una** al
  salir, nunca una por petición.
- `inconclusive` no cambia de estado: deja una línea y nada más.

El estado **no se persiste**: se recalcula al arrancar, igual que los avisos, que nunca se guardan.

## 4. Lo que no cambia

- La tabla de precios y su clave (nombre de modelo). Sin migración, sin cambio de semántica.
- La configuración del negocio: el proveedor no es configuración del negocio y no se transfiere
  entre instancias (FR-009 lo pone en el inventario, que es operador, no negocio).
- Las cuatro causas de fallo del dominio (FR-016).
- El esquema `modelReplySchema`, que sigue siendo la única puerta de validación (FR-014).
