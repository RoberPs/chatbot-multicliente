/**
 * Arranca PostgreSQL 16 con Testcontainers, crea una BD plantilla con las migraciones del
 * núcleo aplicadas y expone la URL de administración. Cada fichero de test crea su propia BD
 * a partir de la plantilla (tests/helpers/db.ts), así los ficheros pueden ir en paralelo.
 */
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { runMigrations } from '../../src/db/migrate.js';

export const TEMPLATE_DB = 'kb_template';

declare module 'vitest' {
  export interface ProvidedContext {
    pgAdminUrl: string;
  }
}

const withDatabase = (url: string, database: string): string => {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
};

export default async function setup(project: TestProject) {
  const container = await new PostgreSqlContainer('postgres:16').start();
  const adminUrl = container.getConnectionUri();

  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${TEMPLATE_DB}`);
  await admin.end();

  await runMigrations(withDatabase(adminUrl, TEMPLATE_DB), {
    timezone: 'Europe/Madrid',
    currency: 'EUR',
  });

  project.provide('pgAdminUrl', adminUrl);

  return async () => {
    await container.stop();
  };
}
