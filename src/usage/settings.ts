/**
 * Precios por modelo y ajustes de consumo (010, data-model.md §1 y §4; FR-013, FR-014, R13).
 * Se leen sin caché; cada guardado va en su transacción y marca `updated_at`. No es configuración
 * del negocio: no toca el snapshot, los avisos ni la exportación de la 008.
 */
import { asc, eq, sql } from 'drizzle-orm';
import type { DbOrTx } from '../conversation/repositories/customer.js';
import type { Db } from '../db/client.js';
import { business, modelPrice, transcriptionPrice, usageSettings } from '../db/schema.js';
import { touch } from '../db/timestamps.js';
import { FieldConflictError, NotFoundError } from '../knowledge/errors.js';
import type { ProtectionConfig } from './protection.js';
import {
  CAP_REQUIRED_MESSAGE,
  capWithoutPriceMessage,
  currencyLockedMessage,
  PRICE_IN_USE_MESSAGE,
  priceSchema,
  transcriptionPriceSchema,
  usageSettingsSchema,
  whatsappCapSchema,
  type TranscriptionPrice,
} from './schemas.js';
import type { ModelPrice, UsageSettings } from './types.js';

/**
 * Producción y negocio activo: entonces no se puede quitar lo que acota el gasto (012, FR-003).
 * Sin `protection` (herramientas y pruebas antiguas) no se aplica.
 */
async function guarded(tx: DbOrTx, protection: ProtectionConfig | undefined): Promise<boolean> {
  if (!protection?.production) return false;
  const [row] = await tx
    .select({ status: business.status })
    .from(business)
    .where(eq(business.id, 1));
  return row?.status === 'active';
}

/** Valores de la migración: USD y tope desactivado. */
export const defaultUsageSettings: UsageSettings = {
  currency: 'USD',
  capEnabled: false,
  monthlyCapCents: null,
};

export async function readUsageSettings(tx: DbOrTx): Promise<UsageSettings> {
  const [row] = await tx
    .select({
      currency: usageSettings.currency,
      capEnabled: usageSettings.capEnabled,
      monthlyCapCents: usageSettings.monthlyCapCents,
    })
    .from(usageSettings)
    .where(eq(usageSettings.id, 1));
  return row ?? defaultUsageSettings;
}

const priceColumns = {
  model: modelPrice.model,
  inputMicros: modelPrice.inputMicrosPerMtok,
  outputMicros: modelPrice.outputMicrosPerMtok,
  cacheWriteMicros: modelPrice.cacheWriteMicrosPerMtok,
  cacheReadMicros: modelPrice.cacheReadMicrosPerMtok,
};

/** Precios vigentes, por nombre de modelo. */
export function listPrices(tx: DbOrTx): Promise<ModelPrice[]> {
  return tx.select(priceColumns).from(modelPrice).orderBy(asc(modelPrice.model));
}

/** Hay precio para el modelo (FR-014, FR-021). */
export async function hasPrice(tx: DbOrTx, model: string): Promise<boolean> {
  const [row] = await tx
    .select({ model: modelPrice.model })
    .from(modelPrice)
    .where(eq(modelPrice.model, model));
  return row !== undefined;
}

/** Alta o cambio del precio de un modelo. Los registros anteriores no cambian (FR-011). */
export async function upsertPrice(db: Db, input: unknown): Promise<ModelPrice> {
  const price = priceSchema.parse(input);
  const values = {
    inputMicrosPerMtok: price.inputMicros,
    outputMicrosPerMtok: price.outputMicros,
    cacheWriteMicrosPerMtok: price.cacheWriteMicros,
    cacheReadMicrosPerMtok: price.cacheReadMicros,
  };
  await db.transaction(async (tx) => {
    await tx
      .insert(modelPrice)
      .values({ model: price.model, ...values })
      .onConflictDoUpdate({ target: modelPrice.model, set: { ...values, ...touch() } });
  });
  return price;
}

/**
 * Borra el precio de un modelo. Se permite aunque sea el del modelo actual con el tope activo: el
 * panel pasa a avisar de que su consumo no cuenta (FR-021). En producción con el negocio activo,
 * el de `LLM_MODEL` no se puede borrar (012, FR-003).
 */
export async function deletePrice(
  db: Db,
  model: string,
  protection?: ProtectionConfig,
): Promise<void> {
  await db.transaction(async (tx) => {
    const name = model.trim();
    if (name === protection?.llmModel && (await guarded(tx, protection))) {
      throw new FieldConflictError('prices', PRICE_IN_USE_MESSAGE);
    }
    const rows = await tx
      .delete(modelPrice)
      .where(eq(modelPrice.model, name))
      .returning({ model: modelPrice.model });
    if (rows.length === 0) throw new NotFoundError('Precio');
  });
}

