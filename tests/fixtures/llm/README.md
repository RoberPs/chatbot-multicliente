# Dobles de proveedor de modelo

Un doble por proveedor (`anthropic`, `gemini`, `openai`). Cada uno sustituye al cliente del SDK
por la opción `client` que los adaptadores ya aceptan, así que **ninguna prueba hace red ni lee
una credencial real** (FR-038, SC-011).

## Por qué reproducen la forma real de cada API

Un doble que devolviese «la forma que le conviene al adaptador» no probaría nada: pasaría siempre,
porque estaría describiendo al adaptador en lugar de al proveedor. Lo que estas pruebas verifican
es **nuestra traducción**, y la traducción solo se puede verificar contra la forma real de la
respuesta del proveedor (research R13).

Por eso cada doble copia los nombres de campo exactos, con sus trampas:

| Proveedor | Lo que el doble reproduce y que es fácil equivocar |
|---|---|
| `anthropic` | `usage` con los cuatro conceptos; el campo de escritura de caché **ausente** cuando la respuesta no escribió nada, que es un **cero medido**, no un «sin dato» |
| `gemini` | `usageMetadata` con `thoughtsTokenCount` **aparte** de `candidatesTokenCount`: hay que sumarlo o el consumo de salida se subestima |
| `openai` | el rechazo como **elemento de contenido** `type: 'refusal'`, con el estado de la respuesta en `completed`: mirar solo el estado lo toma por una respuesta válida vacía |

## Lo que los dobles no pueden probar

Que los nombres de campo copiados aquí **sigan siendo** los de la API. Eso lo cubren la evaluación
con modelo real (`pnpm test:eval`, una corrida por proveedor) y los recorridos a mano del
quickstart. Es una limitación conocida y aceptada.
