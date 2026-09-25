import { buildApp } from './app.js';
import { createBot, type Bot } from './bot.js';
import { loadDotEnvIfPresent, loadEnv } from './config/env.js';
import { closeDb, createDb } from './db/client.js';
import { runMigrations } from './db/migrate.js';

loadDotEnvIfPresent();
const env = loadEnv();

// Las migraciones del núcleo se aplican al arrancar (research R12).
await runMigrations(env.DATABASE_URL, {
  timezone: env.DEFAULT_TIMEZONE,
  currency: env.DEFAULT_CURRENCY,
});

const db = createDb(env.DATABASE_URL);
const started: { bot: Bot | null } = { bot: null };
const app = await buildApp({
  env,
  db,
  bot: (log) => (started.bot = createBot({ env, db, logger: log })),
});

const shutdown = async () => {
  // Primero deja de recibir; después espera a las respuestas en curso; por último, la BD.
  await app.close();
  await started.bot?.transcriber?.stop();
  await started.bot?.processor.stop();
  await started.bot?.retention.stop();
  await closeDb(db);
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

await app.listen({ port: env.PORT, host: '0.0.0.0' });
started.bot?.processor.start();
started.bot?.retention.start();
