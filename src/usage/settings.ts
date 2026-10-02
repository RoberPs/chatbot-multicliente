/**
 * Precios por modelo y ajustes de consumo (010, data-model.md §1 y §4; FR-013, FR-014, R13).
 * Se leen sin caché; cada guardado va en su transacción y marca `updated_at`. No es configuración
 * del negocio: no toca el snapshot, los avisos ni la exportación de la 008.
 */
import { asc, eq, sql } from 'drizzle-orm';
import type { DbOrTx } from '../conversation/repositories/customer.js';
import type { Db } from '../db/client.js';
import { modelPrice, usageSettings } from '../db/schema.js';
import { touch } from '../db/timestamps.js';
import { FieldConflictError, NotFoundError } from '../knowledge/errors.js';
import {
  capWithoutPriceMessage,
  currencyLockedMessage,
  priceSchema,
  usageSettingsSchema,
} from './schemas.js';
import type { ModelPrice, UsageSettings } from './types.js';

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
 * panel pasa a avisar de que su consumo no cuenta (FR-021).
 */
export async function deletePrice(db: Db, model: string): Promise<void> {
  await db.transaction(async (tx) => {
    const rows = await tx
      .delete(modelPrice)
      .where(eq(modelPrice.model, model.trim()))
      .returning({ model: modelPrice.model });
    if (rows.length === 0) throw new NotFoundError('Precio');
  });
}

/**
 * Guarda moneda y tope. Cambiar la moneda exige la tabla de precios vacía (R13); activar el tope
 * exige precio para `currentModel` (FR-014). Sin importe en el formulario se conserva el guardado.
 */
export async function saveUsageSettings(
  db: Db,
  input: unknown,
  currentModel: string,
): Promise<UsageSettings> {
  const values = usageSettingsSchema.parse(input);
  return db.transaction(async (tx) => {
    const before = await readUsageSettings(tx);
    if (values.currency !== before.currency) {
      const [count] = await tx.select({ n: sql<number>`count(*)::int` }).from(modelPrice);
      if ((count?.n ?? 0) > 0) {
        throw new FieldConflictError('currency', currencyLockedMessage(before.currency));
      }
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
