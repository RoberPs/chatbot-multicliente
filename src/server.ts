import { loadDotEnvIfPresent, loadEnv } from './config/env.js';
import { startInstance, startupErrorMessage, type RunningInstance } from './startup.js';

loadDotEnvIfPresent();
const env = loadEnv();

// Bloqueo, migraciones con copia previa, purga y servidor (006, src/startup.ts).
let instance: RunningInstance;
try {
  instance = await startInstance({ env });
} catch (error) {
  // 013: nunca el texto original (podría llevar el host o los nombres del certificado).
  console.error(startupErrorMessage(error));
  process.exit(1);
}

const shutdown = async () => {
  await instance.stop();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
