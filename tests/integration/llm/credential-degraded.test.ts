/**
 * Ciclo completo del degradado por credencial rechazada (017, FR-005a/b/c, SC-010;
 * contracts/credential-verification.md §3).
 *
 * Lo que se fija aquí no es la clasificación del veredicto —eso lo hace
 * `tests/unit/llm/credential-probe.test.ts` con dobles— sino el **ciclo**: una credencial que el
 * proveedor rechaza al arrancar no mata el proceso, deja la instancia degradada con un aviso
 * crítico, y cuando la credencial vuelve a servir la instancia **sale sola** del degradado, sin
 * reiniciar nada.
 *
 * Y el detalle que hace esto usable en producción: **una** línea de registro al entrar y **una**
 * al salir. Un degradado de un día con reintentos cada 5 minutos tiene que dejar dos líneas, no
 * 288.
 *
 * Ningún test hace red ni lee una credencial real (FR-038): la verificación va inyectada.
 */
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { message, modelPrice, usageSettings } from '../../../src/db/schema.js';
import {
  createCredentialWatcher,
  type CredentialVerdict,
  type CredentialWatcher,
} from '../../../src/llm/credential-probe.js';
import { protectionState, protectionWarnings } from '../../../src/usage/protection.js';
import { createTestBot, TEST_LLM_MODEL, type TestBot } from '../../helpers/bot.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';
import { reply, tokens } from '../../helpers/fakes.js';

/** Credencial de pruebas: el degradado se decide por el veredicto, nunca por el valor. */
const KEY = 'sk-ant-credencial-de-prueba-que-el-proveedor-rechaza';
const R_CAP = 'Ahora mismo no puedo atenderte por este chat.';

