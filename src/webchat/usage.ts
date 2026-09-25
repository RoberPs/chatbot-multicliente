/**
 * Topes de uso del chat web (004, research R9, FR-026): respuestas por día **en la zona horaria
 * del negocio**. El mes es la suma de los días del mes local. Nada se pasa a UTC.
 */
import { and, eq, gte, lt, lte, sql } from 'drizzle-orm';
import type { ActivityLog } from '../conversation/activity-log.js';
import type { DbOrTx } from '../conversation/repositories/customer.js';
import { webUsageDay } from '../db/schema.js';
import type { WebChatSettings } from './settings.js';

/** Fecha local `AAAA-MM-DD` de `now` en la zona IANA. */
export function localDay(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Primer y último día (incluidos) del mes local en curso. */
export function localMonthRange(now: Date, timezone: string): { first: string; last: string } {
  const today = localDay(now, timezone);
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  // Día 0 del mes siguiente = último día de este (aritmética de calendario, sin horas).
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const prefix = today.slice(0, 8);
  return { first: `${prefix}01`, last: `${prefix}${String(lastDay).padStart(2, '0')}` };
}

export interface WebUsage {
  today: number;
  month: number;
}

/** Suma una respuesta web al día local (en la transacción que guarda el saliente). */
export async function incrementWebUsage(tx: DbOrTx, now: Date, timezone: string): Promise<void> {
  await tx
    .insert(webUsageDay)
    .values({ day: localDay(now, timezone), replies: 1 })
    .onConflictDoUpdate({
      target: webUsageDay.day,
      set: { replies: sql`${webUsageDay.replies} + 1` },
    });
}

export async function readWebUsage(tx: DbOrTx, now: Date, timezone: string): Promise<WebUsage> {
  const today = localDay(now, timezone);
  const { first, last } = localMonthRange(now, timezone);
  const [row] = await tx
    .select({
      today: sql<number>`coalesce(sum(${webUsageDay.replies}) filter (where ${webUsageDay.day} = ${today}), 0)::int`,
      month: sql<number>`coalesce(sum(${webUsageDay.replies}), 0)::int`,
    })
    .from(webUsageDay)
    .where(and(gte(webUsageDay.day, first), lte(webUsageDay.day, last)));
  return { today: row?.today ?? 0, month: row?.month ?? 0 };
}

/** Tope alcanzado: el mensual primero, porque dura más (FR-026). */
export function capReached(
  usage: WebUsage,
  settings: Pick<WebChatSettings, 'dailyCap' | 'monthlyCap'>,
): 'day' | 'month' | null {
  if (usage.month >= settings.monthlyCap) return 'month';
  if (usage.today >= settings.dailyCap) return 'day';
  return null;
}

/** Registra `web_quota_reached` una vez por periodo y proceso (contracts/activity-log.md). */
export interface QuotaWatch {
  /** Tope alcanzado en `now`: emite el evento si es la primera vez en ese día o mes local. */
  reached(
    period: 'day' | 'month',
    settings: Pick<WebChatSettings, 'dailyCap' | 'monthlyCap'>,
    now: Date,
    timezone: string,
  ): void;
}

export function createQuotaWatch(activityLog: ActivityLog): QuotaWatch {
  const seen = new Set<string>();
  return {
    reached(period, settings, now, timezone) {
      const key =
        period === 'day'
          ? `day:${localDay(now, timezone)}`
          : `month:${localMonthRange(now, timezone).first}`;
      if (seen.has(key)) return;
      seen.add(key);
      activityLog.log({
        event: 'web_quota_reached',
        period,
        cap: period === 'day' ? settings.dailyCap : settings.monthlyCap,
      });
    },
  };
}

/** Borra los días de hace más de 400 días (retención, FR-028). Devuelve cuántos. */
export async function purgeWebUsage(tx: DbOrTx, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - 400 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const rows = await tx
    .delete(webUsageDay)
    .where(lt(webUsageDay.day, cutoff))
    .returning({ day: webUsageDay.day });
  return rows.length;
}

/** Filas de un día concreto (tests y panel). */
export async function repliesOn(tx: DbOrTx, day: string): Promise<number> {
  const [row] = await tx
    .select({ replies: webUsageDay.replies })
    .from(webUsageDay)
    .where(eq(webUsageDay.day, day));
  return row?.replies ?? 0;
}
