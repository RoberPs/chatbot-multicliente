/**
 * Registro del consumo de las respuestas (010 US1; FR-001 – FR-005, SC-001,
 * contracts/usage-recording.md § Quién registra): un registro `reply` por respuesta con modelo en
 * cada canal, ninguno para las plantillas sin modelo, y la respuesta se entrega aunque falle el
 * registro.
 */
import { asc } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ChatModelError } from '../../../src/conversation/ports.js';
import { modelUsage, webUsageDay } from '../../../src/db/schema.js';
import {
  createTestBot,
  TEST_LLM_MODEL,
  type TestBot,
  type TestBotOptions,
} from '../../helpers/bot.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';
import { FailingUsageMeter, reply, tokens } from '../../helpers/fakes.js';
import { imageMessage } from '../../helpers/whatsapp.js';

const WEB_ON = { enabled: true, allowedOrigins: ['https://negocio.example'] };
const ALERTS = { whatsapp: '+34611000111', email: 'avisos@negocio.es' };
const USAGE = tokens(1200, 300, 0, 800);
const HOUR = 60 * 60 * 1000;

describe('registro del consumo de las respuestas', () => {
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

  /** Bot cuyo modelo falso informa `USAGE` en cada respuesta. */
  const start = async (opts: TestBotOptions = {}) => {
    bot = await createTestBot(t, opts);
    bot.model.reportUsage(USAGE);
    return bot;
  };
  const records = () => t.db.select().from(modelUsage).orderBy(asc(modelUsage.at));

  it('un registro reply por respuesta en WhatsApp, web y playground (SC-001)', async () => {
    const b = await start({ webChat: WEB_ON });
    await b.send('¿Abrís el sábado?');
    await b.sendVia('web', '¿Abrís el sábado?');
    await b.sendVia('playground', '¿Abrís el sábado?');
    await b.settle();

    const rows = await records();
    expect(rows.map((r) => r.channel).sort()).toEqual(['playground', 'web', 'whatsapp']);
    for (const row of rows) {
      expect(row).toMatchObject({
        purpose: 'reply',
        model: TEST_LLM_MODEL,
        calls: 1,
        inputTokens: 1200,
        outputTokens: 300,
        cacheWriteTokens: 0,
        cacheReadTokens: 800,
        day: '2026-09-24',
      });
    }
  });

  it('el reintento del verificador queda en un solo registro con calls = 2 (FR-002)', async () => {
    const b = await start();
    b.model.queue(
      { reply: reply('Abrimos a las 7:45.'), usage: tokens(1000, 200) },
      { reply: reply('Te paso el contacto del negocio.'), usage: tokens(1100, 150) },
    );
    await b.send('¿A qué hora abrís?');
    await b.settle();

    expect(b.model.calls).toHaveLength(2);
    const rows = await records();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ calls: 2, inputTokens: 2100, outputTokens: 350 });
  });

  it('una llamada fallida que informó tokens se registra; sin tokens, no (FR-004)', async () => {
    const b = await start();
    b.model.queue(
      { error: new ChatModelError('invalid_output'), usage: tokens(1000, 4000) },
      new ChatModelError('api_error', 529),
    );
    await b.send('Hola');
    await b.settle();
    await b.send('¿Seguís ahí?');
    await b.settle();

    const rows = await records();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ calls: 1, inputTokens: 1000, outputTokens: 4000 });
  });

  it('R-MEDIA no registra consumo', async () => {
    const b = await start();
    await b.sendMessage(imageMessage());
    await b.settle();
    expect(b.sender.sent).toHaveLength(1);
    expect(await records()).toEqual([]);
  });

  it('R-LIMIT no registra consumo', async () => {
    const b = await start();
    for (let i = 0; i < 30; i++) {
      await b.send(`mensaje ${i + 1}`);
      b.clock.advance(1000);
    }
    await b.settle();
    await b.send('mensaje 31');
    await b.settle();
    // Solo la respuesta del modelo a los 30 primeros.
    expect(await records()).toHaveLength(1);
  });

  it('R-UNAVAILABLE (tope del chat web) no registra consumo', async () => {
    const b = await start({ webChat: { ...WEB_ON, dailyCap: 2 } });
    expect((await b.sendVia('web', '¿Abrís el sábado?')).status).toBe('stored');
    // Tope alcanzado entre la recepción y el procesado.
    await t.db.insert(webUsageDay).values({ day: '2026-09-24', replies: 2 });
    await b.settle();
    expect(b.model.calls).toHaveLength(0);
    expect(await records()).toEqual([]);
  });

  it('los pendientes fuera de la ventana de 24 h no registran consumo', async () => {
    const b = await start();
    await b.send('¿abrís mañana?');
    await b.settle(24 * HOUR + 60_000);
    expect(b.model.calls).toHaveLength(0);
    expect(await records()).toEqual([]);
  });

  it('los reenvíos de una derivación activa no registran reply', async () => {
    const b = await start({ handoffAlerts: ALERTS });
    b.model.queue(reply('De acuerdo.', { handoffRequested: true }));
    await b.send('Quiero hablar con una persona');
    await b.settle();
    const before = (await records()).filter((r) => r.purpose === 'reply');
    expect(before).toHaveLength(1);

    await b.send('Es por una cita del sábado');
    await b.settle();
    expect((await records()).filter((r) => r.purpose === 'reply')).toHaveLength(1);
  });

  it('si el registro falla, la respuesta se entrega igual (FR-005)', async () => {
    const meter = new FailingUsageMeter();
    const b = await start({ usageMeter: meter });
    await b.send('¿Abrís el sábado?');
    await b.settle();
    expect(meter.attempts).toBe(1);
    expect(b.sender.sent).toHaveLength(1);
  });

  it('con el negocio en preparación, «Probar el bot» registra su consumo', async () => {
    const b = await start({ activate: false });
    await b.sendVia('playground', '¿Abrís el sábado?');
    await b.settle();
    const rows = await records();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ channel: 'playground', purpose: 'reply' });
  });
});
