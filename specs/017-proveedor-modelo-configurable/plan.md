# Implementation Plan: Proveedor del modelo configurable por instancia

**Branch**: `017-proveedor-modelo-configurable` | **Date**: 2026-10-13 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/017-proveedor-modelo-configurable/spec.md`

**Ámbito**: Núcleo (afecta a todas las instancias)

## Summary

Permitir que cada instancia elija su proveedor de modelo —Anthropic, Gemini u OpenAI— declarándolo
en su fichero de entorno, sin que el dominio, los canales ni el panel sepan quién hay detrás. De
paso, cerrar el fallo por el que una credencial equivocada pasa la puerta de calidad y luego falla
en silencio delante de cada cliente.

Enfoque técnico (detalle en [research.md](research.md)):

1. **Un punto único de costura** (R1). `src/llm/provider.ts`: el tipo cerrado de proveedor, la tabla
   de variables de credencial, el clasificador de formas y las **dos** fábricas. Lo que estaba
   filtrado por 15 ficheros no era la llamada al modelo —el puerto `ChatModel` ya era la frontera
   correcta— sino el nombre de la variable y la construcción del adaptador.
2. **Hay dos puertos de proveedor, no uno** (R12). Además de `ChatModel` existe
   `HandoffSummarizer`, que resume al derivar al negocio. Si solo se migrase el primero, una
   instancia con Gemini conversaría bien y **fallaría justo al derivar a una persona**, que es lo
   que protege el Principio V. La spec no lo nombraba: se le añadió FR-013a.
3. **Tres dialectos del mismo JSON Schema** (R7). El problema real es OpenAI: su modo estricto **no
   admite propiedades opcionales** y `modelReplySchema` tiene opcionales. Se resuelve en el
   adaptador —promover a requerido admitiendo `null` y normalizar a la vuelta—, sin tocar el
   esquema del dominio, que sigue siendo la única puerta.
4. **El agujero ya tenía una comprobación: era un aviso** (R4). `llm_key_format` existe y comprueba
   el prefijo `sk-ant-`, pero se emite como `'warning'`, así que `instance:check` **pasa**. No hace
   falta un mecanismo nuevo: hace falta un código nuevo con severidad de **error** y consciente del
   proveedor. El cambio es más pequeño y más verificable de lo que parecía.
5. **La forma de la credencial caza el error humano; la red caza el resto** (R3, R5, R6). El
   clasificador de prefijos es conservador —solo da veredicto ante otro proveedor elegible, nunca
   rechaza lo que no reconoce— porque los prefijos **cambian**: Gemini está pasando de `AIza` a
   `AQ.`. La defensa que no envejece es la verificación con una petición de listado de modelos, que
   no genera tokens, y que se usa en dos sitios con decisiones distintas: opcional en
   `instance:check`, **siempre** y no fatal en el arranque.
6. **El arranque degrada, no muere** (R6). Es la lección del Fallo 1 de la 016: una credencial
   rechazada no puede producir un bucle de reinicio. La instancia arranca, entra en degradado
   declarado reutilizando el camino del «modelo sin precio», levanta un aviso crítico y reintenta
   cada 5 minutos hasta salir sola.
7. **Cero medido y «sin dato» dejan de ser lo mismo** (R11). `cacheWrite` no lo informan ni Gemini
   ni OpenAI. Y una respuesta sin información de consumo hoy **no deja registro ninguno**, que es un
   cero silencioso justo donde vive el tope de gasto. La migración añade `unmeasured_calls` —no vale
   `calls = 0`, que lo prohíbe un `CHECK` ya publicado y no editable— **y quita el `NOT NULL` de las
   dos columnas de caché**, sin lo cual los tres estados que FR-024 exige distinguir no son
   representables y la deducción del panel es imposible. Es la única excepción de la feature a la
   convención de solo añadir: relaja, no reescribe.
8. **Trampa de implementación cara de encontrar** (R11): en Gemini los tokens de razonamiento vienen
   **aparte** de los de salida. No sumarlos subestima el consumo y hace que el tope proteja menos de
   lo que cree.

## Technical Context

**Language/Version**: TypeScript 5 (strict), Node.js 22, pnpm 9

**Primary Dependencies**: Fastify 5, Drizzle ORM + drizzle-kit, Zod, Eta + htmx,
libphonenumber-js, `@anthropic-ai/sdk` (ya presente) y **dos dependencias nuevas**: `openai` y
`@google/genai` (R16, versiones fijadas)

**Storage**: PostgreSQL 16, una BD por instancia, sin `tenant_id`. Una migración
(`0009_unmeasured_usage.sql`): aditiva, más la relajación del `NOT NULL` de las dos columnas de
caché que FR-024 hace imprescindible

**Testing**: Vitest — unitarias, de contrato (`fastify.inject`) e integración (Testcontainers).
Dobles de proveedor en `tests/fixtures/llm/`, sin red ni credenciales (R13). `pnpm test:eval` con
modelo real, **obligatoria por proveedor** y fuera de `pnpm test`

**Target Platform**: Linux (contenedor en VPS), desarrollo en Windows

**Project Type**: servicio web con panel de operador renderizado en servidor

**Performance Goals**: se conserva el plazo de respuesta del dominio por respuesta y el presupuesto
compartido entre los dos intentos; el plazo de la verificación de credencial es 5 s y no entra en el
presupuesto de la respuesta

**Constraints**: la verificación de credencial no debe generar tokens (FR-031); el arranque no puede
ser fatal por ella (FR-005a); `pnpm test` debe seguir pasando sin red ni credenciales (FR-038)

**Scale/Scope**: 15 ficheros de `src/` y 28 de `tests/` nombran hoy la variable de credencial; 2
instancias en producción, las dos seguirán con Anthropic; se despliega como **0.1.3**

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principio | Veredicto | Justificación |
|---|---|---|
| **I · Base común única** | **Pasa** | El proveedor no es un sector ni un cliente: es una capacidad genérica del núcleo, igual para todas las instancias. No se introduce ninguna rama por tipo de negocio. La prueba estática del contrato vigila además que ningún nombre de proveedor se filtre fuera de `src/llm/` |
| **II · Configuración antes que código** | **Pasa** | La elección se expresa en el entorno de la instancia, sin cambios de código ni imagen distinta (SC-001). Se evaluó cubrirlo con configuración del negocio y se descartó: el proveedor y su credencial son operación, no datos del negocio, y no deben viajar en la transferencia de configuración |
| **III · Personalizaciones aisladas** | **Pasa** | Spec de núcleo, genérica. No es una extensión de ningún cliente y no menciona ninguno |
| **IV · Solo información registrada** | **Pasa, con prueba obligatoria** | La regla vive en `groundingGuard`, sobre la respuesta ya normalizada, así que es independiente del proveedor. Pero el Flujo de desarrollo exige prueba antes de cerrar: se verifica con los tres proveedores (quickstart §2) **y** con la evaluación por proveedor (§6) |
| **V · Siempre hay salida a una persona** | **Pasa, y es el riesgo principal** | Dos puntos de atención. (a) El resumen de derivación usa el proveedor (FR-013a): si fallara, la salida a una persona se rompe en el peor momento. (b) Una credencial rechazada **no** puede matar el proceso, porque un proceso muerto no deja salida ninguna: de ahí que FR-005a sea no fatal |
| **VI · El operador registra la información** | **Pasa** | La elección de proveedor y su credencial son del operador, en el fichero de entorno. El negocio no las ve ni las puede cambiar |

**Restricciones del producto**: todos los canales conservan la misma cadena de respuesta, porque el
cambio queda por debajo del puerto del modelo. El aislamiento entre instancias no se toca: cada una
declara su proveedor y su credencial en su propio entorno.

**Re-evaluación tras la Fase 1**: sin cambios. El diseño no introduce ninguna desviación que haya
que justificar, así que **Complexity Tracking queda vacío**. Las dos dependencias nuevas se
justifican en R16 y quedan contenidas en `src/llm/`.

## Project Structure

### Documentation (this feature)

```text
specs/017-proveedor-modelo-configurable/
├── plan.md                              # Este fichero
├── research.md                          # Fase 0: R1–R16
├── data-model.md                        # Fase 1
├── quickstart.md                        # Fase 1: recorridos de validación
├── contracts/
│   ├── llm-provider.md                  # La costura y la traducción por proveedor
│   ├── credential-verification.md       # Los dos consumidores de la verificación
│   └── usage-unmeasured.md              # Consumo no medido y «sin dato»
├── checklists/
│   └── requirements.md
└── tasks.md                             # Fase 2 (/speckit-tasks)
```

### Source Code (repository root)

```text
src/
├── llm/                                 # ÚNICO sitio que sabe de proveedores
│   ├── provider.ts                      # NUEVO · costura: tipo, tabla, clasificador, fábricas
│   ├── credential-probe.ts              # NUEVO · verificación + vigilante de reintento
│   ├── reply-schema.ts                  # NUEVO · los tres dialectos del JSON Schema
│   ├── anthropic-chat-model.ts          # se reduce: el esquema sale de reply-schema
│   ├── gemini-chat-model.ts             # NUEVO
│   ├── openai-chat-model.ts             # NUEVO
│   ├── anthropic-summarizer.ts          # sin cambios de fondo
│   ├── gemini-summarizer.ts             # NUEVO
│   ├── openai-summarizer.ts             # NUEVO
│   ├── token-usage.ts                   # deja de importar tipos del SDK de Anthropic
│   ├── prompt.ts                        # sin cambios
│   └── summary-prompt.ts                # sin cambios
├── conversation/
│   ├── ports.ts                         # TokenUsage admite null en los dos conceptos de caché
│   └── responder.ts                     # cuenta llamadas no medidas y registra siempre
├── usage/
│   ├── types.ts                         # ResponseUsage gana unmeasuredCalls
│   ├── meter.ts                         # escribe unmeasured_calls
│   ├── summary.ts                       # agrega el recuento y decide informado/parcial/sin dato
│   └── protection.ts                    # estado nuevo: credencial rechazada → degradado + crítico
├── config/
│   ├── env.ts                           # LLM_PROVIDER, las tres credenciales, LLM_MODEL obligatoria fuera de Anthropic
│   └── secret-rules.ts                  # la calidad se aplica a la variable del proveedor declarado
├── provisioning/
│   ├── check.ts                         # llm_key_other_provider como ERROR; bandera de validación
│   ├── secrets.ts                       # el clasificador consciente del proveedor
│   ├── messages.ts                      # códigos nuevos y sus textos
│   ├── fingerprint.ts                   # la credencial del modelo es el mismo secreto en las tres variables
│   └── generate.ts                      # instance:new emite la variable del proveedor elegido
├── admin/
│   ├── views/usage.eta                  # «sin dato» ≠ 0, totales incompletos marcados
│   ├── views/playground.eta             # deja de nombrar la variable de Anthropic
│   ├── routes/{playground,web-chat}.ts  # idem
│   └── fastify-types.ts                 # idem
├── channels/web/api.ts                  # predicado genérico «hay credencial del modelo»
├── webchat/availability.ts              # idem; reutiliza el motivo no_bot
├── db/migrations/0009_unmeasured_usage.sql   # NUEVO · aditiva
├── bot.ts                               # construye por fábrica y lanza la comprobación del arranque
└── cli/
    ├── bot-chat.ts                      # cualquier proveedor
    └── instance.ts                      # bandera --validar-credencial

