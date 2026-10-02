import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import formbody from '@fastify/formbody';
import rateLimit from '@fastify/rate-limit';
import view from '@fastify/view';
import { Eta } from 'eta';
import Fastify, { type FastifyBaseLogger, type FastifyError, type FastifyInstance } from 'fastify';
import type { CountryCode } from 'libphonenumber-js';
import { authPlugin, csrfOnPost, requireOperator } from './admin/auth/plugin.js';
import { authRoutes } from './admin/auth/routes.js';
import './admin/fastify-types.js';
import { renderNotFound } from './admin/render.js';
import { CHAT_DESIGN_PREVIEW_PATHS } from './admin/routes/chat-design.js';
import { adminRoutes } from './admin/routes/index.js';
import { handoffLinkRoutes } from './channels/handoff-links/routes.js';
import { healthRoutes } from './channels/health/routes.js';
import { CHAT_FRAME_PATH, FRAME_FALLBACK_CSP, webChatRoutes } from './channels/web/routes.js';
import { whatsappWebhook } from './channels/whatsapp/webhook.js';
import type { Env, WhatsAppEnv } from './config/env.js';
import type { ActivityLog } from './conversation/activity-log.js';
import type { Intake } from './conversation/intake.js';
import type { Clock } from './conversation/ports.js';
import type { Db } from './db/client.js';
import type { HandoffService } from './handoff/service.js';
import { createInstanceHealth, type InstanceHealth } from './health/report.js';
import { readCoreVersion } from './health/version.js';
import type { KnowledgeReader } from './knowledge/types.js';

const viewsDir = fileURLToPath(new URL('./admin/views', import.meta.url));
const require = createRequire(import.meta.url);
const htmxSource = readFileSync(require.resolve('htmx.org/dist/htmx.min.js'), 'utf8');
const cssSource = readFileSync(
  fileURLToPath(new URL('./admin/views/app.css', import.meta.url)),
  'utf8',
);
const adminJsSource = readFileSync(
  fileURLToPath(new URL('./admin/views/app.js', import.meta.url)),
  'utf8',
);
const chatDesignJsSource = readFileSync(
  fileURLToPath(new URL('./admin/views/chat-design.js', import.meta.url)),
  'utf8',
);

/** Content-Security-Policy del panel: todo se sirve desde el propio origen, sin inline. */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join('; ');

/**
 * Lo que el servidor HTTP necesita del bot: el webhook de WhatsApp (si está configurado), el
 * chat web y "Probar el bot" del panel.
 */
export interface BotHttp {
  /** `null` sin WhatsApp: el webhook no se registra. */
  whatsapp: WhatsAppEnv | null;
  audioTranscription: boolean;
  activityLog: ActivityLog;
  /** Recepción común a todos los canales. */
  intake: Intake;
  /** Snapshot sin caché, para el contacto del chat web y el estado del negocio. */
  reader: KnowledgeReader;
  /** Contacto de la instancia cuando no se puede leer el snapshot (FR-022). */
  emergencyContactPhone: string | null;
  clock: Clock;
  /** Derivación al negocio (005): enlaces del email y fin desde el panel. */
  handoff?: HandoffService;
}

export interface BuildAppOptions {
  env: Env;
  db: Db;
  logger?: boolean;
  /** Destino de los registros en lugar de la salida estándar (tests de los registros). */
  logStream?: { write(line: string): void };
  /**
   * Bot; sin él, la instancia solo sirve el panel y el chat web "no disponible". Puede ser una
   * función que recibe el logger de la app (el bot registra sus eventos con él).
   */
  bot?: BotHttp | ((log: FastifyBaseLogger) => BotHttp | null) | null;
  /**
   * Salud de la instancia (009): ciclo de vida e informe de `/health` y del pie del panel. Por
   * defecto, el sondeo real contra `DATABASE_URL` con la versión de `package.json`.
   */
  health?: InstanceHealth;
}

/**
 * URL tal como se registra: el token de los enlaces del email es una credencial y va en la
 * ruta, así que se sustituye (005, FR-022).
 */
