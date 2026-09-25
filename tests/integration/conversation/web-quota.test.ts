/**
 * Topes diario y mensual del chat web (004 US4-3, FR-026, FR-026a): al alcanzarlos el chat deja
 * de responder y da el contacto, el evento se emite una sola vez por periodo, al día siguiente
 * vuelve a responder y el panel lo avisa.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { webUsageDay } from '../../../src/db/schema.js';
import { get, login } from '../../helpers/app.js';
import { createTestBot, type TestBot } from '../../helpers/bot.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';
import { reply } from '../../helpers/fakes.js';
import { postWebMessage, webToken } from '../../helpers/web.js';

const DAY = 24 * 60 * 60 * 1000;
const ORIGIN = 'https://negocio.example';
const WEB_ON = {
  enabled: true,
  allowedOrigins: [ORIGIN],
  privacyUrl: `${ORIGIN}/privacidad`,
};

interface Unavailable {
  reason: string;
  contact: string;
}

describe('topes de uso del chat web', () => {
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

  /** Una pregunta con su respuesta, cada una en su propia conversación agrupada. */
  async function ask(b: TestBot, token: string, text: string) {
    const res = await postWebMessage(b.app, token, text);
    await b.settle();
    return res;
  }

  it('con tope diario 3, la cuarta pregunta da quota con contacto (US4-3)', async () => {
    const b = await createTestBot(t, {
      webChat: { ...WEB_ON, dailyCap: 3, monthlyCap: 100 },
    });
    bot = b;
    b.model.queue(reply('Una.'), reply('Dos.'), reply('Tres.'));
    const token = await webToken(b.app);

    for (const text of ['Primera', 'Segunda', 'Tercera']) {
      expect((await ask(b, token, text)).statusCode).toBe(202);
    }
    expect(await t.db.select().from(webUsageDay)).toMatchObject([{ replies: 3 }]);

    const cuarta = await postWebMessage(b.app, token, 'Cuarta');
    expect(cuarta.statusCode).toBe(200);
    expect(cuarta.body.accepted).toBe(false);
    const un = cuarta.body.unavailable as Unavailable;
    expect(un.reason).toBe('quota');
    expect(un.contact).toContain('Peluquería Tijeras');
    // No se ha guardado ni se ha llamado al modelo una cuarta vez.
    expect(b.model.calls).toHaveLength(3);

    // El evento del tope se emite una sola vez por periodo y proceso.
    await postWebMessage(b.app, token, 'Quinta');
    const avisos = b.log.named('web_quota_reached');
    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toMatchObject({ period: 'day', cap: 3 });
  });

  it('al empezar el día local siguiente vuelve a responder', async () => {
    const b = await createTestBot(t, { webChat: { ...WEB_ON, dailyCap: 1, monthlyCap: 100 } });
    bot = b;
    b.model.queue(reply('Hoy.'), reply('Mañana.'));
    const token = await webToken(b.app);
    await ask(b, token, 'Hoy');
    expect((await postWebMessage(b.app, token, 'Otra de hoy')).body.accepted).toBe(false);

    b.clock.advance(DAY);
    expect((await ask(b, token, '¿Y hoy?')).statusCode).toBe(202);
    const dias = await t.db.select().from(webUsageDay);
    expect(dias).toHaveLength(2);
    expect(dias.every((d) => d.replies === 1)).toBe(true);
  });

  it('el tope mensual se avisa con period: month', async () => {
    const b = await createTestBot(t, { webChat: { ...WEB_ON, dailyCap: 5, monthlyCap: 5 } });
    bot = b;
    // Cuatro respuestas de días anteriores del mismo mes local más una de hoy.
    await t.db.insert(webUsageDay).values({ day: '2026-09-01', replies: 4 });
    b.model.queue(reply('La última del mes.'));
    const token = await webToken(b.app);
    await ask(b, token, 'Una pregunta');

    const pasada = await postWebMessage(b.app, token, 'Otra pregunta');
    expect(pasada.body.accepted).toBe(false);
    expect((pasada.body.unavailable as Unavailable).reason).toBe('quota');
    expect(b.log.named('web_quota_reached')[0]).toMatchObject({ period: 'month', cap: 5 });
  });

  it('el panel muestra el uso y el aviso de tope alcanzado (FR-026, FR-026a)', async () => {
    const b = await createTestBot(t, { webChat: { ...WEB_ON, dailyCap: 3, monthlyCap: 100 } });
    bot = b;
    await t.db.insert(webUsageDay).values({ day: '2026-09-24', replies: 3 });
    const session = await login(b.app);

    const page = await get(b.app, session, '/admin/web-chat');
    expect(page.body).toContain('Hoy: 3 de 3');
    expect(page.body).toContain(
      'El chat web ha alcanzado el tope diario: no responde hasta mañana. Los clientes ven el ' +
        'contacto del negocio.',
    );
    const portada = await get(b.app, session, '/admin');
    expect(portada.body).toContain('tope alcanzado (diario)');
  });

  it('el aviso mensual del panel dice que no responde hasta el mes que viene', async () => {
    const b = await createTestBot(t, { webChat: { ...WEB_ON, dailyCap: 2, monthlyCap: 2 } });
    bot = b;
    await t.db.insert(webUsageDay).values({ day: '2026-09-02', replies: 2 });
    const session = await login(b.app);

    const page = await get(b.app, session, '/admin/web-chat');
    expect(page.body).toContain(
      'El chat web ha alcanzado el tope mensual: no responde hasta el mes que viene. Los ' +
        'clientes ven el contacto del negocio.',
    );
    expect((await get(b.app, session, '/admin')).body).toContain('tope alcanzado (mensual)');
  });

  it('WhatsApp sigue respondiendo con el tope web alcanzado', async () => {
    const b = await createTestBot(t, { webChat: { ...WEB_ON, dailyCap: 1, monthlyCap: 100 } });
    bot = b;
    b.model.queue(reply('Respuesta web.'), reply('Respuesta de WhatsApp.'));
    const token = await webToken(b.app);
    await ask(b, token, 'Desde la web');
    expect((await postWebMessage(b.app, token, 'Otra desde la web')).body.accepted).toBe(false);

    expect(await b.send('¿Abrís el sábado?')).toBe(200);
    await b.settle();
    expect(b.sender.sent.at(-1)?.body).toContain('Respuesta de WhatsApp.');
  });
});
