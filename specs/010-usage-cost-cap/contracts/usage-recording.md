# Contrato: medición del consumo

**Feature**: 010-usage-cost-cap · FR-001 – FR-006 · research R1 – R3, R5, R6

## Puertos

```ts
// src/conversation/ports.ts
interface ChatModel {
  reply(
    input: ReplyContext,
    opts: { signal: AbortSignal; feedback?: string; onUsage?: (u: TokenUsage) => void },
  ): Promise<ModelReply>;
}

// src/handoff/ports.ts
interface HandoffSummarizer {
  summarize(
    input: { kind: HandoffKind; customerTexts: string[] },
    opts: { signal: AbortSignal; onUsage?: (u: TokenUsage) => void },
  ): Promise<{ summary: string }>;
}
```

**Obligaciones del adaptador** (Anthropic):

| Situación | `onUsage` |
|---|---|
| Respuesta válida | una vez, con `response.usage` |
| Respuesta recibida y descartada (`refusal`, `max_tokens`, JSON no válido, esquema no válido) | una vez, con `response.usage`, **antes** de lanzar |
| Error HTTP, corte de red, plazo agotado o abortado sin respuesta | no se llama |

`TokenUsage` = `{ input: input_tokens, output: output_tokens, cacheWrite:
cache_creation_input_tokens ?? 0, cacheRead: cache_read_input_tokens ?? 0 }`.

## `UsageMeter` (`src/usage/meter.ts`)

```ts
interface UsageMeter {
  /** Nunca lanza: si falla, registra `usage_record_failed` y devuelve. */
  record(input: {
    channel: Channel;
    purpose: 'reply' | 'handoff_summary';
    model: string;
    usage: ResponseUsage;   // calls ≥ 1
    at: Date;
    timezone: string;       // zona del snapshot → `day`
  }): Promise<void>;
}
```

- Una sola sentencia `INSERT … SELECT` con el precio vigente y la moneda de `usage_settings`
  (research R5).
- No recibe ni guarda conversación, cliente, textos ni IP; el tipo no tiene campos para ellos
  (FR-003). Un test recorre las columnas de `model_usage` y falla si aparece una nueva que no esté en
  la lista permitida.

## Quién registra

| Origen | Canal | `purpose` | Momento |
|---|---|---|---|
| Procesador, respuesta con modelo (incluido `R-SAFE` y `R-ERR` si hubo tokens) | el de la conversación | `reply` | tras `responder.respond`, antes de `deliver` |
| `HandoffService.start` con `modelSummary: true` | el de la conversación | `handoff_summary` | tras `summarizeHandoff` |
| "Probar el bot" | `playground` | ambos | igual que arriba (misma cadena) |

**No registran**: plantillas sin modelo (`R-MEDIA`, `R-AUDIO`, `R-LIMIT`, `R-UNAVAILABLE`, `R-CAP`,
`R-ERR` por snapshot ilegible), reenvíos de una derivación activa, `pnpm bot:chat` y
`pnpm test:eval` (no pasan un `UsageMeter`).

## Registro de actividad

| Evento | Nivel | Campos |
|---|---|---|
| `usage_record_failed` | `error` | `purpose` (+ contexto habitual: `via`, seudónimo, `conversationId`, que van al log, nunca a `model_usage`) |
