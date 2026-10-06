/**
 * US2 (012, FR-016, SC-011; contracts/handoff-limits.md § Texto del cliente): con la batería de
 * enlaces, ningún email ni variable de plantilla que llega al negocio contiene una dirección con
 * protocolo ni un host sin `[.]`: ni el texto reenviado, ni el resumen (del modelo o literal), ni
 * el nombre de perfil.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { linkCandidates } from '../../../src/conversation/link-rule.js';
import {
  alertEmail,
  alertTemplateVars,
  forwardEmail,
  forwardTemplateVars,
  handoffLinks,
} from '../../../src/handoff/notices.js';
import type { BusinessNotice } from '../../../src/handoff/types.js';
import { createTestBot, type TestBot } from '../../helpers/bot.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';
import { reply } from '../../helpers/fakes.js';
import { postWebhook, textMessage, webhookPayload } from '../../helpers/whatsapp.js';
import { LINK_CASES } from '../../fixtures/links/battery.js';

const ALERTS = { whatsapp: '+34611000111', email: 'avisos@negocio.es' };
const BASE = 'https://bot.negocio.example';
const PROFILE = 'Ana www.ana-peluqueria.es';
/** Textos de la batería con alguna dirección (los que no tienen, no cambian). */
const TEXTS = LINK_CASES.filter((c) => c.text.trim() !== '').map((c) => c.text);
/** Un esquema seguido de un host con punto: lo que no puede llegar al negocio. */
const ADDRESS_WITH_SCHEME = /[a-z][a-z0-9+.-]*:\/\/[^\s«»/]*[.．]/iu;

/** Todo lo que el negocio recibiría por email y por plantilla de un aviso. */
function rendered(notice: BusinessNotice): string[] {
  const now = new Date('2026-09-24T08:30:00Z');
  const links = handoffLinks(BASE, notice.handoff.token);
  const strip = (text: string) => text.replace(links.attend, '').replace(links.end, '');
  switch (notice.type) {
    case 'alert':
      return [strip(alertEmail(notice, now, BASE).text), ...alertTemplateVars(notice)];
    case 'forward':
      return [strip(forwardEmail(notice, BASE).text), ...forwardTemplateVars(notice)];
    default:
      return [];
  }
}

describe('US2: el texto del cliente llega desactivado al negocio (SC-011)', () => {
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

  /** Varios textos en un solo webhook, con el nombre de perfil con una dirección. */
  async function sendAs(b: TestBot, texts: string[]): Promise<void> {
    const res = await postWebhook(
      b.app,
      webhookPayload({
        profileName: PROFILE,
        messages: texts.map((text) => textMessage(text, { timestamp: b.clock.now() })),
      }),
    );
    expect(res.statusCode).toBe(200);
  }

  function expectDefanged(b: TestBot): void {
    const notices = [...b.alertRoutes.whatsapp.received, ...b.alertRoutes.email.received];
    expect(notices.map((n) => n.type)).toEqual(expect.arrayContaining(['alert', 'forward']));
    for (const notice of notices) {
      for (const text of rendered(notice)) {
        expect(text).not.toMatch(ADDRESS_WITH_SCHEME);
        expect(linkCandidates(text).map((m) => m.url)).toEqual([]);
      }
    }
  }

  // Una sola pasada: la batería completa ya la recorre la unitaria de `customerQuote`; aquí se
  // comprueba que llega desactivada por las vías reales (alerta con resumen y nombre, y reenvío).
  it('resumen, nombre de perfil y texto reenviado', async () => {
    const b = (bot = await createTestBot(t, {
      handoffAlerts: ALERTS,
      settings: { rateLimitMessages: 1000 },
    }));
    b.summarizer.queue({ summary: `El cliente dice: ${TEXTS.join(' | ')}` });
    b.model.queue(reply('De acuerdo.', { handoffRequested: true }));
    await sendAs(b, ['Quiero hablar con una persona']);
    await b.settle();
    expect(b.alertRoutes.email.received[0]?.type).toBe('alert');

    await sendAs(b, TEXTS);
    await b.settle(15 * 60_000);

    expectDefanged(b);
  });
});
