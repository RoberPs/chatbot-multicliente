import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { inject } from 'vitest';
import { closeDb, createDb, type Db } from '../../src/db/client.js';
import {
  allTableNames,
  business,
  chatDesign,
  conversationTableNames,
  handoffAlerts,
  handoffLimits,
  modelPrice,
  modelUsage,
  transcriptionPrice,
  usageSettings,
  webChatSettings,
} from '../../src/db/schema.js';
import type { KnowledgeDeps } from '../../src/knowledge/services/deps.js';

const TEMPLATE_DB = 'kb_template';

export const withDatabase = (url: string, database: string): string => {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
};

/**
 * Las tres formas de dirección de base de datos de la 016 (spec, Key Entities; data-model §4).
 * Las pruebas de este repositorio solo usaban la primera, y por eso dos fallos de producción
 * pasaron por todas ellas.
 *
 * - `hostUrl`: con nombre de servidor. La de desarrollo y pruebas.
 * - `authoritylessUrl`: **sin nombre de servidor**, con el servidor y el puerto en parámetros.
 *   Es la forma que hace que `new URL` lance, que es exactamente el defecto que rompía
 *   `db:verify` en producción. Conecta por TCP, así que **se puede ejecutar en cualquier sistema
 *   operativo**, Windows incluido: reproduce el fallo sin necesitar un socket Unix.
 * - `socketPathUrl`: sin nombre de servidor y con una **ruta de socket Unix**. La forma literal
 *   del despliegue real. Comparte el mismo defecto de interpretación que la anterior, pero solo
 *   se puede *conectar* donde haya sockets Unix; construirla y parsearla funciona en todas
 *   partes.
 */
export const hostUrl = (
  host: string,
  port: number,
  database: string,
  { user = 'u', password = 'c' } = {},
): string => `postgres://${user}:${password}@${host}:${port}/${database}`;

export const authoritylessUrl = (
  host: string,
  port: number,
  database: string,
  { user = 'u', password = 'c' } = {},
): string => `postgres://${user}:${password}@/${database}?host=${host}&port=${port}`;

export const socketPathUrl = (
  socketDir: string,
  database: string,
  { user = 'u', password = 'c', port = 5432 } = {},
): string => `postgres://${user}:${password}@/${database}?host=${socketDir}&port=${port}`;

/** La misma dirección que `url` pero con la autoridad vacía: el servidor pasa a parámetro. */
export const toAuthorityless = (url: string, database?: string): string => {
  const u = new URL(url);
  const name = database ?? u.pathname.replace(/^\//, '');
  return authoritylessUrl(u.hostname, Number(u.port || '5432'), name, {
    user: u.username,
    password: u.password,
  });
};

export interface TestDatabase {
  db: Db;
  url: string;
  deps: KnowledgeDeps;
  close: () => Promise<void>;
}

/** Crea una BD nueva (copia de la plantilla migrada) para un fichero de test. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const adminUrl = inject('pgAdminUrl');
  const name = `kb_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        await admin.query(`CREATE DATABASE ${name} TEMPLATE ${TEMPLATE_DB}`);
        break;
      } catch (error) {
        if (attempt >= 10) throw error;
        await new Promise((r) => setTimeout(r, 200 + attempt * 100));
      }
    }
  } finally {
    await admin.end();
  }
  const url = withDatabase(adminUrl, name);
  const db = createDb(url);
  return { db, url, deps: { db, phoneRegion: 'ES' }, close: () => closeDb(db) };
}

/**
 * Vacía todas las tablas, deja el negocio vacío en "draft", el chat web con sus valores por
 * defecto, los destinos de avisos de derivación vacíos y los ajustes de consumo por defecto
 * (filas únicas: se restablecen, no se truncan).
 */
export async function resetDb(db: Db): Promise<void> {
  const tables = sql.join(
    [...conversationTableNames, ...allTableNames].map((t) => sql.identifier(t)),
    sql`, `,
  );
  await db.execute(sql`truncate ${tables} restart identity cascade`);
  await db
    .insert(business)
    .values({ id: 1, status: 'draft', name: '', timezone: 'Europe/Madrid', currency: 'EUR' });
  await db
    .update(webChatSettings)
    .set({ enabled: false, allowedOrigins: [], privacyUrl: null, dailyCap: 200, monthlyCap: 3000 });
  await db.update(handoffAlerts).set({ whatsappPhone: null, email: null });
  // Diseño del chat (011): sin fila es el aspecto original; las imágenes caen en cascada.
  await db.delete(chatDesign);
  // Consumo (010): no está en `allTableNames` (alimenta el `max(updated_at)` del snapshot).
  await db.execute(sql`truncate ${modelUsage}, ${modelPrice}, ${transcriptionPrice}`);
  // Upsert: algún test borra la fila única para provocar fallos.
  const defaults = {
    currency: 'USD',
    capEnabled: false,
    monthlyCapCents: null,
    capNotifiedMonth: null,
    whatsappDailyCap: 200,
    whatsappCapNotifiedDay: null,
  };
  await db
    .insert(usageSettings)
    .values({ id: 1, ...defaults })
    .onConflictDoUpdate({ target: usageSettings.id, set: defaults });
  // Límites de derivación (012): los de la migración.
  const limits = { dailyMax: 20, forwardIntervalMinutes: 15, noticesDailyMax: 60 };
  await db
    .insert(handoffLimits)
    .values({ id: 1, ...limits })
    .onConflictDoUpdate({ target: handoffLimits.id, set: limits });
}

/** Guarda los destinos de los avisos de derivación (005) directamente en la fila única. */
export async function setHandoffAlerts(
  db: Db,
  values: { whatsapp?: string | null; email?: string | null },
): Promise<void> {
  await db.update(handoffAlerts).set({
    ...(values.whatsapp === undefined ? {} : { whatsappPhone: values.whatsapp }),
    ...(values.email === undefined ? {} : { email: values.email }),
  });
}
