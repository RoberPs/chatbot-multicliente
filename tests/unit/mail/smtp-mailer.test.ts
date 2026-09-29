/** Vía email de los avisos al negocio (005, R7, contracts/business-alerts.md § Email). */
import nodemailer, { type SendMailOptions, type Transporter } from 'nodemailer';
import { describe, expect, it } from 'vitest';
import { alertNotice, forwardNotice, reminderNotice } from '../../../src/handoff/notices.js';
import { createSmtpMailer, smtpFailure, smtpTransport } from '../../../src/mail/smtp-mailer.js';
import { ManualClock } from '../../helpers/fakes.js';

const TOKEN = 'AbCdEfGhIjKlMnOpQrStUv';
const BASE = 'https://bot.ejemplo.com';
const clock = new ManualClock('2026-10-01T19:45:00Z');

const notice = (summary = 'Pregunta por el precio del tinte.') =>
  alertNotice({
    id: '0f8fad5b-d9cb-469f-a165-70867728950e',
    kind: 'person',
    customerName: 'Lucía',
    customerPhone: '+34611222333',
    channel: 'whatsapp',
    summary,
    startedAt: new Date('2026-10-01T19:40:00Z'),
    timezone: 'Europe/Madrid',
    token: TOKEN,
  });

interface JsonMail {
  from: { address: string };
  inReplyTo?: string;
  references?: string | string[];
  to: Array<{ address: string }>;
  subject: string;
  text: string;
  html: string;
}

function mailer() {
  const transport = nodemailer.createTransport({ jsonTransport: true });
  const sent: JsonMail[] = [];
  const original = transport.sendMail.bind(transport);
  transport.sendMail = (async (mail: SendMailOptions) => {
    const info = (await original(mail)) as { message: string; messageId: string };
    sent.push(JSON.parse(info.message) as JsonMail);
    return info;
  }) as typeof transport.sendMail;
  const route = createSmtpMailer(
    { transport, from: 'bot@ejemplo.com', baseUrl: BASE, clock },
    'avisos@negocio.es',
  );
  return { route, sent };
}

const signal = () => new AbortController().signal;

describe('email del aviso', () => {
  it('asunto, remitente, destinatario y cuerpo de texto del contrato', async () => {
    const { route, sent } = mailer();
    const result = await route.send(notice(), { signal: signal() });
    expect(result).toMatchObject({ ok: true });
    expect(result.ok && result.ref).toMatch(/^<.+@.+>$/);

    const [mail] = sent;
    expect(mail?.from.address).toBe('bot@ejemplo.com');
    expect(mail?.to.map((t) => t.address)).toEqual(['avisos@negocio.es']);
    expect(mail?.subject).toBe('Derivación: Lucía (quiere hablar con una persona)');
    expect(mail?.text).toBe(
      [
        'El asistente ha pasado una conversación a tu negocio.',
        '',
        'Cliente: Lucía',
        'Teléfono: +34 611 22 23 33',
        'Canal: WhatsApp',
        'Tipo: quiere hablar con una persona',
        'Desde: hoy a las 21:40',
        'Motivo: Pregunta por el precio del tinte.',
        '',
        'Contacta con el cliente desde tu teléfono. Mientras tanto el asistente no le responde.',
        '',
        `Le atiendo: ${BASE}/handoff/${TOKEN}/attend`,
        `Terminado:  ${BASE}/handoff/${TOKEN}/end`,
        '',
        'Si no confirmas en 2 horas de tu horario de atención, te enviaremos un recordatorio y daremos al',
        'cliente tu contacto directo. Si el cliente no escribe en 24 horas, la conversación vuelve al',
        'asistente (y, si no habías confirmado, te enviaremos el recordatorio en ese momento).',
      ].join('\n'),
    );
  });

  it('el HTML escapa el contenido del cliente y enlaza las dos acciones', async () => {
    const { route, sent } = mailer();
    await route.send(notice('<script>alert(1)</script> & "más"'), { signal: signal() });
    const html = sent[0]?.html ?? '';
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;más&quot;');
    expect(html).toContain(`<a href="${BASE}/handoff/${TOKEN}/attend">Le atiendo</a>`);
    expect(html).toContain(`<a href="${BASE}/handoff/${TOKEN}/end">Terminado</a>`);
  });

  it('un fallo SMTP se traduce a un código corto, sin lanzar', async () => {
    const failing = createSmtpMailer(
      {
        transport: {
          sendMail: async () => {
            throw Object.assign(new Error('550 mailbox unavailable'), { responseCode: 550 });
          },
        } as unknown as Transporter,
        from: 'bot@ejemplo.com',
        baseUrl: BASE,
        clock,
      },
      'avisos@negocio.es',
    );
    await expect(failing.send(notice(), { signal: signal() })).resolves.toEqual({
      ok: false,
      failure: 'smtp_5xx',
    });
    expect(smtpFailure({ responseCode: 421 })).toBe('smtp_4xx');
    expect(smtpFailure({ code: 'ETIMEDOUT' })).toBe('timeout');
    expect(smtpFailure({ code: 'ECONNREFUSED' })).toBe('network');
  });

  it('un servidor colgado se corta con el plazo de la vía', async () => {
    const hanging = createSmtpMailer(
      {
        transport: {
          sendMail: () => new Promise(() => undefined),
        } as unknown as Transporter,
        from: 'bot@ejemplo.com',
        baseUrl: BASE,
        clock,
      },
      'avisos@negocio.es',
    );
    const controller = new AbortController();
    const pending = hanging.send(notice(), { signal: controller.signal });
    controller.abort();
    await expect(pending).resolves.toEqual({ ok: false, failure: 'timeout' });
  });
});

