import type { BotHttp } from '../app.js';
import type { Env } from '../config/env.js';
import type { KnowledgeDeps } from '../knowledge/services/deps.js';

declare module 'fastify' {
  interface FastifyInstance {
    knowledge: KnowledgeDeps;
    env: Env;
    /** Época de las sesiones del operador; cambiarla revoca todas las cookies. */
    sessionEpoch: { value: string };
    /** Bot de la instancia; `null` sin ANTHROPIC_API_KEY (004, R11). */
    bot: BotHttp | null;
  }
}

declare module '@fastify/secure-session' {
  interface SessionData {
    operator: boolean;
    loginAt: number;
    epoch: string;
    flash: string;
    _csrf: string;
    /** Conversación de prueba vigente del operador (004, R6). */
    playgroundId: string;
  }
}

export {};
