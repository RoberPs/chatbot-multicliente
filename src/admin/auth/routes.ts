import argon2 from 'argon2';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { createActivityLog } from '../../conversation/activity-log.js';
import {
  DEVICE_COOKIE,
  DEVICE_COOKIE_TTL_MS,
  deviceKey,
  signDeviceCookie,
  verifyDeviceCookie,
} from './login-throttle.js';
import { themeFromCookieHeader } from '../theme.js';
import {
  csrfOnPost,
  endOperatorSession,
  hasOperatorSession,
  requireOperator,
  startOperatorSession,
} from './plugin.js';

const LOGIN_ERROR = 'Usuario o contraseña incorrectos';
const QUEUE_FULL = 'Demasiados intentos. Inténtalo en unos segundos.';

/** Límite por dirección (rate-limit, clave /64 común). */
const PER_IP_MAX = 5;
/** `login_throttled` como mucho una vez por minuto. */
const THROTTLE_LOG_MS = 60_000;

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Valor de una cookie de la petición, sin depender del parser de la sesión. */
function cookieValue(request: FastifyRequest, name: string): string | undefined {
  for (const part of (request.headers.cookie ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return undefined;
}

/**
 * Login del operador (007; 012, US4): límite por dirección → CSRF → retardo por los fallos
 * recientes (salvo navegador conocido) → cola de verificaciones → Argon2id siempre y usuario en
 * tiempo constante → error único. El contador global ya no bloquea: solo frena.
 */
export async function authRoutes(app: FastifyInstance): Promise<void> {
  const throttle = app.loginThrottle;
  const key = deviceKey(app.env.SESSION_SECRET);
  const production = app.env.NODE_ENV === 'production';
  const activityLog = app.bot?.activityLog ?? createActivityLog(app.log, app.env.SESSION_SECRET);
  let lastThrottleLog = -Infinity;

  /** Registro del freno, sin dirección ni usuario, como mucho uno por minuto. */
  const logThrottled = (delayMs: number) => {
    const now = Date.now();
    if (now - lastThrottleLog < THROTTLE_LOG_MS) return;
    lastThrottleLog = now;
    const { queued, rejected } = throttle.stats();
    activityLog.log({ event: 'login_throttled', delayMs, queued, rejected });
  };

  const renderLogin = async (
    request: FastifyRequest,
    reply: FastifyReply,
    status: number,
    error?: string,
    user = '',
  ) => {
    const html = await reply.viewAsync('login', {
      csrf: reply.generateCsrf(),
      error,
      user,
      // 014: la pantalla de acceso lleva el mismo tema que el panel (FR-002).
      theme: themeFromCookieHeader(request.headers.cookie),
    });
    return reply.code(status).type('text/html; charset=utf-8').send(html);
  };

  app.get('/login', async (request, reply) => {
    if (hasOperatorSession(request)) return reply.redirect('/admin', 302);
    return renderLogin(request, reply, 200);
  });

  app.post<{ Body: { user?: string; password?: string } }>(
    '/login',
    {
      preHandler: csrfOnPost(app),
      config: { rateLimit: { max: PER_IP_MAX, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const user = typeof request.body.user === 'string' ? request.body.user.trim() : '';
      const password = typeof request.body.password === 'string' ? request.body.password : '';
      const known = verifyDeviceCookie(key, cookieValue(request, DEVICE_COOKIE), Date.now());

      const delay = known ? 0 : throttle.delayMs();
      if (delay > 0) {
        logThrottled(delay);
        await throttle.sleep(delay);
      }
      // Se verifica siempre la contraseña para no revelar por el tiempo si el usuario existe.
      const verified = await throttle.run(async () => {
        const passwordOk = await argon2
          .verify(app.env.OPERATOR_PASSWORD_HASH, password)
          .catch(() => false);
        return passwordOk && sameText(user, app.env.OPERATOR_USER);
      }, known);
      if (verified === 'full') {
        // Sin verificar y sin contar como fallo.
        logThrottled(delay);
        return renderLogin(request, reply, 429, QUEUE_FULL, user);
      }
      if (!verified) {
        throttle.failure();
        request.log.warn('Intento de acceso fallido al panel');
        return renderLogin(request, reply, 401, LOGIN_ERROR, user);
      }
      startOperatorSession(request);
      reply.header(
        'set-cookie',
        [
          `${DEVICE_COOKIE}=${signDeviceCookie(key, Date.now())}`,
          `Max-Age=${String(DEVICE_COOKIE_TTL_MS / 1000)}`,
          'Path=/',
          'HttpOnly',
          'SameSite=Strict',
          ...(production ? ['Secure'] : []),
        ].join('; '),
      );
      return reply.redirect('/admin', 303);
    },
  );

  app.post(
    '/logout',
    { onRequest: requireOperator, preHandler: csrfOnPost(app) },
    async (request, reply) => {
      endOperatorSession(request);
      return reply.redirect('/admin/login', 303);
    },
  );
}
