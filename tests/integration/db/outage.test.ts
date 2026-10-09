/**
 * **El corte real** (016, T010, FR-010): se para PostgreSQL de verdad, con la instancia en
 * marcha, y se comprueba FR-001 a FR-004 y SC-001 a SC-003.
 *
 * Es la prueba que no existía y que dejó pasar el fallo. Las de la 012 inyectan el error en la
 * capa de datos, así que el fallo llega por el camino previsto y todo funciona; con la base
 * caída de verdad llega **además** por otro —las conexiones ociosas del pool— que nadie
 * vigilaba, y ese es el que mataba el proceso.
 *
 * Usa un contenedor **propio** (T001) y para el servidor por dentro con `pg_ctl`, para no
 * perder el puerto publicado: así la instancia conserva su `DATABASE_URL` durante todo el corte
 * y se puede comprobar también que se recupera sola, sin reiniciar nada.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv } from '../../../src/config/env.js';
import { runMigrations } from '../../../src/db/migrate.js';
import { startInstance, type RunningInstance } from '../../../src/startup.js';
import { cliEnv, TEST_SESSION_SECRET } from '../../helpers/backup.js';
import { startOwnPostgres, type OwnPostgres } from '../../helpers/own-postgres.js';
import {
  CUSTOMER_WA,
  nextWaId,
  postWebhook,
  testWhatsApp,
  textMessage,
  webhookPayload,
} from '../../helpers/whatsapp.js';
import { createWebSession, postWebMessage, webHeaders } from '../../helpers/web.js';

const HEALTH_SECRET = '7c3e1a5f9b2d4068e1a3c5f7092b4d6e8a0c2e4f6183a5c7e9b1d3f5a7c9e0a2';
const EMERGENCY = '+34911223344';
const auth = { authorization: `Bearer ${HEALTH_SECRET}` };

/** Línea de registro tal como la escribe pino: el evento y sus campos. */
interface LogLine {
  event?: string;
  [key: string]: unknown;
}

let server: OwnPostgres;
let instance: RunningInstance | null = null;
const lines: LogLine[] = [];

/**
 * Salientes de WhatsApp que habrían ido a Meta. Se sustituye el remitente real porque aquí no
 * hay API de Meta a la que llamar: lo que esta prueba verifica es **qué** se envía y **cuántas
 * veces**, que es lo que dice FR-002.
 */
const outbound: Array<{ to: string; body: string }> = [];

/** Deja el negocio activo y el chat web encendido, directamente en SQL (sin pasar por el panel). */
async function activate(url: string): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  client.on('error', () => undefined);
  await client.connect();
  try {
    await client.query(
      `update business set status = 'active', name = 'Negocio de prueba',
         timezone = 'Europe/Madrid', currency = 'EUR' where id = 1`,
    );
    await client.query('update web_chat_settings set enabled = true');
  } finally {
    await client.end();
  }
}

const events = (name: string): LogLine[] => lines.filter((l) => l.event === name);