/** Hay alguna fila en las tablas de precios (bloquea el cambio de moneda, 010 R13). */
async function hasAnyPrice(tx: DbOrTx): Promise<boolean> {
  const [count] = await tx
    .select({
      // `count(*)` es `bigint`: llega como texto.
      n: sql<string>`(select count(*) from ${modelPrice}) + (select count(*) from ${transcriptionPrice})`,
    })
    .from(usageSettings)
    .where(eq(usageSettings.id, 1));
  return Number(count?.n ?? 0) > 0;
}

/**
 * Guarda moneda y tope. Cambiar la moneda exige las tablas de precios vacías (R13, y desde la 012
 * también la de transcripción); activar el tope exige precio para `currentModel` (FR-014); en
 * producción con el negocio activo no se puede desactivar (012, FR-003). Sin importe en el
 * formulario se conserva el guardado.
 */
export async function saveUsageSettings(
  db: Db,
  input: unknown,
  currentModel: string,
  protection?: ProtectionConfig,
): Promise<UsageSettings> {
  const values = usageSettingsSchema.parse(input);
  return db.transaction(async (tx) => {
    const before = await readUsageSettings(tx);
    if (values.currency !== before.currency && (await hasAnyPrice(tx))) {
      throw new FieldConflictError('currency', currencyLockedMessage(before.currency));
    }
    if (!values.capEnabled && (await guarded(tx, protection))) {
      throw new FieldConflictError('capEnabled', CAP_REQUIRED_MESSAGE);
    }
    if (values.capEnabled && !(await hasPrice(tx, currentModel))) {
      throw new FieldConflictError('capEnabled', capWithoutPriceMessage(currentModel));
    }
    const saved: UsageSettings = {
      currency: values.currency,
      capEnabled: values.capEnabled,
      monthlyCapCents: values.monthlyCapCents ?? before.monthlyCapCents,
    };
    await tx
      .update(usageSettings)
      .set({ ...saved, ...touch() })
      .where(eq(usageSettings.id, 1));
    return saved;
  });
}

// ---------------------------------------------------------------------------
// Tope diario de WhatsApp y precios de transcripción (012, R5 y R6)
// ---------------------------------------------------------------------------

/** Tope diario de respuestas de WhatsApp con modelo (sin caché). */
export async function readWhatsappCap(tx: DbOrTx): Promise<number> {
  const [row] = await tx
    .select({ cap: usageSettings.whatsappDailyCap })
    .from(usageSettings)
    .where(eq(usageSettings.id, 1));
  return row?.cap ?? 200;
}

/** Guarda el tope diario de WhatsApp (1–10 000). Vale desde el siguiente mensaje. */
export async function saveWhatsappCap(db: Db, input: unknown): Promise<number> {
  const cap = whatsappCapSchema.parse(input);
  await db.transaction(async (tx) => {
    await tx
      .update(usageSettings)
      .set({ whatsappDailyCap: cap, ...touch() })
      .where(eq(usageSettings.id, 1));
  });
  return cap;
}

/** Precios por minuto de transcripción, por nombre de modelo. */
export function listTranscriptionPrices(tx: DbOrTx): Promise<TranscriptionPrice[]> {
  return tx
    .select({ model: transcriptionPrice.model, microsPerMinute: transcriptionPrice.microsPerMinute })
    .from(transcriptionPrice)
    .orderBy(asc(transcriptionPrice.model));
}

/** Alta o cambio del precio por minuto de un modelo de transcripción. */
export async function saveTranscriptionPrice(db: Db, input: unknown): Promise<TranscriptionPrice> {
  const { model, perMinute } = transcriptionPriceSchema.parse(input);
  await db.transaction(async (tx) => {
    await tx
      .insert(transcriptionPrice)
      .values({ model, microsPerMinute: perMinute })
      .onConflictDoUpdate({
        target: transcriptionPrice.model,
        set: { microsPerMinute: perMinute, ...touch() },
      });
  });
  return { model, microsPerMinute: perMinute };
}

/**
 * Borra el precio por minuto de un modelo. En producción con los audios activados y el negocio
 * activo, el de `STT_MODEL` no se puede borrar (FR-003).
 */
export async function deleteTranscriptionPrice(
  db: Db,
  model: string,
  protection?: ProtectionConfig,
): Promise<void> {
  await db.transaction(async (tx) => {
    const name = model.trim();
    if (
      protection?.sttModel !== null &&
      name === protection?.sttModel &&
      (await guarded(tx, protection))
    ) {
      throw new FieldConflictError('transcriptionPrices', PRICE_IN_USE_MESSAGE);
    }
    const rows = await tx
      .delete(transcriptionPrice)
      .where(eq(transcriptionPrice.model, name))
      .returning({ model: transcriptionPrice.model });
    if (rows.length === 0) throw new NotFoundError('Precio');
  });
}
