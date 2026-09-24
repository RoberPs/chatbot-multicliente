import { fileURLToPath, pathToFileURL } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { closeDb, createDb } from './client.js';
import { business } from './schema.js';
import { loadDotEnvIfPresent } from '../config/env.js';

const migrationsFolder = fileURLToPath(new URL('./migrations', import.meta.url));

export interface MigrationDefaults {
  timezone: string;
  currency: string;
}

/** Aplica las migraciones del núcleo y crea el negocio vacío en "draft" si no existe. */
export async function runMigrations(
  databaseUrl: string,
  defaults: MigrationDefaults,
): Promise<void> {
  const db = createDb(databaseUrl);
  try {
    await migrate(db, { migrationsFolder });
    await db
      .insert(business)
      .values({
        id: 1,
        status: 'draft',
        name: '',
        timezone: defaults.timezone,
        currency: defaults.currency,
      })
      .onConflictDoNothing();
  } finally {
    await closeDb(db);
  }
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  loadDotEnvIfPresent();
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('Falta DATABASE_URL');
    process.exit(1);
  }
  await runMigrations(databaseUrl, {
    timezone: process.env.DEFAULT_TIMEZONE ?? 'Europe/Madrid',
    currency: (process.env.DEFAULT_CURRENCY ?? 'EUR').toUpperCase(),
  });
  console.log('Migraciones aplicadas');
}
