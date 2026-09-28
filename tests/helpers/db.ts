import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { inject } from 'vitest';
import { closeDb, createDb, type Db } from '../../src/db/client.js';
import {
  allTableNames,
  business,
  conversationTableNames,
  handoffAlerts,
  webChatSettings,
} from '../../src/db/schema.js';
import type { KnowledgeDeps } from '../../src/knowledge/services/deps.js';

const TEMPLATE_DB = 'kb_template';

export const withDatabase = (url: string, database: string): string => {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
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
 * defecto y los destinos de avisos de derivación vacíos (filas únicas: se restablecen, no se
 * truncan).
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
