/**
 * Utilidades de las pruebas de copias (006): directorio y claves temporales, instancia con datos
 * de ejemplo, foto tabla a tabla de la BD, BD migrada hasta un índice, logger que captura y
 * reloj controlable.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { inject } from 'vitest';
import type { BackupConfig } from '../../src/backup/config.js';
import {
  DUMP_SESSION_OPTIONS,
  listSequences,
  listTables,
  qualified,
} from '../../src/backup/dump.js';
import { applyMigrationsUpTo } from '../../src/backup/schema-version.js';
import type { LoggerLike } from '../../src/conversation/activity-log.js';
import type { Clock } from '../../src/conversation/ports.js';
import { closeDb, createDb, type Db } from '../../src/db/client.js';
import { conversation, customer, message } from '../../src/db/schema.js';
import { allFixtures, loadFixture } from '../fixtures/load.js';
import type { BusinessFixture } from '../fixtures/types.js';
import { withDatabase } from './db.js';

export const TEST_INSTANCE = 'test-01';
export const TEST_KEY = randomBytes(32).toString('hex');
export const TEST_KEY_2 = randomBytes(32).toString('hex');

export interface TempDir {
  path: string;
  remove(): Promise<void>;
}

export async function tempBackupDir(): Promise<TempDir> {
  const path = await mkdtemp(join(tmpdir(), 'backups-'));
  return { path, remove: () => rm(path, { recursive: true, force: true }) };
}

export function testBackupConfig(overrides: Partial<BackupConfig> & { dir: string }): BackupConfig {
  return {
    instanceId: TEST_INSTANCE,
    key: TEST_KEY,
    previousKeys: [],
    retentionDays: 7,
    dailyTime: '03:00',
    verifyUrl: inject('pgAdminUrl'),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Reloj y logger
// ---------------------------------------------------------------------------

export interface TestClock extends Clock {
  set(at: Date | string): void;
  advance(ms: number): void;
}

export function testClock(start: Date | string = '2026-09-29T10:15:00.000Z'): TestClock {
  let now = new Date(start);
  return {
    now: () => new Date(now),
    set: (at) => {
      now = new Date(at);
    },
    advance: (ms) => {
      now = new Date(now.getTime() + ms);
    },
  };
}

export interface CapturedLine {
  level: 'debug' | 'info' | 'warn' | 'error';
  obj: Record<string, unknown>;
  msg: string | undefined;
}

export interface CapturedLogger extends LoggerLike {
  lines: CapturedLine[];
  events(name: string): Array<Record<string, unknown>>;
  text(): string;
}

export function captureLogger(): CapturedLogger {
  const lines: CapturedLine[] = [];
  const make =
    (level: CapturedLine['level']) =>
    (obj: object, msg?: string): void => {
      lines.push({ level, obj: obj as Record<string, unknown>, msg });
    };
  return {
    lines,
    debug: make('debug'),
    info: make('info'),
    warn: make('warn'),
    error: make('error'),
    events: (name) => lines.filter((l) => l.obj.event === name).map((l) => l.obj),
    text: () => lines.map((l) => `${JSON.stringify(l.obj)} ${l.msg ?? ''}`).join('\n'),
  };
}

// ---------------------------------------------------------------------------
// Datos de ejemplo
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;

export interface SeededInstance {
  fixture: BusinessFixture;
  businessName: string;
  phones: string[];
  texts: string[];
  /** Conversaciones cuyo último mensaje tiene más de 30 días respecto a `now`. */
  expiredConversations: number;
}

/**
 * Carga un negocio de `tests/fixtures/` y añade clientes, conversaciones y mensajes, uno de
 * ellos con su último mensaje de hace 40 días respecto a `now`.
 */
export async function seedInstance(
  db: Db,
  fixture: BusinessFixture = allFixtures[0] as BusinessFixture,
  now: Date = new Date('2026-09-29T10:15:00.000Z'),
): Promise<SeededInstance> {
  await loadFixture({ db, phoneRegion: 'ES' }, fixture);
  const phones = ['+34600111222', '+34600333444', '+34600555666'];
  const texts = [
    'Hola, quería saber si mañana tenéis hueco a primera hora',
    'Gracias, me viene perfecto',
    'Mensaje antiguo que ya debería caducar',
  ];
  const ages = [1 * DAY, 3 * DAY, 40 * DAY];
  for (const [i, phone] of phones.entries()) {
    const at = new Date(now.getTime() - (ages[i] ?? 0));
    const [c] = await db
      .insert(customer)
      .values({ channel: 'whatsapp', channelUserId: phone, createdAt: at })
      .returning({ id: customer.id });
    const [conv] = await db
      .insert(conversation)
      .values({
        customerId: c?.id ?? '',
        startedAt: at,
        lastInboundAt: at,
        lastMessageAt: at,
        greeted: true,
        contactPhone: phone,
      })
      .returning({ id: conversation.id });
    await db.insert(message).values({
      conversationId: conv?.id ?? '',
      direction: 'inbound',
      kind: 'text',
      channelMessageId: `wamid.${randomUUID()}`,
      body: texts[i] ?? '',
      sentAt: at,
      receivedAt: at,
      status: 'answered',
    });
  }
  return {
    fixture,
    businessName: String(fixture.business.name),
    phones,
    texts,
    expiredConversations: 1,
  };
}

