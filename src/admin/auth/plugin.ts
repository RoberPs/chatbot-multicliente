import { randomUUID } from 'node:crypto';
import csrfProtection from '@fastify/csrf-protection';
import secureSession from '@fastify/secure-session';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import '../fastify-types.js';

export const SESSION_COOKIE = 'kb_session';
/** Duración máxima de una sesión desde el login, aunque haya actividad. */
export const SESSION_MAX_MS = 8 * 3600 * 1000;

/**
 * Sesión del operador (research R10): cookie cifrada `HttpOnly`, `SameSite=Strict`, `Secure`
 * salvo en desarrollo y tests, y protección CSRF.
 *
 * La cookie no se guarda en el servidor; para poder revocarla, cada sesión lleva la "época"
 * vigente del proceso. Cerrar sesión (o reiniciar) cambia la época e invalida todas las
 * cookies emitidas antes. Con un único operador por instancia es suficiente.
 */
export const authPlugin = fp(async (app: FastifyInstance) => {
  app.decorate('sessionEpoch', { value: randomUUID() });
  await app.register(secureSession, {
    cookieName: SESSION_COOKIE,
    key: Buffer.from(app.env.SESSION_SECRET, 'hex'),
    expiry: SESSION_MAX_MS / 1000,
    cookie: {
      path: '/',
      httpOnly: true,
      sameSite: 'strict',
      secure: app.env.NODE_ENV === 'production',
    },
  });
  await app.register(csrfProtection, { sessionPlugin: '@fastify/secure-session' });
});

export const isHtmx = (request: FastifyRequest): boolean =>
  request.headers['hx-request'] === 'true';

/** Inicia la sesión del operador en una sesión nueva (no se hereda nada de la anónima). */
export function startOperatorSession(request: FastifyRequest): void {
  request.session.regenerate();
  request.session.set('operator', true);
  request.session.set('loginAt', Date.now());
  request.session.set('epoch', request.server.sessionEpoch.value);
}

/** Cierra la sesión y revoca todas las cookies emitidas hasta ahora. */
export function endOperatorSession(request: FastifyRequest): void {
  request.server.sessionEpoch.value = randomUUID();
  request.session.delete();
}

function isOperator(request: FastifyRequest): boolean {
  const loginAt = request.session.get('loginAt');
  return (
    request.session.get('operator') === true &&
    request.session.get('epoch') === request.server.sessionEpoch.value &&
    typeof loginAt === 'number' &&
    Date.now() - loginAt < SESSION_MAX_MS
  );
}

/** Exige sesión del operador. Sin sesión: 302 al login (o 401 + HX-Redirect si es htmx). */
export async function requireOperator(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (isOperator(request)) return;
  if (isHtmx(request)) {
    await reply.code(401).header('HX-Redirect', '/admin/login').send();
    return;
  }
  await reply.redirect('/admin/login', 302);
}

export const hasOperatorSession = isOperator;

/** Todo POST lleva token CSRF (en el cuerpo `_csrf` o en la cabecera `x-csrf-token`). */
export function csrfOnPost(app: FastifyInstance) {
  return (request: FastifyRequest, reply: FastifyReply, done: (err?: Error) => void) => {
    if (request.method !== 'POST') {
      done();
      return;
    }
    app.csrfProtection(request, reply, done);
  };
}
