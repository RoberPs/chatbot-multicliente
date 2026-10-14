/**
 * «No informado» no es «cero medido» en la columna de caché (017, FR-024, data-model.md §2).
 *
 * El segundo test es el que cuida la trampa cara: si el cálculo del coste no tratase el nulo como
 * cero, la suma entera daría `NULL`, `cost_pico` quedaría nulo con `currency` no nulo, se violaría
 * `model_usage_cost_currency`, la inserción fallaría y el medidor —que nunca lanza— se comería el
 * error. Se perdería **todo** el registro de consumo de los proveedores que no informan de la
 * escritura de caché, sin que nadie se enterase.
 */
import { asc } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { modelPrice, modelUsage } from '../../../src/db/schema.js';
import { createTestBot, TEST_LLM_MODEL, type TestBot } from '../../helpers/bot.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';

/** Lo que informa un proveedor que no mide la escritura de caché: nulo en ese concepto. */
const SIN_ESCRITURA_DE_CACHE = {
  input: 1200,
  output: 300,
  cacheWrite: null,
  cacheRead: 800,
};

describe('escritura de caché no informada', () => {
  let t: TestDatabase;
  let bot: TestBot | null = null;

  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t.close();
  });
  afterEach(async () => {
    await bot?.close();
    bot = null;
  });

  const records = () => t.db.select().from(modelUsage).orderBy(asc(modelUsage.at));

  const start = async (): Promise<TestBot> => {
    const b = (bot = await createTestBot(t));
    b.model.reportUsage(SIN_ESCRITURA_DE_CACHE);
    return b;
  };

  it('deja NULL en la columna, distinguible del cero medido de la lectura', async () => {
    const b = await start();
    await b.send('¿Abrís el sábado?');
    await b.settle();

    const rows = await records();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.cacheWriteTokens).toBeNull();
    // La lectura sí la informa el proveedor: es un número, no un nulo.
    expect(rows[0]?.cacheReadTokens).toBe(800);
    expect(rows[0]).toMatchObject({ calls: 1, unmeasuredCalls: 0, inputTokens: 1200 });
  });

  it('el coste se calcula igual y queda con su moneda, no nulo', async () => {
    const b = await start();
    await t.db.insert(modelPrice).values({
      model: TEST_LLM_MODEL,
      inputMicrosPerMtok: 1_000_000n,
      outputMicrosPerMtok: 1_000_000n,
      // Si el concepto nulo se colase en la suma, el precio de la caché no la salvaría.
      cacheWriteMicrosPerMtok: 2_000_000n,
      cacheReadMicrosPerMtok: 1_000_000n,
    });
    await b.send('¿Abrís el sábado?');
    await b.settle();

    const rows = await records();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.cacheWriteTokens).toBeNull();
    expect(row?.costPico).not.toBeNull();
    expect(row?.currency).not.toBeNull();
    // (1200 + 300 + 800) × 1 000 000 millonésimas por MTok: la escritura nula aporta 0.
    expect(row?.costPico).toBe(2_300_000_000n);
  });

  /**
   * T066 (FR-026, FR-027): cambiar de proveedor no cambia nada de esto.
   *
   * El precio se busca por **nombre de modelo**, que es lo que cambia al cambiar de proveedor, así
   * que el camino del «modelo sin precio» —degradar a solo contacto del negocio— sigue siendo el
   * mismo y no hace falta nada nuevo. Y el coste ya registrado **no se recalcula nunca**: la fila
   * del proveedor anterior conserva el importe que se congeló cuando se registró, aunque el modelo
   * actual ya no tenga precio.
   */
  it('al cambiar de modelo el histórico no se recalcula y el nuevo queda sin precio', async () => {
    const b = await start();
    await t.db.insert(modelPrice).values({
      model: TEST_LLM_MODEL,
      inputMicrosPerMtok: 1_000_000n,
      outputMicrosPerMtok: 1_000_000n,
      cacheWriteMicrosPerMtok: 2_000_000n,
      cacheReadMicrosPerMtok: 1_000_000n,
    });
    await b.send('¿Abrís el sábado?');
    await b.settle();
    const [congelada] = await records();
    expect(congelada?.costPico).toBe(2_300_000_000n);

    // El operador cambia de proveedor: el modelo pasa a ser otro, y ese otro no tiene precio.
    await t.db.delete(modelPrice);
    await b.send('¿Y el domingo?');
    await b.settle();

    const rows = await records();
    expect(rows).toHaveLength(2);
    // La fila anterior sigue exactamente igual: el coste congelado no se toca (FR-026).
    expect(rows[0]).toMatchObject({ costPico: 2_300_000_000n, currency: 'USD' });
    // La nueva queda sin valorar, que es lo que hace saltar el aviso de «modelo sin precio».
    expect(rows[1]?.costPico).toBeNull();
    expect(rows[1]?.currency).toBeNull();
    // Y sigue siendo «sin dato» en el concepto que el proveedor no informa, no un cero.
    expect(rows[1]?.cacheWriteTokens).toBeNull();
  });
});
