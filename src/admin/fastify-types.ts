import type { Env } from '../config/env.js';
import type { KnowledgeDeps } from '../knowledge/services/deps.js';

declare module 'fastify' {
  interface FastifyInstance {
    knowledge: KnowledgeDeps;
    env: Env;
    /** Época de las sesiones del operador; cambiarla revoca todas las cookies. */
    sessionEpoch: { value: string };
  }
}

declare module '@fastify/secure-session' {
  interface SessionData {
    operator: boolean;
    loginAt: number;
    epoch: string;
    flash: string;
    _csrf: string;
  }
}

export {};
