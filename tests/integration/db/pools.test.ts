/**
 * Pools de la base de datos (012, US3, FR-021 – FR-023; contracts/public-routes-and-login.md §
 * Base de datos): el principal está acotado y con plazos; las lecturas del chat web van a un pool
 * público pequeño, y si se agota el chat responde «ocupado» o «no disponible» sin quitarle
 * conexiones al panel. Migraciones y copias usan conexiones sin `statement_timeout`.
 */
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { UNAVAILABLE_MESSAGE } from '../../../src/webchat/availability.js';
import {
  closeDb,
  createDb,
  createPublicDb,
  MAIN_POOL,
  PUBLIC_POOL,
  type Db,
} from '../../../src/db/client.js';
import { get, login } from '../../helpers/app.js';
import { createTestBot, type TestBot } from '../../helpers/bot.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';
import { getWebState, webToken } from '../../helpers/web.js';

const ORIGIN = 'https://negocio.example';
const WEB_ON = { enabled: true, allowedOrigins: [ORIGIN], privacyUrl: `${ORIGIN}/privacidad` };

async function show(db: Db, setting: string): Promise<string> {
  const client = await db.$client.connect();
  try {
    const result = await client.query<Record<string, string>>(`show ${setting}`);
    return Object.values(result.rows[0] ?? {})[0] ?? '';
  } finally {
    client.release();
  }
}

describe('pools de la base de datos', () => {
  let t: TestDatabase;
  let bot: TestBot | null = null;
  const opened: Db[] = [];

  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t.close();
  });
  afterEach(async () => {
    await bot?.close();
    bot = null;
    for (const db of opened.splice(0)) await closeDb(db);
  });

  const open = (db: Db): Db => {
    opened.push(db);
    return db;
  };

  it('principal: max 10, 5 s para conectar, 15 s por sentencia y 60 s en transacción ociosa', async () => {
    const db = open(createDb(t.url));
    expect(MAIN_POOL).toMatchObject({ max: 10, connectionTimeoutMillis: 5000 });
    expect(db.$client.options).toMatchObject({ max: 10, connectionTimeoutMillis: 5000 });
    expect(await show(db, 'statement_timeout')).toBe('15s');
    expect(await show(db, 'idle_in_transaction_session_timeout')).toBe('1min');
    expect(await show(db, 'timezone')).toBe('UTC');
  });

  it('público: max 3, 2 s para conectar y 5 s por sentencia', async () => {
    const db = open(createPublicDb(t.url));
    expect(PUBLIC_POOL).toMatchObject({ max: 3, connectionTimeoutMillis: 2000 });
    expect(db.$client.options).toMatchObject({ max: 3, connectionTimeoutMillis: 2000 });
    expect(await show(db, 'statement_timeout')).toBe('5s');
  });

  it('migraciones y copias: sin statement_timeout', async () => {
    const db = open(createDb(t.url, null));
    expect(await show(db, 'statement_timeout')).toBe('0');
    expect(await show(db, 'idle_in_transaction_session_timeout')).toBe('0');
  });

  it('con el pool público agotado: API 503 busy, frame «no disponible» con el contacto y el panel sigue', async () => {
    const publicDb = open(createPublicDb(t.url));
    const b = (bot = await createTestBot(t, { webChat: WEB_ON, publicDb }));
    const token = await webToken(b.app);
    // El último contacto conocido queda guardado al comprobar el estado.
    const before = await getWebState(b.app, token);
    expect(before.statusCode).toBe(200);
    const contact = before.body.contact as string;

    const held: pg.PoolClient[] = await Promise.all(
      [0, 1, 2].map(() => publicDb.$client.connect()),
    );
    try {
      const state = await getWebState(b.app, token);
      expect(state.statusCode).toBe(503);
      expect(state.body).toEqual({ error: 'busy' });

      const frame = await b.app.inject({ method: 'GET', url: '/chat/frame' });
      expect(frame.statusCode).toBe(200);
      expect(frame.body).toContain(UNAVAILABLE_MESSAGE);
      expect(frame.body).toContain(contact.split('\n')[0] ?? '');

      const started = Date.now();
      const session = await login(b.app);
      const admin = await get(b.app, session, '/admin');
      expect(admin.statusCode).toBe(200);
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      for (const client of held) client.release();
    }
    expect((await getWebState(b.app, token)).statusCode).toBe(200);
  });
});