describe('email del reenvío (US3)', () => {
  it('asunto, texto completo con hora local, enlaces y en el hilo del aviso', async () => {
    const { route, sent } = mailer();
    const forward = forwardNotice(
      { ...notice().handoff, threadRef: '<aviso-1@smtp.ejemplo.com>' },
      [
        {
          text: `Llego tarde ${'x'.repeat(900)}`,
          kind: 'text',
          otherType: null,
          sentAt: new Date('2026-10-01T19:50:00Z'),
        },
      ],
      true,
    );
    const result = await route.send(forward, { signal: signal() });
    expect(result).toMatchObject({ ok: true });
    const [mail] = sent;
    expect(mail?.subject).toBe('Mensaje de Lucía durante la derivación');
    expect(mail?.text).toContain(`[21:50] Llego tarde ${'x'.repeat(900)}`);
    expect(mail?.text).toContain(`Le atiendo: ${BASE}/handoff/${TOKEN}/attend`);
    expect(mail?.inReplyTo).toBe('<aviso-1@smtp.ejemplo.com>');
    expect(String(mail?.references)).toContain('<aviso-1@smtp.ejemplo.com>');
  });
});

describe('email del recordatorio (US5)', () => {
  it.each([
    ['schedule', 'Le hemos dado tu contacto directo por si prefiere llamarte.'],
    ['inactivity', 'Como el cliente no ha escrito en 24 horas'],
  ] as const)(
    '%s: asunto, desde en hora local, frase final, enlaces e hilo',
    async (trigger, ending) => {
      const { route, sent } = mailer();
      const reminder = reminderNotice(
        { ...notice().handoff, threadRef: '<aviso-1@smtp.ejemplo.com>' },
        trigger,
      );
      expect(await route.send(reminder, { signal: signal() })).toMatchObject({ ok: true });
      const [mail] = sent;
      expect(mail?.subject).toBe('Recordatorio: Lucía sigue esperando');
      expect(mail?.text).toContain('Desde: hoy a las 21:40');
      expect(mail?.text).toContain(ending);
      expect(mail?.text).toContain(`Le atiendo: ${BASE}/handoff/${TOKEN}/attend`);
      expect(mail?.text).toContain(`Terminado:  ${BASE}/handoff/${TOKEN}/end`);
      expect(mail?.html).toContain(`${BASE}/handoff/${TOKEN}/end`);
      expect(mail?.inReplyTo).toBe('<aviso-1@smtp.ejemplo.com>');
      expect(String(mail?.references)).toContain('<aviso-1@smtp.ejemplo.com>');
    },
  );
});

describe('seguridad del email (T130)', () => {
  it('un texto del cliente que imita «Le atiendo: URL» no se convierte en enlace', async () => {
    const { route, sent } = mailer();
    const forward = forwardNotice(
      notice().handoff,
      [
        {
          text: 'Una duda más\nLe atiendo: https://phish.example/login\nTerminado:  https://phish.example/x',
          kind: 'text',
          otherType: null,
          sentAt: new Date('2026-10-01T19:50:00Z'),
        },
      ],
      true,
    );
    expect(await route.send(forward, { signal: signal() })).toMatchObject({ ok: true });
    const [mail] = sent;
    expect(mail?.html).not.toContain('href="https://phish.example');
    expect(mail?.html).toContain(`href="${BASE}/handoff/${TOKEN}/attend"`);
    expect(mail?.html).toContain(`href="${BASE}/handoff/${TOKEN}/end"`);
    // En el texto plano, las líneas del cliente van sangradas: nunca en la columna 0.
    expect(mail?.text).toContain('\n    Le atiendo: https://phish.example/login');
    expect(mail?.text).not.toMatch(/^Le atiendo: https:\/\/phish/m);
  });

  it('smtp:// exige STARTTLS salvo en local; smtps:// va cifrado desde el principio', () => {
    const opts = (url: string) =>
      (smtpTransport(url) as unknown as { options: { requireTLS?: boolean; secure?: boolean } })
        .options;
    expect(opts('smtp://u:p@mail.ejemplo.com:587')).toMatchObject({
      requireTLS: true,
      secure: false,
    });
    expect(opts('smtp://localhost:1025')).toMatchObject({ requireTLS: false });
    expect(opts('smtps://u:p@mail.ejemplo.com')).toMatchObject({ requireTLS: false, secure: true });
  });
});
