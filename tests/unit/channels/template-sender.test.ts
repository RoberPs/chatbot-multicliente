/** Vía WhatsApp de los avisos al negocio (005, R6, contracts/business-alerts.md § Envío). */
import { describe, expect, it, vi } from 'vitest';
import { createGraphClient } from '../../../src/channels/whatsapp/graph-client.js';
import { createTemplateSender } from '../../../src/channels/whatsapp/template-sender.js';
import { alertNotice, forwardNotice, reminderNotice } from '../../../src/handoff/notices.js';

const TOKEN = 'AbCdEfGhIjKlMnOpQrStUv';
const BUSINESS_WA = '+34611000111';

const notice = alertNotice({
  id: '0f8fad5b-d9cb-469f-a165-70867728950e',
  kind: 'person',
  customerName: 'Lucía\nPérez',
  customerPhone: '+34611222333',
  channel: 'web',
  summary: 'Pregunta por el precio del tinte.\tQuiere hablar con alguien.',
  startedAt: new Date('2026-10-01T19:40:00Z'),
  timezone: 'Europe/Madrid',
  token: TOKEN,
});

const ok = (id = 'wamid.AVISO') =>
  new Response(JSON.stringify({ messages: [{ id }] }), { status: 200 });
const fail = (status: number, code?: number) =>
  new Response(JSON.stringify(code === undefined ? {} : { error: { code } }), { status });

