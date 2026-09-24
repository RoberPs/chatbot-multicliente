import argon2 from 'argon2';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import {
  csrfOnPost,
  endOperatorSession,
  hasOperatorSession,
  requireOperator,
  startOperatorSession,
} from './plugin.js';

const LOGIN_ERROR = 'Usuario o contraseña incorrectos';

/** Límite por IP (rate-limit) y límite global de fallos, que no depende de la IP. */
const PER_IP_MAX = 5;
const GLOBAL_FAILURES_MAX = 20;
const GLOBAL_WINDOW_MS = 15 * 60 * 1000;

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // Solo hay una cuenta: aunque el atacante cambie de IP, los fallos se cuentan en conjunto.
  let failures: number[] = [];
  const recentFailures = () => {
    const since = Date.now() - GLOBAL_WINDOW_MS;
    failures = failures.filter((t) => t > since);
    return failures.length;
  };

  const renderLogin = async (reply: FastifyReply, status: number, error?: string, user = '') => {
    const html = await reply.viewAsync('login', { csrf: reply.generateCsrf(), error, user });
    return reply.code(status).type('text/html; charset=utf-8').send(html);
  };

  app.get('/login', async (request, reply) => {
    if (hasOperatorSession(request)) return reply.redirect('/admin', 302);
    return renderLogin(reply, 200);
  });

  app.post<{ Body: { user?: string; password?: string } }>(
    '/login',
    {
      preHandler: csrfOnPost(app),
      config: { rateLimit: { max: PER_IP_MAX, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      if (recentFailures() >= GLOBAL_FAILURES_MAX) {
        request.log.warn('Login bloqueado temporalmente por exceso de intentos fallidos');
        return renderLogin(reply, 429, 'Demasiados intentos. Espera unos minutos.');
      }
      const user = typeof request.body.user === 'string' ? request.body.user.trim() : '';
      const password = typeof request.body.password === 'string' ? request.body.password : '';
      // Se verifica siempre la contraseña para no revelar por el tiempo si el usuario existe.
      const passwordOk = await argon2
        .verify(app.env.OPERATOR_PASSWORD_HASH, password)
        .catch(() => false);
      if (!passwordOk || !sameText(user, app.env.OPERATOR_USER)) {
        failures.push(Date.now());
        request.log.warn('Intento de acceso fallido al panel');
        return renderLogin(reply, 401, LOGIN_ERROR, user);
      }
      startOperatorSession(request);
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