export const loggedUrl = (url: string): string =>
  url.replace(/^\/handoff\/(?!assets\/)[^/?#]+/, '/handoff/:token');

export async function buildApp({
  env,
  db,
  logger = true,
  logStream,
  bot = null,
  health = createInstanceHealth({
    databaseUrl: env.DATABASE_URL,
    coreVersion: readCoreVersion(),
  }),
}: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: logger
      ? {
          level: env.NODE_ENV === 'production' ? 'info' : 'debug',
          ...(logStream ? { stream: logStream } : {}),
          // Nunca se registran cookies, cabeceras de autorización ni cuerpos.
          redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
          // Sin IP ni puerto del cliente en ningún registro (004, R10, SC-008).
          serializers: {
            req: (request: { method: string; url: string; hostname: string }) => ({
              method: request.method,
              url: loggedUrl(request.url),
              hostname: request.hostname,
            }),
          },
        }
      : false,
    // Solo los proxies declarados; con `true` el cliente podría falsear su IP (X-Forwarded-For).
    trustProxy:
      typeof env.TRUST_PROXY === 'number'
        ? (() => {
            const hops = env.TRUST_PROXY;
            return (_address: string, hop: number) => hop < hops;
          })()
        : env.TRUST_PROXY,
    // El panel solo recibe formularios pequeños.
    bodyLimit: 256 * 1024,
  });
  // Sin API JSON: el panel acepta únicamente application/x-www-form-urlencoded.
  app.removeContentTypeParser(['application/json', 'text/plain']);

  app.decorate('env', env);
  app.decorate('knowledge', {
    db,
    phoneRegion: env.DEFAULT_PHONE_REGION as CountryCode,
    // Vías de aviso de derivación que la instancia puede usar (005, R16).
    alertRoutes: {
      whatsapp: env.whatsapp !== null,
      email: env.smtp !== null && env.PUBLIC_BASE_URL !== undefined,
    },
  });
  const channel = (typeof bot === 'function' ? bot(app.log) : bot) ?? null;
  app.decorate('bot', channel);
  app.decorate('health', health);
  app.decorate('lifecycle', health.lifecycle);
  // El pool propio del sondeo se cierra con la app.
  app.addHook('onClose', async () => {
    await health.close?.();
  });

  await app.register(formbody);
  await app.register(rateLimit, { global: false });
  await app.register(view, {
    engine: { eta: new Eta({ views: viewsDir, cache: env.NODE_ENV === 'production' }) },
    templates: viewsDir,
    production: env.NODE_ENV === 'production',
  });
  await app.register(authPlugin);

  // Antes de registrar las rutas: los contextos hijos heredan el manejador.
  app.setErrorHandler(async (error: FastifyError, request, reply) => {
    const status = error.statusCode ?? 500;
    if (status === 403) {
      return reply
        .code(403)
        .type('text/plain; charset=utf-8')
        .send('Formulario caducado o no válido. Recarga la página e inténtalo de nuevo.');
    }
    if (status < 500) {
      return reply.code(status).type('text/plain; charset=utf-8').send(error.message);
    }
    request.log.error({ err: error }, 'Error no controlado');
    return reply
      .code(500)
      .type('text/plain; charset=utf-8')
      .send('Error interno. Inténtalo de nuevo.');
  });

  // Cabeceras de seguridad en todas las respuestas.
  app.addHook('onSend', async (request, reply) => {
    // El chat web se incrusta en la web del negocio: su CSP la pone su propio plugin y no
    // puede llevar X-Frame-Options (lo sustituye `frame-ancestors`, 004 FR-015).
    const path = request.url.split('?')[0] ?? '';
    const isChatFrame = path === CHAT_FRAME_PATH;
    // La vista previa del diseño (011, R9) se incrusta en el propio panel: pone su CSP y
    // `X-Frame-Options: SAMEORIGIN`. Sin ellas (sin sesión, un error), las del panel.
    const isDesignPreview = CHAT_DESIGN_PREVIEW_PATHS.includes(path);
    if (isChatFrame) {
      // Si el manejador del frame no llegó a responder (p. ej. un 500), la respuesta saldría
      // sin ninguna CSP: se pone la de respaldo, que no permite incrustarla en ningún sitio.
      if (reply.getHeader('content-security-policy') === undefined) {
        reply.header('Content-Security-Policy', FRAME_FALLBACK_CSP);
      }
    } else if (!isDesignPreview || reply.getHeader('content-security-policy') === undefined) {
      reply.header('X-Frame-Options', 'DENY');
      reply.header('Content-Security-Policy', CSP);
    }
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    if (env.NODE_ENV === 'production') {
      reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    if (request.url.startsWith('/admin')) reply.header('Cache-Control', 'no-store');
  });

  app.get('/assets/htmx.min.js', async (_request, reply) =>
    reply
      .type('text/javascript; charset=utf-8')
      .header('Cache-Control', 'public, max-age=86400')
      .send(htmxSource),
  );
  app.get('/assets/app.js', async (_request, reply) =>
    reply
      .type('text/javascript; charset=utf-8')
      .header('Cache-Control', 'public, max-age=3600')
      .send(adminJsSource),
  );
  // Vista previa en vivo de "Diseño del chat" (011, R9): solo actúa en esa sección.
  app.get('/assets/chat-design.js', async (_request, reply) =>
    reply
      .type('text/javascript; charset=utf-8')
      .header('Cache-Control', 'public, max-age=3600')
      .send(chatDesignJsSource),
  );
  app.get('/assets/app.css', async (_request, reply) =>
    reply
      .type('text/css; charset=utf-8')
      .header('Cache-Control', 'public, max-age=3600')
      .send(cssSource),
  );
  app.get('/', async (_request, reply) => reply.redirect('/admin', 302));

  // Salud de la instancia (009): fuera de /admin, sin sesión ni CSRF, con límite propio.
  await app.register(healthRoutes, {
    report: () => health.report(),
    secret: env.HEALTH_SECRET,
    instanceId: env.INSTANCE_ID ?? null,
  });

  await app.register(
    async (admin) => {
      await admin.register(authRoutes);
      await admin.register(async (operator) => {
        operator.addHook('onRequest', requireOperator);
        operator.addHook('preHandler', csrfOnPost(operator));
        await operator.register(adminRoutes);
        operator.setNotFoundHandler(async (request, reply) => renderNotFound(request, reply));
      });
    },
    { prefix: '/admin' },
  );

  // Enlaces «Le atiendo» y «Terminado» del email (005, R8): solo con bot.
  const handoff = channel?.handoff;
  if (channel && handoff) {
    await app.register(handoffLinkRoutes, {
      prefix: '/handoff',
      handoff,
      now: () => channel.clock.now(),
      production: env.NODE_ENV === 'production',
    });
  }

  // El chat web se registra siempre: sin bot sirve el fragmento y la vista "no disponible".
  await app.register(webChatRoutes, { prefix: '/chat' });

  const whatsapp = channel?.whatsapp;
  if (channel && whatsapp) {
    await app.register(whatsappWebhook, {
      prefix: '/webhooks/whatsapp',
      config: whatsapp,
      audioTranscription: channel.audioTranscription,
      activityLog: channel.activityLog,
      onInbound: (events) => channel.intake.handle(events),
    });
  }

  return app;
}
