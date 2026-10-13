/**
 * Una respuesta cuyo consumo el proveedor no informó deja registro (017, FR-025, FR-025b, SC-005).
 *
 * Antes de la 017 no dejaba **ninguno**, y eso es un cero silencioso justo donde vive el tope de
 * gasto: el panel sumaba un total que parecía exacto. Lo que estos tests fijan es que ahora queda
 * una fila, y que esa fila es **distinguible** de un consumo cero medido.
 */
import { asc } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ChatModelError } from '../../../src/conversation/ports.js';
import { modelUsage } from '../../../src/db/schema.js';
import { createTestBot, type TestBot } from '../../helpers/bot.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';
import { reply, tokens } from '../../helpers/fakes.js';

describe('consumo no medido', () => {
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
  const start = async (): Promise<TestBot> => (bot = await createTestBot(t));

  it('una respuesta sin información de consumo deja una fila con calls y unmeasured_calls', async () => {
    const b = await start();
    b.model.reportUsage(null);
    await b.send('¿Abrís el sábado?');
    await b.settle();

    const rows = await records();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      purpose: 'reply',
      calls: 1,
      unmeasuredCalls: 1,
      inputTokens: 0,
      outputTokens: 0,
    });
  });

  // SC-005: la distinción que da sentido a la columna. Las dos filas tienen los tokens a 0; lo que
  // las separa es `unmeasured_calls`, y sin ella el operador no podría saber cuál de las dos es.
  it('se distingue de un consumo cero medido', async () => {
    const b = await start();
    b.model.reportUsage(tokens(0, 0));
    await b.send('¿Abrís el sábado?');
    await b.settle();

    const rows = await records();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ calls: 1, unmeasuredCalls: 0, inputTokens: 0, outputTokens: 0 });
  });

  it('el reintento del verificador cuenta las dos llamadas, midiendo solo la que informó', async () => {
    const b = await start();
    b.model.reportUsage(null);
    b.model.queue(
      { reply: reply('Abrimos a las 7:45.'), usage: null },
      { reply: reply('Te paso el contacto del negocio.'), usage: tokens(1100, 150) },
    );
    await b.send('¿A qué hora abrís?');
    await b.settle();

    expect(b.model.calls).toHaveLength(2);
    const rows = await records();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      calls: 2,
      unmeasuredCalls: 1,
      inputTokens: 1100,
      outputTokens: 150,
    });
  });

  // El plazo agotado y el fallo de la API **no** son llamadas con respuesta: el proveedor no
  // contestó, así que no hay nada que contar y no se registra nada.
  it('un fallo sin respuesta del proveedor no deja fila', async () => {
    const b = await start();
    b.model.reportUsage(null);
    b.model.queue(new ChatModelError('api_error', 529));
    await b.send('Hola');
    await b.settle();

    expect(await records()).toEqual([]);
  });

  // Un rechazo y una respuesta que no valida **sí** son respuestas: el proveedor contestó y pudo
  // cobrar, aunque no informara de ello.
  it('un rechazo sin tokens informados sí cuenta como llamada con respuesta', async () => {
    const b = await start();
    b.model.reportUsage(null);
    b.model.queue(new ChatModelError('refusal'));
    await b.send('Hola');
    await b.settle();

    const rows = await records();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ calls: 1, unmeasuredCalls: 1 });
  });
});
