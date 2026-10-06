/**
 * Solo contacto en producción (012 US1, SC-001; contracts/protection-conversation.md): sin tope
 * activo, sin precio del modelo o con el gasto ilegible, WhatsApp responde R-CAP y el chat web
 * queda «no disponible», siempre con el contacto y sin llamar nunca al modelo.
 */
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  message,
  modelPrice,
  usageSettings,
  webUsageDay,
} from '../../../src/db/schema.js';
import { contactBlock } from '../../../src/conversation/templates.js';
import { createKnowledgeReader } from '../../../src/knowledge/snapshot.js';
import type { KnowledgeReader } from '../../../src/knowledge/types.js';
import type { UsageMeter } from '../../../src/usage/meter.js';
import type { ContactOnlyReason } from '../../../src/usage/types.js';
import { webChatAvailability } from '../../../src/webchat/availability.js';
import {
  createTestBot,
  TEST_LLM_MODEL,
  type TestBot,
  type TestBotOptions,
} from '../../helpers/bot.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';
import { reply, tokens } from '../../helpers/fakes.js';

const R_CAP =
  'Ahora mismo no puedo atenderte por este chat.\n\nPara hablar con una persona de Peluquería Tijeras:';
const R_ERR_EMERGENCY = 'Si necesitas hablar con una persona: teléfono +34 600 99 98 88.';
const WEB_ON = {
  enabled: true,
  allowedOrigins: ['https://negocio.example'],
  privacyUrl: 'https://negocio.example/privacidad',
  dailyCap: 200,
  monthlyCap: 3000,
};

