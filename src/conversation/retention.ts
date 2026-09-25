/**
 * Borrado de conversaciones (FR-030, SC-011, research R11): cada hora y al arrancar se borran
 * las conversaciones sin mensajes desde hace 30 días (sus mensajes caen en cascada) y después
 * los clientes que se quedan sin conversaciones, de cualquier canal. Desde la 004 también borra
 * los días de uso del chat web de hace más de 400 días (FR-028).
 */
import type { Db } from '../db/client.js';
import { purgeWebUsage } from '../webchat/usage.js';
import type { ActivityLog } from './activity-log.js';
import type { Clock } from './ports.js';
import * as conversations from './repositories/conversation.js';
import { deleteOrphans } from './repositories/customer.js';
import { conversationSettings, type ConversationSettings } from './settings.js';

export interface RetentionDeps {
  db: Db;
  clock: Clock;
  activityLog: ActivityLog;
  settings?: ConversationSettings;
}

export interface Retention {
  /** Borra lo caducado ahora. */
  purge(): Promise<{ conversations: number; customers: number }>;
  /** Borra al arrancar y después cada hora. */
  start(): void;
  /** Para el temporizador y espera al borrado en curso. */
  stop(): Promise<void>;
}

export function createRetention(deps: RetentionDeps): Retention {
  const { db, clock, activityLog } = deps;
  const settings = deps.settings ?? conversationSettings;
  let timer: NodeJS.Timeout | null = null;
  let current: Promise<unknown> | null = null;

  async function purge() {
    const now = clock.now();
    const cutoff = new Date(now.getTime() - settings.retentionMs);
    const result = await db.transaction(async (tx) => {
      const removed = {
        conversations: await conversations.deleteOlderThan(tx, cutoff),
        customers: await deleteOrphans(tx),
      };
      await purgeWebUsage(tx, now);
      return removed;
    });
    activityLog.log({ event: 'retention_purged', ...result });
    return result;
  }

  function run(): void {
    if (current) return;
    current = purge()
      .catch(() => {
        // BD no disponible: se reintenta en la siguiente pasada.
      })
      .finally(() => {
        current = null;
      });
  }

  return {
    purge,
    start() {
      if (timer) return;
      run();
      timer = setInterval(run, settings.retentionSweepMs);
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      await current;
    },
  };
}
