/**
 * `GET /health` (009, contracts/health-endpoint.md, research R1 y R8): estado de la instancia con
 * dos niveles. Sin cabecera `Authorization`, solo `{status}`; con `Bearer <HEALTH_SECRET>`, el
 * informe completo. Cualquier credencial que no sea la de la instancia (también si la instancia no
 * tiene secreto) recibe el mismo 401, para no revelar si lo tiene. El estado va también en el
 * código: **200 con `ok` y con `db_unavailable`** (016, FR-003), 503 con `degraded` y
 * `not_ready`. `db_unavailable` da 200 porque el proceso vive y sirve aunque su base de datos no
 * conteste, y un 503 sería para la sonda del contenedor un motivo para reiniciar la instancia:
 * exactamente el bucle de reinicios que la 016 elimina. Sin sesión ni CSRF; no toca el
 * conocimiento ni el pool del bot.
 */
import { randomBytes } from 'node:crypto';
import type { FastifyError, FastifyPluginAsync, FastifyReply } from 'fastify';
import type { HealthReport } from '../../health/report.js';
import { fullView, publicView } from '../../health/report.js';
import { parseBearer, verifyHealthSecret } from '../../health/secret.js';

export interface HealthRoutesOptions {
  /** Informe de salud calculado en cada petición (nunca guardado). */
  report: () => Promise<HealthReport>;
  /** `HEALTH_SECRET` de la instancia; sin él, solo el nivel sin credencial. */
  secret: string | undefined;
  instanceId: string | null;
}

/** Límite por IP (respeta TRUST_PROXY): un monitor debe sondear cada 10 s o más. */
export const HEALTH_RATE_LIMIT = { max: 30, timeWindow: '1 minute' } as const;

const unauthorized = (reply: FastifyReply) =>
  reply.code(401).header('WWW-Authenticate', 'Bearer').send({ error: 'unauthorized' });

export const healthRoutes: FastifyPluginAsync<HealthRoutesOptions> = async (app, options) => {
  // Valor con el que se compara cuando la instancia no tiene secreto: mismo trabajo y mismo 401.
  const decoy = randomBytes(32).toString('hex');

  app.addHook('onSend', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
  });

  // Límite de peticiones y errores imprevistos: JSON y sin ningún detalle de la instancia.
  app.setErrorHandler(async (error: FastifyError, _request, reply) => {
    if (error.statusCode === 429) {
      return reply.code(429).send({ error: 'too_many_requests' });
    }
    return reply.code(503).send({ status: 'degraded' });
  });

  app.get(
    '/health',
    { logLevel: 'warn', config: { rateLimit: HEALTH_RATE_LIMIT } },
    async (request, reply) => {
      const credential = parseBearer(request.headers.authorization);
      if (credential.kind === 'malformed') return unauthorized(reply);
      if (credential.kind === 'bearer') {
        const valid = verifyHealthSecret(options.secret ?? decoy, credential.value);
        if (!valid || options.secret === undefined) return unauthorized(reply);
      }

      let report: HealthReport;
      try {
        report = await options.report();
      } catch {
        return reply.code(503).send({ status: 'degraded' });
      }
      const body =
        credential.kind === 'bearer' ? fullView(report, options.instanceId) : publicView(report);
      const healthy = report.status === 'ok' || report.status === 'db_unavailable';
      return reply.code(healthy ? 200 : 503).send(body);
    },
  );
};
