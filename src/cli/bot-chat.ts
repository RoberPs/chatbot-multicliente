/**
 * Conversación con el bot en la terminal, sin WhatsApp (research R14):
 *   pnpm bot:chat [--as <número>] [--verbose]
 *
 * Usa la misma cadena que el webhook (recepción → espera → respuesta) con el modelo real y
 * un canal de consola que imprime las respuestas.
 */
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';
import { loadDotEnvIfPresent, loadEnv } from '../config/env.js';
import {
  createActivityLog,
  silentActivityLog,
  type LoggerLike,
} from '../conversation/activity-log.js';
import { createIntake } from '../conversation/intake.js';
import { systemClock, type ChannelSender } from '../conversation/ports.js';
import { createProcessor } from '../conversation/processor.js';
import { closeDb, createDb } from '../db/client.js';
import { createKnowledgeReader } from '../knowledge/snapshot.js';
import { createAnthropicChatModel } from '../llm/anthropic-chat-model.js';

loadDotEnvIfPresent();
const env = loadEnv();

const { values } = parseArgs({
  options: {
    as: { type: 'string', default: '+34600000000' },
    verbose: { type: 'boolean', default: false },
  },
});

const phone = parsePhoneNumberFromString(values.as, env.DEFAULT_PHONE_REGION as CountryCode);
if (!phone?.isValid()) {
  console.error(`Número no válido: ${values.as}`);
  process.exit(1);
}
if (!env.ANTHROPIC_API_KEY) {
  console.error('Falta ANTHROPIC_API_KEY en .env');
  process.exit(1);
}
const from = phone.number;

/** Eventos técnicos por la salida de error, solo con --verbose. */
const stderrLogger: LoggerLike = {
  debug: (obj) => {
    console.error(JSON.stringify({ level: 'debug', ...obj }));
  },
  info: (obj) => {
    console.error(JSON.stringify({ level: 'info', ...obj }));
  },
  warn: (obj) => {
    console.error(JSON.stringify({ level: 'warn', ...obj }));
  },
  error: (obj) => {
    console.error(JSON.stringify({ level: 'error', ...obj }));
  },
};

const db = createDb(env.DATABASE_URL);
const reader = createKnowledgeReader(db);
const activityLog = values.verbose
  ? createActivityLog(stderrLogger, env.SESSION_SECRET)
  : silentActivityLog;

const consoleSender: ChannelSender = {
  async sendText(_to, body) {
    console.log(`\n🤖 ${body.replaceAll('\n', '\n   ')}\n`);
    return { channelMessageId: `cli-${randomUUID()}` };
  },
};

const processor = createProcessor({
  db,
  reader,
  chatModel: createAnthropicChatModel({
    apiKey: env.ANTHROPIC_API_KEY,
    model: env.LLM_MODEL,
    effort: env.LLM_EFFORT,
  }),
  sender: consoleSender,
  clock: systemClock,
  activityLog,
  emergencyContactPhone: env.emergencyContactPhone,
});
const intake = createIntake({
  db,
  reader,
  clock: systemClock,
  activityLog,
  wake: (id) => {
    processor.wake(id);
  },
});

const snapshot = await reader.getSnapshot();
console.log(
  `Conversación con el bot de "${snapshot.business.name || '(sin nombre)'}" como ${from}. ` +
    'Escribe tus mensajes; Ctrl+D para salir.',
);
if (snapshot.status !== 'active') {
  console.log('Aviso: el negocio está en preparación; el bot no guarda ni contesta mensajes.');
}

processor.start();
const rl = createInterface({ input: process.stdin, output: process.stdout });
try {
  for await (const line of rl) {
    const text = line.trim();
    if (text === '') continue;
    await intake.handle([
      {
        waMessageId: `cli-${randomUUID()}`,
        from,
        sentAt: new Date(),
        kind: 'text',
        text,
        caption: null,
        mediaId: null,
        otherType: null,
        isGroup: false,
      },
    ]);
  }
} finally {
  // Espera a las respuestas que queden antes de salir.
  await new Promise((r) => setTimeout(r, 3500));
  await processor.runOnce();
  await processor.stop();
  await closeDb(db);
}
