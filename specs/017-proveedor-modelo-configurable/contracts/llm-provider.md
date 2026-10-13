# Contrato: la costura del proveedor del modelo

**Feature**: `017-proveedor-modelo-configurable` | **Fecha**: 2026-10-13

El punto único del dominio donde se decide el proveedor (FR-006, SC-008). Vive en
`src/llm/provider.ts`.

## 1. Interfaz pública

```text
LlmProvider = 'anthropic' | 'gemini' | 'openai'

LLM_PROVIDERS: readonly LlmProvider[]           // los tres, en orden estable
providerDescriptor(p): ProviderDescriptor       // tabla de R1
keyVariableOf(p): string                        // nombre de la variable de credencial
classifyKeyShape(value): LlmProvider | null     // clasificador conservador (R3)

createChatModel(p, opts): ChatModel             // fábrica del puerto de conversación
createSummarizer(p, opts): HandoffSummarizer    // fábrica del puerto de resumen (R12)
```

`opts` es común a los tres proveedores: `{ apiKey, model, effort, client? }`. `client` existe solo
para las pruebas, como ya ocurre hoy.

## 2. Reglas que el contrato garantiza

| # | Regla | Requisito |
|---|---|---|
| C1 | Nadie fuera de `src/llm/` nombra una variable de credencial de un proveedor concreto | FR-006, SC-008 |
| C2 | Nadie fuera de `src/llm/` importa el SDK de un proveedor | FR-023 |
| C3 | Los dos puertos se construyen por la misma fábrica y con el mismo proveedor | FR-013a |
| C4 | `classifyKeyShape` devuelve `null` ante una forma que no reconoce, nunca un proveedor «probable» | R3 |
| C5 | Un `LlmProvider` no elegible no se construye: falla antes, con los tres nombres en el mensaje | FR-002 |

**C1 y C2 se vigilan con una prueba estática**, al estilo de la que la 016 usa para los ocho puntos
que abren conexiones: recorre `src/`, excluye `src/llm/`, y falla si encuentra el nombre de una
variable de credencial o un importe de un SDK de proveedor.

## 3. Traducción por proveedor

Lo que cada adaptador debe garantizar, con independencia de cómo lo consiga.

### 3.1 Forma de la respuesta

| Garantía | Obligatoriedad |
|---|---|
| La respuesta devuelta valida contra `modelReplySchema` | **Siempre.** Es la única puerta (FR-014) |
| Los valores por defecto del dominio se aplican igual en los tres | **Siempre** (ver OpenAI, R7) |
| Una respuesta que no valida lanza `ChatModelError('invalid_output')` | **Siempre.** Nunca llega al cliente |

### 3.2 Esfuerzo

| Proveedor | Comportamiento exigido |
|---|---|
| `anthropic` | `low`/`medium`/`high` se envían tal cual |
| `gemini` | `low`/`medium`/`high` se envían como nivel de razonamiento; `minimal` no se usa |
| `openai` | se envía como esfuerzo de razonamiento; si el modelo no lo admite, se reintenta **una vez** sin el parámetro, se anota y se recuerda para el resto del proceso |

En los tres, si el ajuste no tiene efecto, queda **una** línea en el arranque. No se rechaza ni se
silencia (FR-017).

### 3.3 Causas de fallo

Tabla cerrada. Ningún adaptador puede devolver otra cosa (FR-016).

| Situación del proveedor | Causa del dominio |
|---|---|
| Rechazo explícito (cualquiera de las tres señales de R10) | `refusal` |
| Plazo agotado, o aborto por nuestra señal | `timeout` |
| No es JSON, no valida con Zod, o viene truncado por tope de salida | `invalid_output` |
| Cualquier otro fallo del proveedor | `api_error` (con el código HTTP si lo hay) |

**Trampa a cubrir con prueba**: en OpenAI el rechazo llega con el estado en `completed`. Un
adaptador que mire solo el estado lo tomará por una respuesta válida vacía.

### 3.4 Consumo

| Concepto | Obligatoriedad |
|---|---|
| `input` y `output` | **Siempre** que el proveedor informe. En Gemini, `output` incluye los tokens de razonamiento, que vienen aparte y hay que sumar |
| `cacheRead` | número si el proveedor lo informa; `null` si no |
| `cacheWrite` | número solo en `anthropic`; `null` en los otros dos |
| Respuesta sin ninguna información de consumo | `onUsage` **no** se llama, y el responder registra la llamada como no medida (FR-025) |

`onUsage` se llama **una vez por llamada que informó tokens**, antes de devolver o lanzar, como ya
exige el puerto hoy.

## 4. Variables de entorno

| Variable | Validación |
|---|---|
| `LLM_PROVIDER` | uno de los tres; ausente ⇒ `anthropic` (FR-003) |
| `<PROVEEDOR>_API_KEY` | obligatoria para el proveedor declarado; su ausencia falla nombrando la variable (FR-005) |
| `LLM_MODEL` | obligatoria salvo con `anthropic`, que conserva su valor por defecto |
| `LLM_EFFORT` | `low`/`medium`/`high`, sin cambios |

**Credenciales de otros proveedores presentes**: se ignoran para funcionar y se avisan en la
comprobación previa (FR-033). Nunca se usan como respaldo (FR-004).
