import argon2 from 'argon2';
import type { LoginThrottle } from '../../src/admin/auth/login-throttle.js';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp, type BotHttp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import type { Db } from '../../src/db/client.js';
import { createLifecycle } from '../../src/health/lifecycle.js';
import { createInstanceHealth, type InstanceHealth } from '../../src/health/report.js';
import { readCoreVersion } from '../../src/health/version.js';
import type { ProtectionConfig } from '../../src/usage/protection.js';

export const OPERATOR_USER = 'operador';
export const OPERATOR_PASSWORD = 'contraseña-de-prueba';

let passwordHash: Promise<string> | undefined;

/** Contacto de emergencia de la instancia de pruebas (004, FR-022). */
export const TEST_EMERGENCY_PHONE = '+34600999888';

export const TEST_SESSION_SECRET =
  '3f9a1c7e5b2d4086a1e3c5f7092b4d6e8a0c2e4f6183a5c7e9b1d3f5a7c9e0b2';

export async function buildTestApp(
  db: Db,
  databaseUrl = 'postgres://no-usada',
  bot: BotHttp | null = null,
  /** Variables de entorno añadidas o cambiadas para este caso (p. ej. PUBLIC_BASE_URL). */
  extraEnv: Record<string, string> = {},
  /** Registros de la app en líneas JSON (sin él, la app no registra nada). */
  logLines?: string[],
  /** Salud de la instancia (009); por defecto, el sondeo real contra la BD del test y lista. */
  options: {
    health?: InstanceHealth;
    protection?: ProtectionConfig;
    publicDb?: Db;
    loginThrottle?: LoginThrottle;
  } = {},
): Promise<FastifyInstance> {
  passwordHash ??= argon2.hash(OPERATOR_PASSWORD, { type: argon2.argon2id });
  const env = loadEnv({
    DATABASE_URL: databaseUrl,
    OPERATOR_USER,
    OPERATOR_PASSWORD_HASH: await passwordHash,
    SESSION_SECRET: TEST_SESSION_SECRET,
    DEFAULT_PHONE_REGION: 'ES',
    DEFAULT_TIMEZONE: 'Europe/Madrid',
    DEFAULT_CURRENCY: 'EUR',
    EMERGENCY_CONTACT_PHONE: TEST_EMERGENCY_PHONE,
    NODE_ENV: 'test',
    ...extraEnv,
  });
  const health =
    options.health ??
    (() => {
      // El sondeo va a la BD que usa el test (DATABASE_URL puede ser un valor de relleno).
      const lifecycle = createLifecycle();
      lifecycle.markReady();
      return createInstanceHealth({
        databaseUrl: db.$client.options.connectionString ?? databaseUrl,
        coreVersion: readCoreVersion(),
        lifecycle,
      });
    })();
  const app = await buildApp({
    env,
    db,
    logger: logLines !== undefined,
    ...(logLines ? { logStream: { write: (line: string) => void logLines.push(line) } } : {}),
    bot,
    health,
    ...(options.protection ? { protection: options.protection } : {}),
    ...(options.publicDb ? { publicDb: options.publicDb } : {}),
    ...(options.loginThrottle ? { loginThrottle: options.loginThrottle } : {}),
  });
  await app.ready();
  return app;
}

export interface Session {
  cookie: string;
  csrf: string;
}

/** Cookie de sesión tal como llega en Set-Cookie (sin decodificar: el valor lleva `;` codificado). */
export const cookieHeader = (res: LightMyRequestResponse): string | undefined => {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const found = list.find((c) => c.startsWith('kb_session='));
  return found?.split(';')[0];
};

export const csrfFrom = (html: string): string => {
  const match = /name="_csrf" value="([^"]+)"/.exec(html);
  if (!match?.[1]) throw new Error('No hay token CSRF en la página');
  return match[1];
};

/** Inicia sesión como operador y devuelve la cookie y un token CSRF válidos. */
let loginCounter = 0;

export async function login(app: FastifyInstance): Promise<Session> {
  // Cada login desde una dirección distinta para no chocar con el límite de 5 por minuto e IP.
  loginCounter += 1;
  const remoteAddress = `127.0.${Math.floor(loginCounter / 250)}.${(loginCounter % 250) + 1}`;
  const page = await app.inject({ method: 'GET', url: '/admin/login' });
  const preCookie = cookieHeader(page);
  if (!preCookie) throw new Error('El login no crea sesión');
  const res = await app.inject({
    method: 'POST',
    url: '/admin/login',
    remoteAddress,
    headers: { cookie: preCookie, 'content-type': 'application/x-www-form-urlencoded' },
    payload: encodeForm({
      _csrf: csrfFrom(page.body),
      user: OPERATOR_USER,
      password: OPERATOR_PASSWORD,
    }),
  });
  if (res.statusCode !== 303) throw new Error(`Login fallido: ${res.statusCode}`);
  const cookie = cookieHeader(res) ?? preCookie;
  const home = await app.inject({ method: 'GET', url: '/admin', headers: { cookie } });
  return { cookie: cookieHeader(home) ?? cookie, csrf: csrfFrom(home.body) };
}

export type FormFields = Record<string, string | number | boolean | undefined | Array<string>>;

export function encodeForm(fields: FormFields): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === false) continue;
    if (Array.isArray(value))
      value.forEach((v) => {
        params.append(key, v);
      });
    else params.append(key, value === true ? 'on' : String(value));
  }
  return params.toString();
}

export function postForm(
  app: FastifyInstance,
  session: Session,
  url: string,
  fields: FormFields = {},
  headers: Record<string, string> = {},
) {
  return app.inject({
    method: 'POST',
    url,
    headers: {
      cookie: session.cookie,
      'content-type': 'application/x-www-form-urlencoded',
      ...headers,
    },
    payload: encodeForm({ _csrf: session.csrf, ...fields }),
  });
}

export function get(
  app: FastifyInstance,
  session: Session,
  url: string,
  headers: Record<string, string> = {},
) {
  return app.inject({ method: 'GET', url, headers: { cookie: session.cookie, ...headers } });
}

/** Franjas de una semana como campos de formulario `slots[i].…`. */
export function slotFields(slots: Array<[number, string, string]>): FormFields {
  const fields: FormFields = {};
  slots.forEach(([weekday, start, end], i) => {
    fields[`slots[${i}].weekday`] = String(weekday);
    fields[`slots[${i}].start`] = start;
    fields[`slots[${i}].end`] = end;
  });
  return fields;
}

/** L–V 09:00–14:00 y 16:00–20:00, S 10:00–14:00. */
export const TYPICAL_WEEK: Array<[number, string, string]> = [
  ...[1, 2, 3, 4, 5].flatMap((d): Array<[number, string, string]> => [
    [d, '09:00', '14:00'],
    [d, '16:00', '20:00'],
  ]),
  [6, '10:00', '14:00'],
];

/** Mensaje de error mostrado junto a un campo (busca el texto en la página). */
export const hasFieldError = (html: string, message: string): boolean =>
  html.includes(`class="field-error" role="alert">${message}`);

/** Campos con error según el resumen de errores de la página. */
export const fieldErrorsIn = (html: string): string[] =>
  [...html.matchAll(/data-field="([^"]+)"/g)].map((m) => m[1] ?? '');

/** Eventos de un canal en las líneas de registro capturadas por `buildTestApp`. */
export const loggedEvents = (lines: string[], channel: string): Array<Record<string, unknown>> =>
  lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry.channel === channel);
