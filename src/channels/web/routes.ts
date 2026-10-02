/**
 * Rutas públicas del chat web (004, contracts/web-chat-http.md).
 *
 * Plugin encapsulado: aquí viven el fragmento que el negocio inserta, los assets del iframe,
 * la vista del chat y, bajo `/chat/api`, su API JSON.
 *
 * El frame se sirve sin caché y con su propia CSP: `frame-ancestors` con las webs permitidas
 * cuando el chat está activado (también con un tope alcanzado, para mostrar el contacto) y
 * `'none'` en cualquier otro caso, que es lo que de verdad impide que otra web lo incruste
 * (FR-015, FR-027).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Eta } from 'eta';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { unavailable, webChatAvailability } from '../../webchat/availability.js';
import { renderDesignCss } from '../../webchat/design/css.js';
import {
  originalResolved,
  SLOTS,
  type ResolvedChatDesign,
  type Slot,
} from '../../webchat/design/defaults.js';
import { IMAGE_EXTENSIONS } from '../../webchat/design/images.js';
import { readChatDesign, readDesignImageBytes } from '../../webchat/design/store.js';
import { computeTheme, designVersion } from '../../webchat/design/theme.js';
import { readWebChatSettings } from '../../webchat/settings.js';
import { webChatApi, WEB_MESSAGE_MAX_CHARS } from './api.js';
import { frameAncestors, NO_ANCESTORS, refererAllowed } from './guards.js';

const assetsDir = fileURLToPath(new URL('./assets', import.meta.url));
const viewsDir = fileURLToPath(new URL('./views', import.meta.url));
const asset = (name: string) => readFileSync(`${assetsDir}/${name}`, 'utf8');

const widgetSource = asset('widget.js');
const frameScript = asset('frame.js');
const linksScript = asset('links.js');
const frameStyles = asset('frame.css');

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
/** Imágenes del diseño (011, R10): llevan su propia CSP con `sandbox`. */
export const CHAT_DESIGN_IMAGES_PREFIX = '/chat/design/';

/** `<16 hex del SHA-256>.<png|jpg|webp>` (R10). */
const IMAGE_FILE = /^([0-9a-f]{16})\.(png|jpg|webp)$/;

/**
 * CSP de respaldo del frame para las respuestas que no pasan por su manejador (un error
 * inesperado): nadie puede incrustarla.
 */
export const FRAME_FALLBACK_CSP = frameCsp(NO_ANCESTORS);

export async function webChatRoutes(chat: FastifyInstance): Promise<void> {
  const eta = new Eta({ views: viewsDir, cache: chat.env.NODE_ENV === 'production' });
  const { db } = chat.knowledge;

  // La cabecera global pone `same-origin`; el chat no manda referente a ninguna parte.
  chat.addHook('onSend', async (_request, reply) => {
    reply.header('Referrer-Policy', 'no-referrer');
  });

  const cached = (reply: FastifyReply, type: string, body: string) =>
    reply.type(`${type}; charset=utf-8`).header('Cache-Control', 'public, max-age=3600').send(body);

  // Siempre disponible, también sin bot: quien decide si hay chat es el frame.
  chat.get('/widget.js', async (_request, reply) => cached(reply, 'text/javascript', widgetSource));
  chat.get('/assets/frame.js', async (_request, reply) =>
    cached(reply, 'text/javascript', frameScript),
  );
  chat.get('/assets/links.js', async (_request, reply) =>
    cached(reply, 'text/javascript', linksScript),
  );
  chat.get('/assets/frame.css', async (_request, reply) => cached(reply, 'text/css', frameStyles));

  /**
   * Diseño guardado, leído en cada petición sin caché (011, FR-012). Si la lectura falla se
   * registra y se sirve el chat original: el diseño nunca deja sin chat (FR-018).
   */
  async function loadDesign(): Promise<ResolvedChatDesign> {
    try {
      return await readChatDesign(db);
    } catch (error) {
      chat.log.error({ err: error, event: 'chat_design_read_failed' }, 'No se pudo leer el diseño del chat');
      return originalResolved();
    }
  }

  // Solo propiedades personalizadas calculadas por el servidor (011, R2); `v` se ignora.
  chat.get('/design.css', async (_request, reply) => {
    const css = renderDesignCss(computeTheme(await loadDesign(), ''));
    return reply.type('text/css; charset=utf-8').header('Cache-Control', 'no-store').send(css);
  });

  /**
   * Imágenes del diseño (011, R10, FR-031, FR-032): solo la imagen vigente del hueco, con su
   * tipo detectado y caché inmutable (la URL cambia con el contenido). Cualquier otra cosa, 404.
   */
  chat.get<{ Params: { slot: string; file: string } }>(
    '/design/:slot/:file',
    async (request, reply) => {
      const { slot, file } = request.params;
      const match = IMAGE_FILE.exec(file);
      const image =
        match && (SLOTS as readonly string[]).includes(slot)
          ? await readDesignImageBytes(db, slot as Slot).catch(() => null)
          : null;
      if (
        !match ||
        !image ||
        image.sha256.slice(0, 16) !== match[1] ||
        IMAGE_EXTENSIONS[image.mimeType] !== match[2]
      ) {
        return reply.code(404).type('text/plain; charset=utf-8').send('No encontrado');
      }
      return reply
        .type(image.mimeType)
        .header('Cache-Control', 'public, max-age=31536000, immutable')
        .header('Content-Disposition', 'inline')
        .header('Content-Security-Policy', "default-src 'none'; sandbox")
        .header('Cross-Origin-Resource-Policy', 'same-origin')
        .send(image.bytes);
    },
  );

  await chat.register(webChatApi, {
    prefix: '/api',
    db,
    bot: chat.bot,
    emergencyPhone: chat.bot?.emergencyContactPhone ?? chat.env.emergencyContactPhone,
    sessionSecret: chat.env.SESSION_SECRET,
  });

  chat.get('/frame', async (request, reply) => {
    const bot = chat.bot;
    const availability = bot
      ? await webChatAvailability({
          tx: db,
          reader: bot.reader,
          botPresent: true,
          emergencyPhone: bot.emergencyContactPhone,
          now: bot.clock.now(),
          activityLog: bot.activityLog,
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

    // Con un tope alcanzado (respuestas de la 004 o gasto de la 010) el chat sigue activado: el
    // frame se deja incrustar en las webs permitidas para que el visitante vea "no disponible"
    // con el contacto (010 US3-3, SC-004). En los demás casos, nadie puede incrustarlo.
    let ancestors = NO_ANCESTORS;
    if (allowed) {
      ancestors = frameAncestors(availability.settings);
    } else if (!availability.available && availability.unavailable.reason === 'quota') {
      const settings = await readWebChatSettings(db);
      if (refererAllowed(request.headers.referer, settings.allowedOrigins)) {
        ancestors = frameAncestors(settings);
      }
    }

    const design = await loadDesign();
    const businessName = availability.available ? availability.snapshot.business.name : '';
    const html = await eta.renderAsync('frame', {
      ...view,
      theme: computeTheme(design, businessName),
      // La hoja del diseño solo se enlaza si hay diseño guardado (R2); sin él, el HTML de la 004.
      designHref: design.saved ? `/chat/design.css?v=${designVersion(design)}` : null,
    });
    return reply
      .header('Content-Security-Policy', frameCsp(ancestors))
      .header('Cache-Control', 'no-store')
      .type('text/html; charset=utf-8')
      .send(html);
  });
}
