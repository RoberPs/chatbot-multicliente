/**
 * Rutas públicas del chat web (004, contracts/web-chat-http.md).
 *
 * Plugin encapsulado: aquí viven el fragmento que el negocio inserta, los assets del iframe y
 * la vista del chat. La API JSON (`/chat/api/*`) se añade con la historia 3.
 *
 * El frame se sirve sin caché y con su propia CSP: `frame-ancestors` con las webs permitidas
 * cuando el chat está activado y `'none'` en cualquier otro caso, que es lo que de verdad
 * impide que otra web lo incruste (FR-015, FR-027).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Eta } from 'eta';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { unavailable, webChatAvailability } from '../../webchat/availability.js';
import { frameAncestors, NO_ANCESTORS, refererAllowed } from './guards.js';

const assetsDir = fileURLToPath(new URL('./assets', import.meta.url));
const viewsDir = fileURLToPath(new URL('./views', import.meta.url));
const asset = (name: string) => readFileSync(`${assetsDir}/${name}`, 'utf8');

const widgetSource = asset('widget.js');
const frameScript = asset('frame.js');
const frameStyles = asset('frame.css');

/** Longitud máxima de un mensaje del visitante (FR-020). */
export const WEB_MESSAGE_MAX_CHARS = 1000;

/** CSP del frame; solo cambia `frame-ancestors`. */
const frameCsp = (ancestors: string): string =>
  [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "connect-src 'self'",
    "img-src 'self' data:",
    `frame-ancestors ${ancestors}`,
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
  ].join('; ');

/** Rutas cuyo `Content-Security-Policy` lo pone este plugin, no la cabecera global. */
export const CHAT_FRAME_PATH = '/chat/frame';

export async function webChatRoutes(chat: FastifyInstance): Promise<void> {
  const eta = new Eta({ views: viewsDir, cache: chat.env.NODE_ENV === 'production' });
  const { db } = chat.knowledge;

  // La cabecera global pone `same-origin`; el chat no manda referente a ninguna parte.
  chat.addHook('onSend', async (_request, reply) => {
    reply.header('Referrer-Policy', 'no-referrer');
  });

  const cached = (reply: FastifyReply, type: string, body: string) =>
    reply
      .type(`${type}; charset=utf-8`)
      .header('Cache-Control', 'public, max-age=3600')
      .send(body);

  // Siempre disponible, también sin bot: quien decide si hay chat es el frame.
  chat.get('/widget.js', async (_request, reply) =>
    cached(reply, 'text/javascript', widgetSource),
  );
  chat.get('/assets/frame.js', async (_request, reply) =>
    cached(reply, 'text/javascript', frameScript),
  );
  chat.get('/assets/frame.css', async (_request, reply) =>
    cached(reply, 'text/css', frameStyles),
  );

  chat.get('/frame', async (request, reply) => {
    const bot = chat.bot;
    const availability = bot
      ? await webChatAvailability({
          tx: db,
          reader: bot.reader,
          botPresent: true,
          emergencyPhone: bot.emergencyContactPhone,
          now: bot.clock.now(),
        })
      : {
          available: false as const,
          unavailable: unavailable('no_bot', null, chat.env.emergencyContactPhone),
        };

    // FR-027: si el navegador dice de dónde viene y no es una web permitida, no se sirve.
    const allowed =
      availability.available &&
      refererAllowed(request.headers.referer, availability.settings.allowedOrigins);

    const view = allowed
      ? {
          available: true,
          businessName: availability.snapshot.business.name,
          privacyUrl: availability.settings.privacyUrl,
          maxLength: WEB_MESSAGE_MAX_CHARS,
        }
      : {
          available: false,
          ...(availability.available
            ? unavailable('disabled', availability.snapshot, bot?.emergencyContactPhone ?? null)
            : availability.unavailable),
        };

    const html = await eta.renderAsync('frame', view);
    return reply
      .header('Content-Security-Policy', frameCsp(allowed ? frameAncestors(availability.settings) : NO_ANCESTORS))
      .header('Cache-Control', 'no-store')
      .type('text/html; charset=utf-8')
      .send(html);
  });
}
