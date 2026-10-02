/**
 * Registro del consumo del modelo (010, contracts/usage-recording.md; FR-001 – FR-005).
 */
import { sql } from 'drizzle-orm';
import type { ActivityLog, EventContext } from '../conversation/activity-log.js';
import type { Db } from '../db/client.js';
import { localDay } from '../knowledge/time/local-date.js';
import type { UsageRecordInput } from './types.js';

export interface UsageMeter {
  /**
   * Nunca lanza: si falla, registra `usage_record_failed` y devuelve (FR-005). `logContext` va
   * solo al registro de actividad, nunca a `model_usage` (FR-003).
   */
  record(input: UsageRecordInput, logContext?: EventContext): Promise<void>;
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
      const { calls, tokens } = input.usage;
      try {
        // R5: una sola sentencia lee el precio vigente y la moneda y guarda el coste congelado.
        // El producto es `bigint` porque los precios lo son (billonésimas, R4).
        const result = await db.execute(sql`
          insert into model_usage (
            at, day, channel, purpose, model, calls,
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
            ${tokens.input}::integer,
            ${tokens.output}::integer,
            ${tokens.cacheWrite}::integer,
            ${tokens.cacheRead}::integer,
            case when p.model is null then null else
              ${tokens.input}::bigint * p.input_micros_per_mtok
              + ${tokens.output}::bigint * p.output_micros_per_mtok
              + ${tokens.cacheWrite}::bigint * p.cache_write_micros_per_mtok
              + ${tokens.cacheRead}::bigint * p.cache_read_micros_per_mtok
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
  };
}
