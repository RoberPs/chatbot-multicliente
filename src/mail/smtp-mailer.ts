/**
 * Vía de aviso por email (005, R7, contracts/business-alerts.md § Email) con nodemailer. De
 * `SMTP_FROM` al email de avisos del negocio: texto plano y HTML equivalente, con todo el
 * contenido del cliente escapado. Entregado = el servidor SMTP aceptó el mensaje; no lanza.
 */
import nodemailer, { type Transporter } from 'nodemailer';
import type { Clock } from '../conversation/ports.js';
import {
  alertEmail,
  forwardEmail,
  handoffLinks,
  reminderEmail,
  type EmailContent,
} from '../handoff/notices.js';
import type { AlertRoute, AlertSendResult } from '../handoff/ports.js';
import type { BusinessNotice } from '../handoff/types.js';

export interface SmtpMailerOptions {
  /** Transporte ya construido (tests) o la URL `SMTP_URL`. */
  transport: Transporter | string;
  from: string;
  /** PUBLIC_BASE_URL, para los enlaces «Le atiendo» y «Terminado». */
  baseUrl: string;
  clock: Clock;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Transporte de nodemailer desde `SMTP_URL`, con plazos por debajo de los 15 s de la vía. */
export function smtpTransport(url: string): Transporter {
  const parsed = new URL(url);
  const secure = parsed.protocol === 'smtps:';
  return nodemailer.createTransport({
    host: parsed.hostname,
    port: parsed.port === '' ? (secure ? 465 : 587) : Number(parsed.port),
    secure,
    // Con smtp:// se exige STARTTLS: si no, un intermediario podría quitarlo y la contraseña y
    // los enlaces irían en claro. En local (Mailpit) no hay TLS.
    requireTLS: !secure && !LOCAL_HOSTS.has(parsed.hostname),
    ...(parsed.username
      ? {
          auth: {
            user: decodeURIComponent(parsed.username),
            pass: decodeURIComponent(parsed.password),
          },
        }
      : {}),
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 14_000,
  });
}

const escapeHtml = (text: string): string =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

/**
 * HTML equivalente al texto: cada línea escapada. Solo las líneas que son exactamente los
 * enlaces de esta derivación se convierten en enlaces; un texto del cliente que imite una de
 * esas líneas se queda como texto.
 */
export function emailHtml(text: string, links: { attend: string; end: string }): string {
  const own = new Map([
    [`Le atiendo: ${links.attend}`, { label: 'Le atiendo', href: links.attend }],
    [`Terminado:  ${links.end}`, { label: 'Terminado', href: links.end }],
  ]);
  const lines = text.split('\n').map((line) => {
    const link = own.get(line);
    if (link) return `<a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a>`;
    return escapeHtml(line);
  });
  return `<!doctype html><html lang="es"><body><p>${lines.join('<br>\n')}</p></body></html>`;
}

/** Contenido del email de un aviso; `null` si esta vía aún no lo envía. */
function contentFor(notice: BusinessNotice, now: Date, baseUrl: string): EmailContent | null {
  switch (notice.type) {
    case 'alert':
      return alertEmail(notice, now, baseUrl);
    case 'forward':
      return forwardEmail(notice, baseUrl);
    case 'reminder':
      return reminderEmail(notice, now, baseUrl);
  }
}

/** Código corto del fallo, sin textos del servidor (contracts/activity-log.md). */
export function smtpFailure(error: unknown): string {
  const e = error as { responseCode?: unknown; code?: unknown };
  if (typeof e.responseCode === 'number') {
    if (e.responseCode >= 500) return 'smtp_5xx';
    if (e.responseCode >= 400) return 'smtp_4xx';
  }
  if (e.code === 'ETIMEDOUT' || e.code === 'ETIMEOUT') return 'timeout';
  return 'network';
}

/** Vía email hacia la dirección de avisos `to`. */
export function createSmtpMailer(opts: SmtpMailerOptions, to: string): AlertRoute {
  const transport =
    typeof opts.transport === 'string' ? smtpTransport(opts.transport) : opts.transport;
  return {
    name: 'email',
    async send(notice, { signal }): Promise<AlertSendResult> {
      const content = contentFor(notice, opts.clock.now(), opts.baseUrl);
      if (!content) return { ok: false, failure: 'unsupported' };
      // El plazo puede agotarse antes de empezar o mientras se espera al servidor.
      const timedOut = () => signal.aborted;
      if (timedOut()) return { ok: false, failure: 'timeout' };
      const thread = notice.handoff.threadRef;
      const sending = transport.sendMail({
        from: opts.from,
        to,
        subject: content.subject,
        text: content.text,
        html: emailHtml(content.text, handoffLinks(opts.baseUrl, notice.handoff.token)),
        ...(thread && notice.type !== 'alert' ? { inReplyTo: thread, references: [thread] } : {}),
      });
      const aborted = new Promise<'aborted'>((resolve) => {
        signal.addEventListener('abort', () => {
          resolve('aborted');
        });
      });
      try {
        const info = await Promise.race([sending, aborted]);
        if (info === 'aborted') return { ok: false, failure: 'timeout' };
        return { ok: true, ref: typeof info.messageId === 'string' ? info.messageId : null };
      } catch (error) {
        return { ok: false, failure: timedOut() ? 'timeout' : smtpFailure(error) };
      }
    },
  };
}
