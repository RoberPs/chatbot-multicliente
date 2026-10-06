/**
 * Freno del login del operador (012, US4, research R16; contracts/public-routes-and-login.md §
 * Login). El antiguo bloqueo global (20 fallos → 429 para todos) dejaba fuera al operador durante
 * un ataque; ahora los fallos de los últimos 15 min solo añaden un retardo creciente, las
 * verificaciones Argon2id pasan por una cola acotada y el navegador desde el que el operador ya
 * entró (cookie firmada) se salta el retardo y pasa delante en la cola.
 *
 * Todo en memoria: una instancia es un proceso y una cuenta.
 */
import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

export interface LoginThrottleOptions {
  windowMs: number;
  /** Fallos sin retardo. */
  freeFailures: number;
  stepMs: number;
  maxDelayMs: number;
  /** Verificaciones a la vez y en espera. */
  concurrency: number;
  queueMax: number;
  now: () => number;
  /** Espera del retardo (las pruebas la acortan). */
  sleep: (ms: number) => Promise<void>;
}

export const LOGIN_THROTTLE: LoginThrottleOptions = {
  windowMs: 15 * 60 * 1000,
  freeFailures: 5,
  stepMs: 250,
  maxDelayMs: 5000,
  concurrency: 2,
  queueMax: 50,
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** `min(5 000, 250 × max(0, fallos − 5))` ms. */
export function delayFor(failures: number, options: LoginThrottleOptions = LOGIN_THROTTLE): number {
  return Math.min(
    options.maxDelayMs,
    options.stepMs * Math.max(0, failures - options.freeFailures),
  );
}

export interface LoginThrottle {
  failure(): void;
  /** Retardo que toca ahora a un navegador desconocido. */
  delayMs(): number;
  sleep(ms: number): Promise<void>;
  /**
   * Ejecuta `task` cuando le toca en la cola; `'full'` sin ejecutarla si la cola está llena
   * (nunca con `priority`, el navegador conocido).
   */
  run<T>(task: () => Promise<T>, priority: boolean): Promise<T | 'full'>;
  stats(): { active: number; queued: number; rejected: number };
}

export function createLoginThrottle(overrides: Partial<LoginThrottleOptions> = {}): LoginThrottle {
  const options = { ...LOGIN_THROTTLE, ...overrides };
  let failures: number[] = [];
  let active = 0;
  let rejected = 0;
  const waiting: Array<{ priority: boolean; start: () => void }> = [];

  const recent = () => {
    const since = options.now() - options.windowMs;
    failures = failures.filter((t) => t > since);
    return failures.length;
  };

  const next = () => {
    const entry = waiting.shift();
    if (entry) entry.start();
  };

  return {
    failure() {
      failures.push(options.now());
    },
    delayMs: () => delayFor(recent(), options),
    sleep: (ms) => options.sleep(ms),
    async run(task, priority) {
      if (active >= options.concurrency) {
        if (!priority && waiting.length >= options.queueMax) {
          rejected += 1;
          return 'full';
        }
        await new Promise<void>((start) => {
          const entry = { priority, start };
          // Los conocidos, detrás de los conocidos que ya esperan y delante de los demás.
          const at = priority ? waiting.findIndex((w) => !w.priority) : -1;
          if (at < 0) waiting.push(entry);
          else waiting.splice(at, 0, entry);
        });
      }
      active += 1;
      try {
        return await task();
      } finally {
        active -= 1;
        next();
      }
    },
    stats: () => ({ active, queued: waiting.length, rejected }),
  };
}

/** Nombre de la cookie de navegador conocido. */
export const DEVICE_COOKIE = '__Host-chatbot-device';
export const DEVICE_COOKIE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** Clave HKDF de `SESSION_SECRET` solo para esta cookie (etiqueta `login-device`). */
export function deviceKey(sessionSecret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', sessionSecret, '', 'login-device', 32));
}

const mac = (key: Buffer, expires: string): Buffer =>
  createHmac('sha256', key).update(`v1.${expires}`).digest();

/** `v1.<caducidad en ms>.<hmac en base64url>`. */
export function signDeviceCookie(key: Buffer, now: number, ttlMs = DEVICE_COOKIE_TTL_MS): string {
  const expires = String(now + ttlMs);
  return `v1.${expires}.${mac(key, expires).toString('base64url')}`;
}

export function verifyDeviceCookie(key: Buffer, value: string | undefined, now: number): boolean {
  const [version, expires, signature, ...rest] = (value ?? '').split('.');
  if (version !== 'v1' || !expires || !signature || rest.length > 0 || !/^\d+$/.test(expires)) {
    return false;
  }
  if (Number(expires) < now) return false;
  const given = Buffer.from(signature, 'base64url');
  const expected = mac(key, expires);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
