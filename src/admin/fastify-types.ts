import type { BotHttp } from '../app.js';
import type { LoginThrottle } from './auth/login-throttle.js';
import type { Env } from '../config/env.js';
import type { Db } from '../db/client.js';
import type { Lifecycle } from '../health/lifecycle.js';
import type { InstanceHealth } from '../health/report.js';
import type { KnowledgeDeps } from '../knowledge/services/deps.js';
import type { ProtectionConfig } from '../usage/protection.js';

declare module 'fastify' {
  interface FastifyInstance {
    knowledge: KnowledgeDeps;
    env: Env;
    /** Época de las sesiones del operador; cambiarla revoca todas las cookies. */
    sessionEpoch: { value: string };
    /** Bot de la instancia; `null` sin credencial del modelo configurada (004, R11). */
    bot: BotHttp | null;
    /** Salud de la instancia (009): informe de `/health` y del pie del panel. */
    health: InstanceHealth;
    /** Ciclo de vida: `starting` → `ready` → `stopping` (lo fija el arranque). */
    lifecycle: Lifecycle;
    /** Producción y modelos que deciden la protección frente a abuso (012, R1). */
    protection: ProtectionConfig;
    /** Pool de las lecturas públicas del chat web (012); puede ser el principal. */
    publicDb: Db;
    /** Freno del login del operador (012, US4). */
    loginThrottle: LoginThrottle;
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