tests/
├── fixtures/llm/                        # NUEVO · un doble por proveedor, con la forma real
├── unit/llm/                            # clasificador, dialectos, traducción de fallos, consumo
├── unit/provisioning/                   # severidades nuevas y regresión del aviso actual
├── contract/                            # panel y chat web sin rastro de proveedor
└── integration/                         # arranque degradado y recuperación sola
```

**Structure Decision**: se conserva la estructura del proyecto. El dominio
(`src/knowledge`, `src/conversation`, `src/webchat`) sigue sin depender de HTTP ni de ningún SDK, y
toda la novedad vive en `src/llm/`, que es la capa de adaptadores del modelo. Los tres ficheros
nuevos de `src/llm/` son el precio de tener la costura en un punto único.

## Orden de implementación sugerido

El orden importa porque hay una dependencia fuerte: nada se puede probar con tres proveedores hasta
que exista la costura.

1. **Costura y dialectos** (R1, R7) con Anthropic como único proveedor. Al final de este paso el
   comportamiento es **idéntico** al de hoy y la suite entera sigue en verde: es refactor puro, y es
   el punto de control más valioso de la feature.
2. **Consumo** (R11): `null` en los conceptos de caché, `unmeasuredCalls`, la migración aditiva y la
   presentación. Todavía con un solo proveedor, así que todo lo nuevo se prueba contra cero riesgo.
3. **Los dos adaptadores nuevos** y sus dobles (R13), puerto por puerto: primero `ChatModel`,
   después `HandoffSummarizer`.
4. **Verificación de credencial** (R3, R4, R5, R6): clasificador, severidades de la comprobación
   previa, bandera opcional y comprobación del arranque con su vigilante.
5. **Panel, canales y aprovisionamiento**: limpiar lo que todavía nombre la variable de Anthropic,
   hasta que la prueba estática del contrato pase.
6. **Documentación y evaluación**: tabla de capacidades, `pnpm test:eval` por proveedor, y las
   anotaciones de `docs/operacion-multicliente.md` y `README.md`.

## Riesgos y cómo se acotan

| Riesgo | Acotación |
|---|---|
| Los prefijos de credencial cambian (Gemini ya lo está haciendo) | Clasificador conservador en una sola tabla; nunca rechaza lo no reconocido (R3) |
| Un proveedor no exige credencial para listar modelos, y un 2xx no probaría nada | Se verifica proveedor a proveedor que una credencial inválida da 401/403, con prueba; si alguno no cumple, se usa la generación más pequeña y se anota el coste (R5) |
| `LLM_EFFORT=medium` no significa lo mismo en los tres | Evaluación obligatoria por proveedor; si falla, esfuerzo propio documentado y reevaluación; si sigue fallando, proveedor no elegible (R14, FR-036) |
| El modo estricto de OpenAI choca con los campos opcionales | Dialecto propio en el adaptador, con normalización a la vuelta; el dominio no se toca (R7) |
| Los dobles prueban nuestra traducción, no la API real | Es una limitación aceptada y declarada: la cubren la evaluación y los recorridos a mano (R13, quickstart §2 y §4) |
| 28 ficheros de pruebas nombran la variable de Anthropic | El paso 1 es refactor puro con la suite en verde, así que el coste se paga de una vez y con red de seguridad |
| Dos dependencias nuevas | Contenidas en `src/llm/`, versiones fijadas, y en esta máquina hay que comprobar el certificado de npm antes de instalar (R16) |

## Lo que este plan añadió a la spec

- **FR-013a** (nuevo): el resumen de derivación también tiene que funcionar con los tres
  proveedores. El hallazgo es de R12 y no estaba en la spec; sin él, la implementación habría dejado
  roto el Principio V justo en el momento de derivar.
- **La cadencia del reintento** que la spec dejó cualitativa queda en **5 minutos**, razonada en R6
  y ya trasladada al caso límite de la spec tras el análisis.
- **FR-025b se concreta**: la migración es una columna aditiva `unmeasured_calls`, porque `calls = 0`
  lo prohíbe un `CHECK` publicado que no se puede editar (R11).