describe('degradado por credencial rechazada', () => {
  let t: TestDatabase;
  let bot: TestBot | null = null;
  let watcher: CredentialWatcher | null = null;

  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t.close();
  });
  afterEach(async () => {
    watcher?.close();
    watcher = null;
    await bot?.close();
    bot = null;
  });

  /** Veredicto que el proveedor devuelve ahora mismo; la prueba lo cambia a mitad del ciclo. */
  let verdict: CredentialVerdict = 'rejected';
  let lines: string[] = [];

  /**
   * Instancia con el vigilante **real** enganchado a la protección, igual que `bot.ts`: el estado
   * se consulta en cada comprobación y no se captura al arrancar.
   */
  async function start(initial: CredentialVerdict): Promise<TestBot> {
    verdict = initial;
    lines = [];
    const w = (watcher = createCredentialWatcher({
      provider: 'anthropic',
      apiKey: KEY,
      verify: () => Promise.resolve(verdict),
      log: (line) => lines.push(line),
      // Sin temporizador propio: la prueba provoca cada reintento llamando a `check()`.
      retryIntervalMs: 60 * 60_000,
    }));
    // El arranque la lanza sin bloquear (FR-005a); aquí se espera para tener un estado estable.
    await w.check();
    const b = (bot = await createTestBot(t, {
      credentialRejected: () => w.state() === 'rejected',
    }));
    b.model.reportUsage(tokens(1000, 100));
    return b;
  }

  const outbound = () =>
    t.db.select().from(message).where(eq(message.direction, 'outbound')).orderBy(message.sentAt);

  const state = (b: TestBot) =>
    protectionState(t.db, {
      production: false,
      llmModel: TEST_LLM_MODEL,
      sttModel: null,
      credentialRejected: () => watcher?.state() === 'rejected',
      now: b.clock.now(),
      timezone: 'Europe/Madrid',
    });

  it('rechazada al arrancar: la instancia arranca, queda degradada y avisa en crítico', async () => {
    const b = await start('rejected');
    expect(watcher?.state()).toBe('rejected');

    await b.send('¿Abrís el sábado?');
    await b.settle();

    // El cliente recibe solo el contacto del negocio y el modelo no se llama ni una vez: con una
    // credencial que el proveedor rechaza, llamarlo solo produciría un error delante del cliente.
    expect(b.model.calls).toHaveLength(0);
    expect(b.sender.sent).toHaveLength(1);
    expect(b.sender.sent[0]?.body.startsWith(R_CAP)).toBe(true);
    const [out] = await outbound();
    expect(out?.replyTrace).toMatchObject({
      template: 'R-CAP',
      contact: { added: true },
      capReason: 'llm_key_rejected',
    });
    expect(b.log.named('contact_only_reply')).toEqual([
      expect.objectContaining({ reason: 'llm_key_rejected', via: 'whatsapp' }),
    ]);

    const read = await state(b);
    expect(read.contactOnly).toContain('llm_key_rejected');
    expect(protectionWarnings(read)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'LLM_KEY_REJECTED', severity: 'critical' }),
      ]),
    );
  });

  // El degradado no es una exigencia de producción como el tope: una credencial que no sirve no
  // deja responder en ningún entorno, y el panel de desarrollo no puede decir que todo va bien.
  it('degrada también fuera de producción, con el tope desactivado y el modelo sin precio', async () => {
    const b = await start('rejected');
    const read = await state(b);
    expect(read.production).toBe(false);
    expect(read.contactOnly).toEqual(['llm_key_rejected']);
  });

  it('cuando la credencial vuelve a servir, sale del degradado sola y atiende', async () => {
    const b = await start('rejected');
    verdict = 'accepted';
    // El reintento del vigilante, provocado a mano para no depender del reloj real.
    expect(await watcher?.check()).toBe('accepted');
    expect(watcher?.state()).toBe('ok');

    b.model.queue({ reply: reply('Sí, abrimos el sábado.') });
    await b.send('¿Abrís el sábado?');
    await b.settle();

    expect(b.model.calls).toHaveLength(1);
    expect(b.log.named('contact_only_reply')).toEqual([]);
    const read = await state(b);
    expect(read.contactOnly).toEqual([]);
    expect(protectionWarnings(read).map((w) => w.code)).not.toContain('LLM_KEY_REJECTED');
  });

  // SC-010: el volumen del registro. Es la diferencia entre un aviso que se lee y un aviso que se
  // silencia por ruido.
  it('deja una línea al entrar y una al salir, por muchos reintentos que haya', async () => {
    await start('rejected');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('ANTHROPIC_API_KEY');
    expect(lines[0]).not.toContain(KEY);

    // Cinco reintentos con la credencial todavía rechazada: ni una línea más.
    for (let i = 0; i < 5; i += 1) expect(await watcher?.check()).toBe('rejected');
    expect(lines).toHaveLength(1);

    verdict = 'accepted';
    await watcher?.check();
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('vuelve a ser válida');

    // Y una vez fuera del degradado, las comprobaciones siguientes tampoco dicen nada.
    await watcher?.check();
    await watcher?.check();
    expect(lines).toHaveLength(2);
  });

  // FR-005c: la ausencia de veredicto no es un veredicto. Un proveedor con un mal rato no puede
  // degradar la instancia, y tampoco puede sacarla de un degradado que sí tenía veredicto.
  it('«no se pudo comprobar» no degrada, y tampoco saca del degradado', async () => {
    const b = await start('inconclusive');
    expect(watcher?.state()).toBe('ok');
    expect(lines).toEqual([]);
    b.model.queue({ reply: reply('Sí, abrimos el sábado.') });
    await b.send('¿Abrís el sábado?');
    await b.settle();
    expect(b.model.calls).toHaveLength(1);

    verdict = 'rejected';
    await watcher?.check();
    expect(watcher?.state()).toBe('rejected');
    verdict = 'inconclusive';
    await watcher?.check();
    expect(watcher?.state()).toBe('rejected');
    expect(lines).toHaveLength(1);
  });

  // El degradado por credencial se suma a los demás motivos y va **antes** que ellos: si la clave
  // no sirve, el motivo de que el cliente reciba solo el contacto es ese y no el gasto.
  it('con el tope obligatorio sin activar, el motivo que gana es el de la credencial', async () => {
    const b = await start('rejected');
    await t.db.update(usageSettings).set({ capEnabled: false });
    await t.db.insert(modelPrice).values({
      model: TEST_LLM_MODEL,
      inputMicrosPerMtok: 3_000_000n,
      outputMicrosPerMtok: 15_000_000n,
      cacheWriteMicrosPerMtok: 0n,
      cacheReadMicrosPerMtok: 0n,
    });
    const read = await protectionState(t.db, {
      production: true,
      llmModel: TEST_LLM_MODEL,
      sttModel: null,
      credentialRejected: () => watcher?.state() === 'rejected',
      now: b.clock.now(),
      timezone: 'Europe/Madrid',
    });
    expect(read.contactOnly).toEqual(['llm_key_rejected', 'cap_disabled']);
  });
});