function route(responses: Array<Response | Error>, language = 'es') {
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.signal?.aborted) throw new Error('abortado');
    const next = responses.shift();
    if (!next) throw new Error('sin respuesta programada');
    if (next instanceof Error) throw next;
    return next;
  });
  const sleeps: number[] = [];
  const graph = createGraphClient({
    phoneNumberId: '1098',
    accessToken: 'tok',
    graphVersion: 'v23.0',
    fetch: fetch as unknown as typeof globalThis.fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { sender: createTemplateSender({ graph, language }, BUSINESS_WA), fetch, sleeps };
}

const signal = () => new AbortController().signal;

describe('plantilla derivacion_aviso', () => {
  it('cuerpo JSON exacto del contrato, con variables saneadas y botones con el token', async () => {
    const { sender, fetch } = route([ok()]);
    await expect(sender.send(notice, { signal: signal() })).resolves.toEqual({
      ok: true,
      ref: 'wamid.AVISO',
    });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://graph.facebook.com/v23.0/1098/messages');
    expect(JSON.parse(init.body as string)).toEqual({
      messaging_product: 'whatsapp',
      to: '34611000111',
      type: 'template',
      template: {
        name: 'derivacion_aviso',
        language: { code: 'es' },
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: 'Lucía Pérez' },
              { type: 'text', text: '+34 611 22 23 33' },
              { type: 'text', text: 'chat de la web' },
              { type: 'text', text: 'quiere hablar con una persona' },
              {
                type: 'text',
                text: 'Pregunta por el precio del tinte. Quiere hablar con alguien.',
              },
            ],
          },
          {
            type: 'button',
            sub_type: 'quick_reply',
            index: '0',
            parameters: [{ type: 'payload', payload: `h1:attend:${TOKEN}` }],
          },
          {
            type: 'button',
            sub_type: 'quick_reply',
            index: '1',
            parameters: [{ type: 'payload', payload: `h1:end:${TOKEN}` }],
          },
        ],
      },
    });
  });

  it('usa el idioma de WHATSAPP_TEMPLATE_LANG', async () => {
    const { sender, fetch } = route([ok()], 'es_MX');
    await sender.send(notice, { signal: signal() });
    const body = JSON.parse((fetch.mock.calls[0]?.[1] as RequestInit).body as string) as {
      template: { language: { code: string } };
    };
    expect(body.template.language.code).toBe('es_MX');
  });

  it('reintenta en 429 y 5xx como sendText', async () => {
    const { sender, fetch, sleeps } = route([fail(429), fail(503), ok('wamid.R')]);
    await expect(sender.send(notice, { signal: signal() })).resolves.toEqual({
      ok: true,
      ref: 'wamid.R',
    });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(sleeps).toHaveLength(2);
  });

  it('un 4xx no se reintenta: plantilla rechazada o destinatario no válido', async () => {
    let r = route([fail(400, 132001)]);
    await expect(r.sender.send(notice, { signal: signal() })).resolves.toEqual({
      ok: false,
      failure: 'template_rejected',
    });
    expect(r.fetch).toHaveBeenCalledTimes(1);

    r = route([fail(400, 131026)]);
    await expect(r.sender.send(notice, { signal: signal() })).resolves.toEqual({
      ok: false,
      failure: 'recipient_invalid',
    });
    expect(r.fetch).toHaveBeenCalledTimes(1);
  });

  it('con el plazo agotado no reintenta y devuelve timeout', async () => {
    const controller = new AbortController();
    const { sender, fetch } = route([fail(503), ok()]);
    controller.abort();
    await expect(sender.send(notice, { signal: controller.signal })).resolves.toEqual({
      ok: false,
      failure: 'timeout',
    });
    expect(fetch.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('error de red sin plazo agotado → network, sin lanzar', async () => {
    const { sender } = route([
      new Error('ECONNRESET'),
      new Error('x'),
      new Error('y'),
      new Error('z'),
    ]);
    await expect(sender.send(notice, { signal: signal() })).resolves.toEqual({
      ok: false,
      failure: 'network',
    });
  });
});

describe('plantilla derivacion_mensaje (US3)', () => {
  it('reenvío con nombre, teléfono y textos recortados, con los mismos botones', async () => {
    const { sender, fetch } = route([ok('wamid.FWD')]);
    const forward = forwardNotice(
      notice.handoff,
      [
        { text: 'Llego tarde', kind: 'text', otherType: null, sentAt: new Date() },
        { text: null, kind: 'other', otherType: 'image', sentAt: new Date() },
      ],
      false,
    );
    await expect(sender.send(forward, { signal: signal() })).resolves.toEqual({
      ok: true,
      ref: 'wamid.FWD',
    });
    const body = JSON.parse((fetch.mock.calls[0]?.[1] as RequestInit).body as string) as {
      template: { name: string; components: Array<{ type: string; parameters: unknown[] }> };
    };
    expect(body.template.name).toBe('derivacion_mensaje');
    expect(body.template.components[0]?.parameters).toEqual([
      { type: 'text', text: 'Lucía Pérez' },
      { type: 'text', text: '+34 611 22 23 33' },
      { type: 'text', text: 'Llego tarde / [image]' },
    ]);
    expect(body.template.components.slice(1).map((c) => c.type)).toEqual(['button', 'button']);
  });
});

describe('plantilla derivacion_recordatorio (US5)', () => {
  it('nombre, teléfono, desde en hora local y motivo, con los mismos botones', async () => {
    const { sender, fetch } = route([ok('wamid.REC')]);
    const reminder = reminderNotice(notice.handoff, 'schedule');
    await expect(sender.send(reminder, { signal: signal() })).resolves.toEqual({
      ok: true,
      ref: 'wamid.REC',
    });
    const body = JSON.parse((fetch.mock.calls[0]?.[1] as RequestInit).body as string) as {
      template: {
        name: string;
        components: Array<{ type: string; parameters: Array<{ payload?: string }> }>;
      };
    };
    expect(body.template.name).toBe('derivacion_recordatorio');
    const [first, ...buttons] = body.template.components;
    expect(first?.parameters).toHaveLength(4);
    expect(first?.parameters.slice(0, 2)).toEqual([
      { type: 'text', text: 'Lucía Pérez' },
      { type: 'text', text: '+34 611 22 23 33' },
    ]);
    expect(first?.parameters[3]).toEqual({
      type: 'text',
      text: 'Pregunta por el precio del tinte. Quiere hablar con alguien.',
    });
    expect(buttons.map((b) => b.parameters[0]?.payload)).toEqual([
      `h1:attend:${TOKEN}`,
      `h1:end:${TOKEN}`,
    ]);
  });
});
