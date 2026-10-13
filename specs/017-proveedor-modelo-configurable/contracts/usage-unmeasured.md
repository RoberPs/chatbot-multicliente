# Contrato: consumo no medido y presentación del «sin dato»

**Feature**: `017-proveedor-modelo-configurable` | **Fecha**: 2026-10-13

Qué se registra y qué se muestra cuando el proveedor no informa de lo que el medidor cuenta
(FR-022 a FR-025b, FR-027, FR-024).

## 1. Tres estados por concepto, no dos

| Estado | Significado | Cómo se representa |
|---|---|---|
| Medido | el proveedor informó un número | el número, y `unmeasured_calls` no crece |
| Medido en cero | el proveedor informó explícitamente cero | `0`, con `unmeasured_calls` sin crecer |
| **No informado** | el proveedor no informa de este concepto | `null` en `TokenUsage`; en la fila, el concepto queda a 0 pero sin fila que lo informe |
| **No medido** | el proveedor no informó **nada** de esa llamada | `unmeasured_calls` crece y los tokens quedan a 0 |

La distinción que importa: **cero medido** y **no informado** no pueden salir iguales en el panel
(FR-024), y **consumo cero** y **no medido** no pueden salir iguales en el registro (FR-025b).

## 2. Registro

### 2.1 Qué hace el responder

Hoy, si el proveedor no informa tokens, `onUsage` no se llama, `usage` queda sin definir y la
respuesta sale **sin registro de consumo**. Eso es el cero silencioso.

**A partir de ahora**: toda llamada con respuesta cuenta en `calls`, y la que no informó tokens
cuenta además en `unmeasuredCalls`. El registro se escribe **siempre** que haya habido al menos una
llamada con respuesta, aunque ninguna informara tokens.

### 2.2 Qué llega a `model_usage`

| Columna | Valor |
|---|---|
| `calls` | llamadas con respuesta (≥ 1) |
| `unmeasured_calls` | de esas, las que no informaron tokens (≥ 0, ≤ `calls`) |
| `input_tokens`, `output_tokens`, `cache_*_tokens` | la suma de lo informado; 0 donde no hubo nada |
| `cost_pico`, `currency` | el coste congelado con el precio vigente, como hoy |

**Coste de una llamada no medida**: 0, porque no hay tokens que valorar. Esto **no** es un coste
real de 0 y por eso el aviso existe: lo que el panel dice es «hubo consumo que no se pudo valorar»,
no «ese consumo fue gratis».

### 2.3 Lo que no cambia

El coste se congela en el momento del consumo y el histórico no se recalcula nunca, ni al cambiar de
proveedor (FR-026). La columna nueva deja todo lo ya registrado con `unmeasured_calls = 0`, que es
exactamente lo que pasó.

## 3. Avisos

| Condición | Severidad | Texto (idea) |
|---|---|---|
| Hay consumo no medido **y** el tope de gasto está activado **y** el negocio está activo | **crítico** | el tope de gasto no puede garantizarse: hubo respuestas cuyo consumo el modelo no informó |
| Hay consumo no medido en cualquier otro caso | aviso | hubo respuestas cuyo consumo el modelo no informó |

**Este aviso es una alarma, no un bloqueo** (FR-025a): nace de una respuesta del bot, no de una
escritura del operador, así que **no** revierte ninguna transacción ni impide al operador seguir
trabajando. La regla de revertir una escritura que deja un aviso crítico se aplica a las escrituras
de configuración, y esta no es una.

Se calcula con `computeWarnings(state)` cada vez y no se guarda nunca, como todos los demás.

## 4. Presentación en el panel

### 4.1 Reglas

| Caso en el periodo | Lo que se muestra |
|---|---|
| El concepto tiene al menos una fila que lo informa | el número |
| Ninguna fila del periodo informa el concepto | **«sin dato»**, con nota genérica |
| Unas filas lo informan y otras no | el número **más** la marca de parcial |
| Hay `unmeasured_calls > 0` en el periodo | el recuento de respuestas no medidas, visible |

La nota genérica dice que **el modelo configurado** no informa de ese dato. **No** nombra al
proveedor (FR-008).

### 4.2 Totales

Lo no informado **no se suma como cero** (FR-024, SC-012). Un total que incluye un concepto «sin
dato» se marca como incompleto en lugar de presentarse como exacto.

### 4.3 Cómo lo sabe el panel sin saber el proveedor

Se deduce de lo registrado, no del nombre del proveedor: si en el periodo no hay ni una fila con
escritura de caché informada, el concepto sale como «sin dato». Así no hace falta pasar la identidad
del proveedor a la capa de presentación, que es lo que FR-006 prohíbe.

## 5. Interacción con el tope de gasto

El tope sigue funcionando igual sobre lo que **sí** está medido: suma coste congelado y compara.
Lo que la feature añade es que el operador **sabe** cuándo esa suma es incompleta, en lugar de
confiar en un total que parecía exacto. El aviso de «modelo sin precio» y su degradación a solo
contacto del negocio no cambian (FR-027).