// ---------------------------------------------------------------------------
// BD
// ---------------------------------------------------------------------------

export async function withClient<T>(
  url: string,
  fn: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString: url, options: DUMP_SESSION_OPTIONS });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export interface TableSnapshot {
  tables: Record<string, string[]>;
  sequences: Record<string, string>;
}

/** Todas las filas de todas las tablas de `public` y `drizzle`, ordenadas, y las secuencias. */
export function tableSnapshot(url: string): Promise<TableSnapshot> {
  return withClient(url, async (client) => {
    const tables: Record<string, string[]> = {};
    for (const t of await listTables(client)) {
      const rows = await client.query<{ r: string }>(
        `select to_jsonb(x)::text as r from ${qualified(t.schema, t.name)} x order by 1`,
      );
      tables[`${t.schema}.${t.name}`] = rows.rows.map((r) => r.r);
    }
    const sequences: Record<string, string> = {};
    for (const s of await listSequences(client)) {
      sequences[`${s.schema}.${s.name}`] = `${s.value}/${String(s.called)}`;
    }
    return { tables, sequences };
  });
}

export interface ScratchDatabase {
  name: string;
  url: string;
  db: Db;
  close(): Promise<void>;
}

/** BD vacía nueva (sin plantilla), opcionalmente migrada hasta `index` con `applyMigrationsUpTo`. */
export async function createDatabaseMigratedUpTo(index: number | null): Promise<ScratchDatabase> {
  const adminUrl = inject('pgAdminUrl');
  const name = `kb_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`create database ${name}`);
  } finally {
    await admin.end();
  }
  const url = withDatabase(adminUrl, name);
  if (index !== null) {
    await withClient(url, async (client) => {
      await client.query('begin');
      await applyMigrationsUpTo(client, index);
      await client.query('commit');
    });
  }
  const db = createDb(url);
  return { name, url, db, close: () => closeDb(db) };
}

/** Nombres de las BD del servidor de pruebas que empiezan por `prefix`. */
export async function databasesLike(prefix: string): Promise<string[]> {
  return withClient(inject('pgAdminUrl'), async (client) => {
    const rows = await client.query<{ datname: string }>(
      'select datname from pg_database where datname like $1',
      [`${prefix}%`],
    );
    return rows.rows.map((r) => r.datname);
  });
}

// ---------------------------------------------------------------------------
// Comandos
// ---------------------------------------------------------------------------

export const TEST_SESSION_SECRET =
  '3f9a1c7e5b2d4086a1e3c5f7092b4d6e8a0c2e4f6183a5c7e9b1d3f5a7c9e0b2';

/** Entorno mínimo válido de una instancia de pruebas con copias configuradas. */
export function cliEnv(
  databaseUrl: string,
  dir: string,
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = {
    DATABASE_URL: databaseUrl,
    OPERATOR_USER: 'operador',
    OPERATOR_PASSWORD_HASH: '$argon2id$v=19$m=65536,t=3,p=4$abc$def',
    SESSION_SECRET: TEST_SESSION_SECRET,
    NODE_ENV: 'test',
    INSTANCE_ID: TEST_INSTANCE,
    BACKUP_DIR: dir,
    BACKUP_KEY: TEST_KEY,
    ...overrides,
  };
  return Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined));
}

export interface TestIO {
  out(text: string): void;
  err(text: string): void;
  env: NodeJS.ProcessEnv;
  interactive: boolean;
  ask(question: string): Promise<string>;
  logger: CapturedLogger;
  stdout: string[];
  stderr: string[];
  questions: string[];
  all(): string;
}

export function testIO(
  env: NodeJS.ProcessEnv,
  options: { interactive?: boolean; answers?: string[] } = {},
): TestIO {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const questions: string[] = [];
  const answers = [...(options.answers ?? [])];
  const logger = captureLogger();
  return {
    env,
    interactive: options.interactive ?? false,
    out: (text) => stdout.push(text),
    err: (text) => stderr.push(text),
    ask: (question) => {
      questions.push(question);
      return Promise.resolve(answers.shift() ?? '');
    },
    logger,
    stdout,
    stderr,
    questions,
    all: () => [...stdout, ...stderr, logger.text()].join('\n'),
  };
}

/** Datos insertados con SQL del esquema 0003 (sin nada de la 0004). */
export async function seedSchema0003(url: string): Promise<void> {
  await withClient(url, async (client) => {
    await client.query(
      `insert into business (id, name, timezone, currency, status, map_url)
       values (1, 'Negocio de la versión anterior', 'Europe/Madrid', 'EUR', 'active', 'https://maps.example.com/x')`,
    );
    await client.query(
      `insert into faq (question, answer) values ('¿Aparcamiento?', 'Sí, en la calle de atrás')`,
    );
    await client.query(
      `insert into customer (channel, channel_user_id) values ('web', 'sesion-antigua')`,
    );
  });
}
