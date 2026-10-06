/** `pnpm kb:snapshot`: imprime lo que recibiría el bot ahora mismo (KnowledgeSnapshot en JSON). */
import { loadDotEnvIfPresent } from '../config/env.js';
import { closeDb, createDb } from '../db/client.js';
import { createKnowledgeReader } from '../knowledge/snapshot.js';

loadDotEnvIfPresent();
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('Falta DATABASE_URL');
  process.exit(1);
}

const db = createDb(databaseUrl);
try {
  const snapshot = await createKnowledgeReader(db).getSnapshot();
  console.log(JSON.stringify(snapshot, null, 2));
} finally {
  await closeDb(db);
}
