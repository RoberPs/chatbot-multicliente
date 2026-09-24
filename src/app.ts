import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import formbody from '@fastify/formbody';
import rateLimit from '@fastify/rate-limit';
import view from '@fastify/view';
import { Eta } from 'eta';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import type { CountryCode } from 'libphonenumber-js';
import { authPlugin, csrfOnPost, requireOperator } from './admin/auth/plugin.js';
import { authRoutes } from './admin/auth/routes.js';
import './admin/fastify-types.js';
import { renderNotFound } from './admin/render.js';
import { adminRoutes } from './admin/routes/index.js';
import type { Env } from './config/env.js';
import type { Db } from './db/client.js';

const viewsDir = fileURLToPath(new URL('./admin/views', import.meta.url));
const require = createRequire(import.meta.url);
const htmxSource = readFileSync(require.resolve('htmx.org/dist/htmx.min.js'), 'utf8');
const cssSource = readFileSync(
  fileURLToPath(new URL('./admin/views/app.css', import.meta.url)),
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

export interface BuildAppOptions {
  env: Env;
  db: Db;
  logger?: boolean;
}

export async function buildApp({
  env,
  db,
  logger = true,
}: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: logger
      ? {
          level: env.NODE_ENV === 'production' ? 'info' : 'debug',
          // Nunca se registran cookies, cabeceras de autorización ni cuerpos.
          redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
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
  app.decorate('knowledge', { db, phoneRegion: env.DEFAULT_PHONE_REGION as CountryCode });

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
    reply.header('X-Frame-Options', 'DENY');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('Content-Security-Policy', CSP);
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
  app.get('/assets/app.css', async (_request, reply) =>
    reply
      .type('text/css; charset=utf-8')
      .header('Cache-Control', 'public, max-age=3600')
      .send(cssSource),
  );
  app.get('/', async (_request, reply) => reply.redirect('/admin', 302));

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

  return app;
}
