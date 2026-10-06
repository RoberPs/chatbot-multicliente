/**
 * Copia diaria automática (006, US6, research R10). La hora es local del negocio, en su zona
 * horaria IANA leída en cada pasada; nada se pasa a UTC. El directorio de copias es la única
 * fuente de verdad de "ya hay copia hoy", así que un reinicio no crea una segunda y un arranque
 * tardío hace la que faltaba.
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { LoggerLike } from '../conversation/activity-log.js';
import { systemClock, type Clock } from '../conversation/ports.js';
import type { Db } from '../db/client.js';
import { business } from '../db/schema.js';
import type { BackupConfig } from './config.js';
import { BackupError } from './errors.js';
import { readHeader } from './format.js';
import { silentLogger } from './log.js';
import { parseBackupName } from './naming.js';
import { applyRetention } from './retention.js';
import { createBackup, type BackupInternals } from './service.js';

/** Fecha (`AAAA-MM-DD`) y hora (`HH:MM`) de un instante en la zona horaria del negocio. */
export function localDateTime(at: Date, timezone: string): { date: string; time: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
  };
}

/**
 * ¿Toca la copia diaria? Sí si la hora local ya ha llegado a la configurada, no hay copia
 * `daily` de hoy (día local) y hoy no ha fallado ya. Si la hora configurada no existe ese día
 * (salto de primavera), toca desde el primer minuto posterior; si se repite (otoño), la copia
 * del día impide una segunda.
 */
export function dueDailyBackup(input: {
  now: Date;
  timezone: string;
  time: string;
  dailyToday: boolean;
  failedOn: string | null;
}): boolean {
  const local = localDateTime(input.now, input.timezone);
  return local.time >= input.time && !input.dailyToday && input.failedOn !== local.date;
}

export interface BackupScheduler {
  /** Una pasada: decide, copia si toca y aplica la retención. Nunca lanza. */
  tick(): Promise<void>;
  /** Pasada inmediata y después cada `intervalMs`. */
  start(): void;
  /** Para el temporizador y espera a la copia en curso. */
  stop(): Promise<void>;
}

export interface BackupSchedulerOptions {
  databaseUrl: string;
  db: Db;
  config: BackupConfig;
  clock?: Clock;
  logger?: LoggerLike;
  intervalMs?: number;
  /** Zona si no se puede leer la del negocio. */
  fallbackTimezone?: string;
  internal?: BackupInternals;
}

export function createBackupScheduler(options: BackupSchedulerOptions): BackupScheduler {
  const { config, db } = options;
  const clock = options.clock ?? systemClock;
  const logger = options.logger ?? silentLogger;
  const intervalMs = options.intervalMs ?? 60_000;
  // En memoria a propósito: tras un reinicio se vuelve a intentar (arranque tardío, FR-027).
  let failedOn: string | null = null;
  let retentionOn: string | null = null;
  let timer: NodeJS.Timeout | null = null;
  let current: Promise<void> | null = null;

  async function timezone(): Promise<string> {
    try {
      const [row] = await db
        .select({ timezone: business.timezone })
        .from(business)
        .where(eq(business.id, 1));
      return row?.timezone ?? options.fallbackTimezone ?? 'UTC';
    } catch {
      return options.fallbackTimezone ?? 'UTC';
    }
  }

  /** ¿Hay en el directorio una copia `daily` propia de ese día local? */
  async function dailyOn(date: string, tz: string): Promise<boolean> {
    for (const name of await readdir(config.dir)) {
      const parts = parseBackupName(name);
      if (parts?.reason !== 'daily' || parts.instanceId !== config.instanceId) continue;
      try {
        const { header } = await readHeader(join(config.dir, name));
        if (header.instanceId !== config.instanceId || header.reason !== 'daily') continue;
        if (localDateTime(new Date(header.createdAt), tz).date === date) return true;
      } catch {
        // Un fichero ilegible no cuenta como copia.
      }
    }
    return false;
  }

  async function retention(date: string): Promise<void> {
    retentionOn = date;
    try {
      await applyRetention({ config, clock, logger });
    } catch {
      // Se reintenta en la pasada del día siguiente o tras la próxima copia.
    }
  }

  async function pass(): Promise<void> {
    const tz = await timezone();
    const now = clock.now();
    const local = localDateTime(now, tz);
    const reached = local.time >= config.dailyTime;
    let dailyToday: boolean;
    try {
      dailyToday = await dailyOn(local.date, tz);
    } catch {
      // Directorio no disponible: la copia fallará y lo registrará.
      dailyToday = false;
    }
    if (dueDailyBackup({ now, timezone: tz, time: config.dailyTime, dailyToday, failedOn })) {
      try {
        await createBackup({
          databaseUrl: options.databaseUrl,
          config,
          reason: 'daily',
          clock,
          logger,
          ...(options.internal ? { internal: options.internal } : {}),
        });
        // `createBackup` ya aplica la retención tras una copia correcta.
        retentionOn = local.date;
      } catch (error) {
        // Otra copia en curso: sin marcar el día, se reintenta en la siguiente pasada (R7).
        if (error instanceof BackupError && error.code === 'busy') return;
        failedOn = local.date;
        // Aunque la copia falle se libera espacio (p. ej. con `no_space`).
        await retention(local.date);
      }
      return;
    }
    if (reached && retentionOn !== local.date) await retention(local.date);
  }

  function run(): Promise<void> {
    if (current) return current;
    current = pass()
      .catch(() => undefined)
      .finally(() => {
        current = null;
      });
    return current;
  }

  return {
    tick: run,
    start() {
      if (timer) return;
      void run();
      timer = setInterval(() => void run(), intervalMs);
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      await current;
    },
  };
}