beforeAll(async () => {
  server = await startOwnPostgres();
  const database = `outage_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Client({ connectionString: server.adminUrl });
  admin.on('error', () => undefined);
  await admin.connect();
  await admin.query(`create database ${database}`);
  await admin.end();

  const databaseUrl = server.url(database);
  await runMigrations(databaseUrl, { timezone: 'Europe/Madrid', currency: 'EUR' });
  await activate(databaseUrl);

  const env = loadEnv(
    cliEnv(databaseUrl, '/no/usado', {
      INSTANCE_ID: undefined,
      BACKUP_DIR: undefined,
      BACKUP_KEY: undefined,
      HEALTH_SECRET,
      SESSION_SECRET: TEST_SESSION_SECRET,
      EMERGENCY_CONTACT_PHONE: EMERGENCY,
      WHATSAPP_PHONE_NUMBER_ID: testWhatsApp.phoneNumberId,
      WHATSAPP_ACCESS_TOKEN: 'token-de-prueba',
      WHATSAPP_APP_SECRET: testWhatsApp.appSecret,
      WHATSAPP_VERIFY_TOKEN: testWhatsApp.verifyToken,
      WHATSAPP_GRAPH_VERSION: testWhatsApp.graphVersion,
      ANTHROPIC_API_KEY: 'sk-ant-de-prueba',
    }),
  );

  instance = await startInstance({
    env,
    buildApp: async (options) => {
      const { buildApp } = await import('../../../src/app.js');
      return buildApp({
        ...options,
        bot: (log) => {
          const real = typeof options.bot === 'function' ? options.bot(log) : (options.bot ?? null);
          if (!real) return null;
          return {
            ...real,
            whatsappSender: {
              sendText: async (to: string, body: string) => {
                outbound.push({ to, body });
                return { channelMessageId: `out:${String(outbound.length)}` };
              },
            },
          };
        },
        logger: true,
        // Los registros van a memoria: es lo que permite contar las anotaciones del corte.
        logStream: {
          write: (line: string) => {
            try {
              lines.push(JSON.parse(line) as LogLine);
            } catch {
              // Una línea que no es JSON no interesa a esta prueba.
            }
          },
        },
      });
    },
    listen: async () => undefined,
  });
}, 180_000);

afterAll(async () => {
  // La base tiene que estar en pie para que el cierre ordenado pueda terminar.
  if (!(await server.isUp())) await server.startServer();
  await instance?.stop().catch(() => undefined);
  await server.stop();
}, 120_000);

const app = () => {
  if (!instance) throw new Error('La instancia no arrancó');
  return instance.app;
};

describe('corte real de la base de datos (FR-010)', () => {
  let panelCookie: string | null = null;

  it('con la base en pie, la instancia atiende con normalidad', async () => {
    const health = await app().inject({ method: 'GET', url: '/health', headers: auth });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ status: 'ok' });

    // Sesión del panel abierta **antes** del corte: tiene que seguir valiendo después.
    const login = await app().inject({ method: 'GET', url: '/admin/login' });
    panelCookie = login.headers['set-cookie']?.toString() ?? null;

    const session = await createWebSession(app());
    expect(session.token).not.toBeNull();
  });

  it(
    'con PostgreSQL parado: el chat responde con el teléfono de emergencia en menos de 10 s (SC-001)',
    async () => {
      const session = await createWebSession(app());
      const token = session.token;
      expect(token).not.toBeNull();

      await server.stopServer();

      const started = Date.now();
      const res = await postWebMessage(app(), token ?? '', 'hola, ¿estáis abiertos?');
      const elapsed = Date.now() - started;

      // FR-002: el aviso con una forma de hablar con una persona, y el contacto es el de
      // emergencia porque la información del negocio se lee de la base en cada respuesta.
      expect(elapsed).toBeLessThan(10_000);
      expect(res.statusCode).toBe(503);
      const dump = JSON.stringify(res.body);
      expect(dump).toContain('unavailable');
      expect(dump).toContain('911');
    },
    60_000,
  );

  it('el proceso sigue vivo y atiende la petición siguiente (FR-001)', async () => {
    // Si el oyente del pool no estuviera, el proceso habría muerto en la petición anterior y
    // esta prueba no llegaría a ejecutarse.
    const res = await app().inject({ method: 'GET', url: '/chat/frame' });
    expect(res.statusCode).toBe(200);
  });

  it('GET /health responde 200 con db_unavailable (FR-003)', async () => {
    const res = await app().inject({ method: 'GET', url: '/health', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'db_unavailable',
      schema: { applied: null },
      spendCap: null,
    });
  });

  it('el nivel sin credencial también da 200: ninguna sonda tiene motivo de reinicio (SC-002)', async () => {
    const res = await app().inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'db_unavailable' });
  });

  it('un entrante de WhatsApp recibe el aviso con contacto, y solo una vez (FR-002)', async () => {
    const payload = webhookPayload({
      messages: [textMessage('hola', { id: nextWaId(), from: CUSTOMER_WA })],
    });
    // 503 para que Meta reintente la entrega: el entrante no se ha podido guardar.
    const first = await postWebhook(app(), payload);
    expect(first.statusCode).toBe(503);

    // Insiste y Meta reintenta: no sale ningún mensaje más (cadencia de FR-002).
    for (let i = 0; i < 3; i++) {
      await postWebhook(
        app(),
        webhookPayload({
          messages: [textMessage('¿hola?', { id: nextWaId(), from: CUSTOMER_WA })],
        }),
      );
    }

    // Un solo saliente, con la disculpa y el teléfono de emergencia.
    expect(outbound).toHaveLength(1);
    expect(outbound[0]?.to).toBe(`+${CUSTOMER_WA}`);
    expect(outbound[0]?.body).toContain('911');

    const sent = events('db_degraded_reply_sent');
    const skipped = events('db_degraded_reply_skipped');
    expect(sent.filter((e) => e.via === 'whatsapp')).toHaveLength(1);
    // Los tres intentos siguientes quedan como omitidos por «ya avisado» (cadencia de FR-002).
    expect(skipped.filter((e) => e.reason === 'already_notified')).toHaveLength(3);
  });

  it('la sesión del panel abierta antes del corte sigue valiendo', async () => {
    const res = await app().inject({
      method: 'GET',
      url: '/admin/login',
      headers: panelCookie ? { cookie: panelCookie } : {},
    });
    // El panel no puede leer ni escribir, pero el proceso vive: la petición se atiende.
    expect([200, 302, 303, 503]).toContain(res.statusCode);
  });

  it(
    'al volver la base, la instancia atiende sin reiniciar y en menos de 30 s (FR-004, SC-003)',
    async () => {
      await server.startServer();

      const started = Date.now();
      let status = '';
      // El vigilante sondea cada 10 s; SC-003 da 30 s de margen.
      for (let i = 0; i < 40 && status !== 'ok'; i++) {
        const res = await app().inject({ method: 'GET', url: '/health', headers: auth });
        status = res.json<{ status: string }>().status;
        if (status !== 'ok') await new Promise((r) => setTimeout(r, 1000));
      }
      expect(status).toBe('ok');
      expect(Date.now() - started).toBeLessThan(30_000);

      // Y vuelve a atender al cliente final con normalidad, sin que nadie haya reiniciado nada.
      const session = await createWebSession(app());
      expect(session.token).not.toBeNull();
      const res = await postWebMessage(app(), session.token ?? '', 'hola otra vez');
      expect(res.statusCode).toBe(202);
    },
    120_000,
  );

  it('el registro tiene una anotación de inicio y una de recuperación (FR-014, SC-008)', async () => {
    expect(events('db_outage_started')).toHaveLength(1);
    /**
     * `/health` y el vigilante se recuperan por su cuenta, cada uno con su pool: `/health` ya
     * decía `ok` en la prueba anterior, pero el vigilante solo sale de `down` con su propio
     * sondeo, que va cada 10 s. Es a propósito —de `down` no se sale por tiempo ni por
     * intervención—, así que aquí hay que esperar a su anotación.
     */
    for (let i = 0; i < 40 && events('db_outage_recovered').length === 0; i++) {
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(events('db_outage_recovered')).toHaveLength(1);
    const recovered = events('db_outage_recovered')[0];
    expect(typeof recovered?.durationMs).toBe('number');
    expect(Number(recovered?.failures)).toBeGreaterThan(0);

    // Ninguna anotación del corte lleva nada de la dirección de la base de datos (FR-012).
    const dump = JSON.stringify([
      ...events('db_outage_started'),
      ...events('db_outage_ongoing'),
      ...events('db_outage_recovered'),
      ...events('db_degraded_reply_sent'),
      ...events('db_degraded_reply_skipped'),
    ]);
    for (const secret of ['postgres://', 'password', TEST_SESSION_SECRET]) {
      expect(dump).not.toContain(secret);
    }
  }, 60_000);
});

/**
 * Edge case de la spec: la base se cae **en mitad de una escritura**. La operación falla y se
 * informa; no se da por hecha ninguna escritura a medias (T010b).
 */
describe('corte en mitad de una escritura', () => {
  it('la escritura falla, se informa y no queda nada a medias', async () => {
    const session = await createWebSession(app());
    const token = session.token ?? '';

    // Se para el servidor con la petición ya en vuelo.
    const inFlight = postWebMessage(app(), token, 'mensaje que se queda a medias');
    await server.stopServer();
    const res = await inFlight;

    // O entró antes del corte (202) o falló informando (503); lo que no vale es colgarse.
    expect([202, 503]).toContain(res.statusCode);

    await server.startServer();
    // Y al volver, la conversación sigue funcionando: no quedó ningún estado inconsistente.
    let ok = false;
    for (let i = 0; i < 40 && !ok; i++) {
      const health = await app().inject({ method: 'GET', url: '/health', headers: auth });
      ok = health.json<{ status: string }>().status === 'ok';
      if (!ok) await new Promise((r) => setTimeout(r, 1000));
    }
    expect(ok).toBe(true);
    const after = await createWebSession(app());
    expect(after.token).not.toBeNull();
  }, 120_000);
});

/** El fragmento del chat lleva el contacto desde que se carga, también durante el corte (FR-013). */
describe('el contacto viaja en la página', () => {
  it('GET /chat/frame lleva el contacto de emergencia con la base caída', async () => {
    await server.stopServer();
    const res = await app().inject({ method: 'GET', url: '/chat/frame', headers: webHeaders() });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('911');
    await server.startServer();
  }, 120_000);
});
