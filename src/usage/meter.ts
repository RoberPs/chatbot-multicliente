/**
 * Registro del consumo del modelo (010, contracts/usage-recording.md; FR-001 – FR-005).
 */
import { eq, sql } from 'drizzle-orm';
import type { ActivityLog, EventContext } from '../conversation/activity-log.js';
import type { Channel } from '../conversation/channels.js';
import type { Db } from '../db/client.js';
import { modelUsage, transcriptionPrice, usageSettings } from '../db/schema.js';
import { localDay } from '../knowledge/time/local-date.js';
import { transcriptionCostPico } from './transcription-cost.js';
import type { UsageRecordInput } from './types.js';

/** Una transcripción hecha (bien o con error tras responder el proveedor), 012 R6. */
export interface TranscriptionRecordInput {
  channel: Channel;
  /** `STT_MODEL`. */
  model: string;
  /** Duración del audio en ms (proveedor → Ogg/Opus → máximo). */
  audioMs: number;
  at: Date;
  timezone: string;
}

export interface UsageMeter {
  /**
   * Nunca lanza: si falla, registra `usage_record_failed` y devuelve (FR-005). `logContext` va
   * solo al registro de actividad, nunca a `model_usage` (FR-003).
   */
  record(input: UsageRecordInput, logContext?: EventContext): Promise<void>;
  /**
   * Consumo de una transcripción (012, R6): `calls = 1`, tokens a 0, `audio_ms` y el coste por
   * minuto congelado. Nunca lanza: si falla, registra `transcription_usage_failed`.
   */
  recordTranscription(input: TranscriptionRecordInput, logContext?: EventContext): Promise<void>;
}

/** Medidor y modelo configurado (`LLM_MODEL`): lo que necesita quien registra. */
export interface UsageRecording {
  meter: UsageMeter;
  model: string;
}

export interface UsageMeterDeps {
  db: Db;
  activityLog: ActivityLog;
}

export function createUsageMeter(deps: UsageMeterDeps): UsageMeter {
  const { db, activityLog } = deps;
  return {
    async record(input, logContext) {
      const { calls, unmeasuredCalls, tokens } = input.usage;
      try {
        // R5: una sola sentencia lee el precio vigente y la moneda y guarda el coste congelado.
        // El producto es `bigint` porque los precios lo son (billonésimas, R4).
        //
        // 017 (FR-024) — las dos mitades de la misma línea, y hacen falta las dos:
        //
        // a) En la **columna del token** se persiste el `NULL` tal cual, porque es lo que distingue
        //    «el proveedor no informa del concepto» de «informa y fue cero».
        // b) En el **cálculo del coste** el nulo cuenta como cero (`coalesce`), porque no hay
        //    tokens que valorar.
        //
        // Si se olvidara (b), la suma entera daría NULL, `cost_pico` quedaría nulo con `currency`
        // no nulo, se violaría `model_usage_cost_currency`, la inserción fallaría y el medidor
        // —que nunca lanza— se comería el error: se perdería **todo** el registro de consumo de los
        // proveedores que no informan de la escritura de caché, en silencio.
        const result = await db.execute(sql`
          insert into model_usage (
            at, day, channel, purpose, model, calls, unmeasured_calls,
            input_tokens, output_tokens, cache_write_tokens, cache_read_tokens,
            cost_pico, currency
          )
          select
            ${input.at.toISOString()}::timestamptz,
            ${localDay(input.at, input.timezone)}::date,
            ${input.channel}::customer_channel,
            ${input.purpose}::usage_purpose,
            ${input.model},
            ${calls}::smallint,
            ${unmeasuredCalls}::smallint,
            ${tokens.input}::integer,
            ${tokens.output}::integer,
            ${tokens.cacheWrite}::integer,
            ${tokens.cacheRead}::integer,
            case when p.model is null then null else
              ${tokens.input}::bigint * p.input_micros_per_mtok
              + ${tokens.output}::bigint * p.output_micros_per_mtok
              + coalesce(${tokens.cacheWrite}::bigint, 0) * p.cache_write_micros_per_mtok
              + coalesce(${tokens.cacheRead}::bigint, 0) * p.cache_read_micros_per_mtok
            end,
            case when p.model is null then null else s.currency end
          from usage_settings s
          left join model_price p on p.model = ${input.model}
          where s.id = 1
        `);
        // Sin la fila única de ajustes no se inserta nada: también es un fallo.
        if (result.rowCount !== 1) throw new Error('usage_settings sin su fila única');
      } catch {
        activityLog.log({ event: 'usage_record_failed', purpose: input.purpose }, logContext);
      }
    },

    async recordTranscription(input, logContext) {
      try {
        await db.transaction(async (tx) => {
          // Precio y moneda leídos en la misma transacción que guarda el coste congelado.
          const [settings] = await tx
            .select({ currency: usageSettings.currency })
            .from(usageSettings)
            .where(eq(usageSettings.id, 1));
          if (!settings) throw new Error('usage_settings sin su fila única');
          const [price] = await tx
            .select({ micros: transcriptionPrice.microsPerMinute })
            .from(transcriptionPrice)
            .where(eq(transcriptionPrice.model, input.model));
          const audioMs = Math.max(0, Math.ceil(input.audioMs));
          const cost = transcriptionCostPico(audioMs, price?.micros ?? null);
          await tx.insert(modelUsage).values({
            at: input.at,
            day: localDay(input.at, input.timezone),
            channel: input.channel,
            purpose: 'transcription',
            model: input.model,
            calls: 1,
            inputTokens: 0,
            outputTokens: 0,
            cacheWriteTokens: 0,
            cacheReadTokens: 0,
            audioMs,
            costPico: cost,
            currency: cost === null ? null : settings.currency,
          });
        });
      } catch {
        activityLog.log({ event: 'transcription_usage_failed' }, logContext);
      }
    },
  };
}
