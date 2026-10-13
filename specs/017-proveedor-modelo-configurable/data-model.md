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
| Tokens de escritura de caché | sí | **no informado** | **no informado** |
| Señal propia de rechazo | sí | sí (bloqueo de seguridad) | sí (elemento de contenido) |

### `TokenUsage` (ampliado)

Hoy: `{ input, output, cacheWrite, cacheRead }`, todos `number`.

**Cambio**: `cacheWrite` y `cacheRead` pasan a `number | null`, donde `null` significa **el
proveedor no informa de este concepto** (FR-024), frente a `0`, que significa cero medido.

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

### Migración `0009_unmeasured_usage.sql` — estrictamente aditiva

```text
ALTER TABLE model_usage
  ADD COLUMN unmeasured_calls smallint NOT NULL DEFAULT 0;

ALTER TABLE model_usage
  ADD CONSTRAINT model_usage_unmeasured
  CHECK (unmeasured_calls >= 0 AND unmeasured_calls <= calls);
```

**Por qué una columna y no `calls = 0`** (R11): la migración publicada `0006_usage.sql` tiene
`CHECK (calls >= 1)`, y las migraciones publicadas no se editan nunca. Quitar ese `CHECK` para
volver a ponerlo no es una migración de solo añadir y dejaría un `calls = 0` cuyo significado
dependería de la fecha de la fila.

**Efecto en el histórico**: ninguno. Toda fila existente queda con `unmeasured_calls = 0`, que es
exactamente lo que ocurrió: todas sus llamadas informaron tokens. El coste congelado no se toca
(FR-026).

**`formatVersion` no sube** (FR-037): `model_usage` es registro de consumo, no configuración del
negocio, y no entra en la transferencia de configuración. No hay actualizador que escribir.

### Lectura agregada

`src/usage/summary.ts` suma hoy `calls`. Pasa a sumar también `unmeasured_calls`, y a decidir por
periodo si un concepto de caché está **informado**, **no informado** o **parcialmente informado**,
que es lo que el panel necesita para R15.

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