describe('solo contacto en producción', () => {
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

  const price = () =>
    t.db.insert(modelPrice).values({
      model: TEST_LLM_MODEL,
      inputMicrosPerMtok: 3_000_000n,
      outputMicrosPerMtok: 15_000_000n,
      cacheWriteMicrosPerMtok: 0n,
      cacheReadMicrosPerMtok: 0n,
    });
  const enableCap = () =>
    t.db.update(usageSettings).set({ capEnabled: true, monthlyCapCents: 100_000 });

  /** Bot en producción con WhatsApp y chat web, y con lo necesario salvo lo que rompe `reason`. */
  async function start(
    reason: ContactOnlyReason | null,
    opts: TestBotOptions = {},
  ): Promise<TestBot> {
    const b = (bot = await createTestBot(t, { production: true, webChat: WEB_ON, ...opts }));
    b.model.reportUsage(tokens(1000, 100));
    if (reason !== 'model_unpriced') await price();
    if (reason !== 'cap_disabled') await enableCap();
    // Sin la fila única de ajustes el estado no se puede leer.
    if (reason === 'spend_unreadable') await t.db.delete(usageSettings);
    return b;
  }
  const outbound = () =>
    t.db
      .select()
      .from(message)
      .where(eq(message.direction, 'outbound'))
      .orderBy(message.sentAt);
  const availability = (b: TestBot) =>
    webChatAvailability({
      tx: t.db,
      reader: createKnowledgeReader(t.db),
      botPresent: true,
      emergencyPhone: '+34600999888',
      now: b.clock.now(),
      activityLog: b.log,
      protection: { production: true, llmModel: TEST_LLM_MODEL, sttModel: null },
    });

  const REASONS: ContactOnlyReason[] = ['cap_disabled', 'model_unpriced', 'spend_unreadable'];

  describe.each(REASONS)('%s', (reason) => {
    it('WhatsApp: R-CAP con el contacto, sin modelo, con capReason y contact_only_reply', async () => {
      const b = await start(reason);
      await b.send('¿Abrís el sábado?');
      await b.settle();

      expect(b.model.calls).toHaveLength(0);
      expect(b.sender.sent).toHaveLength(1);
      expect(b.sender.sent[0]?.body.startsWith(R_CAP)).toBe(true);
      const [out] = await outbound();
      expect(out?.replyTrace).toMatchObject({
        template: 'R-CAP',
        contact: { added: true },
        modelMs: null,
        capReason: reason,
      });
      expect(b.log.named('contact_only_reply')).toEqual([
        expect.objectContaining({ event: 'contact_only_reply', reason, via: 'whatsapp' }),
      ]);
    });

    it('chat web: «no disponible» con el contacto y sin modelo', async () => {
      const b = await start(reason);
      expect(await b.sendVia('web', 'Hola')).toEqual({ status: 'discarded', reason: 'spend_cap' });
      expect(b.log.named('contact_only_reply')).toEqual([
        expect.objectContaining({ reason, via: 'web' }),
      ]);
      const snapshot = await createKnowledgeReader(t.db).getSnapshot();
      expect(await availability(b)).toEqual({
        available: false,
        unavailable: {
          reason: 'quota',
          message: 'Ahora mismo el chat no está disponible.',
          contact: contactBlock(snapshot),
        },
      });
      expect(b.model.calls).toHaveLength(0);
    });
  });

  it('chat web: lo ya aceptado recibe R-UNAVAILABLE con el contacto, sin modelo', async () => {
    const b = await start(null);
    expect((await b.sendVia('web', '¿Abrís el sábado?')).status).toBe('stored');
    await t.db.update(usageSettings).set({ capEnabled: false });
    await b.settle();
    expect(b.model.calls).toHaveLength(0);
    const [out] = await outbound();
    expect(out?.body).toMatch(/^Ahora mismo no puedo atenderte por este chat\.\n\nPara hablar/);
    expect(out?.replyTrace).toMatchObject({ template: 'R-UNAVAILABLE', capReason: 'cap_disabled' });
  });

  it('sin snapshot legible: R-ERR con el contacto de emergencia, sin modelo', async () => {
    let failing = false;
    const real = createKnowledgeReader(t.db);
    const reader: KnowledgeReader = {
      getSnapshot: () =>
        failing ? Promise.reject(new TypeError('conexión perdida')) : real.getSnapshot(),
    };
    const b = await start('cap_disabled', { reader });
    await b.send('¿Abrís el sábado?');
    failing = true;
    await b.settle();
    expect(b.model.calls).toHaveLength(0);
    expect(b.sender.sent[0]?.body.endsWith(R_ERR_EMERGENCY)).toBe(true);
    expect(b.log.named('reply_sent')[0]).toMatchObject({ template: 'R-ERR', contactBlock: true });
  });

  it('con tope y precio se atiende con el modelo', async () => {
    const b = await start(null);
    b.model.queue({ reply: reply('Sí, abrimos el sábado.') });
    await b.send('¿Abrís el sábado?');
    await b.settle();
    expect(b.model.calls).toHaveLength(1);
    expect(b.log.named('contact_only_reply')).toEqual([]);
  });

  it('fuera de producción sin tope ni precio se atiende con el modelo (010)', async () => {
    const b = (bot = await createTestBot(t));
    b.model.queue({ reply: reply('Sí, abrimos el sábado.') });
    await b.send('¿Abrís el sábado?');
    await b.settle();
    expect(b.model.calls).toHaveLength(1);
  });

  describe('chat web: cada respuesta con modelo cuenta para el tope de la 004 (FR-005)', () => {
    const webReplies = async () => (await t.db.select().from(webUsageDay))[0]?.replies ?? 0;

    it('aunque falle el registro del consumo', async () => {
      const meter = {
        record: () => Promise.reject(new Error('caída')),
        recordTranscription: () => Promise.reject(new Error('caída')),
      } as unknown as UsageMeter;
      const b = await start(null, { usageMeter: meter });
      b.model.queue({ reply: reply('Sí.') });
      expect((await b.sendVia('web', '¿Abrís el sábado?')).status).toBe('stored');
      await b.settle();
      expect(b.model.calls).toHaveLength(1);
      expect(await webReplies()).toBe(1);
    });

    it('aunque el proveedor no informe tokens', async () => {
      const b = await start(null);
      b.model.reportUsage(null);
      b.model.queue({ reply: reply('Sí.') });
      expect((await b.sendVia('web', '¿Abrís el sábado?')).status).toBe('stored');
      await b.settle();
      expect(b.model.calls).toHaveLength(1);
      expect(await webReplies()).toBe(1);
    });
  });
});
