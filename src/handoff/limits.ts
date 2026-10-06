/**
 * Límites de las derivaciones (012, US2, research R7; data-model §1.6 y §1.7;
 * contracts/handoff-limits.md). Por instancia y por día local del negocio: derivaciones nuevas,
 * minutos entre avisos de una misma derivación y avisos al negocio. Las plazas se reservan con una
 * sola sentencia antes de avisar, así que nunca se pasan del máximo aunque haya avisos en
 * paralelo. Solo cuentan las derivaciones y avisos reales (la vía simulada, no). Dominio sin HTTP;
 * se lee sin caché.
 */
import { eq, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { ActivityLog } from '../conversation/activity-log.js';
import type { DbOrTx } from '../conversation/repositories/customer.js';
import type { Db } from '../db/client.js';
import { handoffDay, handoffLimits } from '../db/schema.js';
import { touch } from '../db/timestamps.js';
import { parseFormInteger } from '../usage/schemas.js';
import type { HandoffLimits } from '../usage/types.js';

/** Rangos de data-model §1.6 (también en los `CHECK` de la tabla). */
export const HANDOFF_LIMIT_RANGES = {
  dailyMax: { min: 1, max: 200 },
  forwardIntervalMinutes: { min: 5, max: 240 },
  noticesDailyMax: { min: 10, max: 500 },
} as const;

/** Valores de la migración. */
export const defaultHandoffLimits: HandoffLimits = {
  dailyMax: 20,
  forwardIntervalMinutes: 15,
  noticesDailyMax: 60,
};

const rangeMessage = (min: number, max: number): string =>
  `Indica un número entero entre ${String(min)} y ${String(max)}`;

const integerIn = (min: number, max: number) =>
  z.unknown().transform((raw, ctx) => {
    const n = parseFormInteger(raw);
    if (n === null || n < min || n > max) {
      ctx.addIssue({ code: 'custom', message: rangeMessage(min, max) });
      return z.NEVER;
    }
    return n;
  });

/** Formulario de los tres límites: un error por campo, con su rango, todos a la vez. */
export const handoffLimitsSchema = z.object({
  dailyMax: integerIn(HANDOFF_LIMIT_RANGES.dailyMax.min, HANDOFF_LIMIT_RANGES.dailyMax.max),
  forwardIntervalMinutes: integerIn(
    HANDOFF_LIMIT_RANGES.forwardIntervalMinutes.min,
    HANDOFF_LIMIT_RANGES.forwardIntervalMinutes.max,
  ),
  noticesDailyMax: integerIn(
    HANDOFF_LIMIT_RANGES.noticesDailyMax.min,
    HANDOFF_LIMIT_RANGES.noticesDailyMax.max,
  ),
});

/** Límites vigentes, sin caché; sin la fila única, los de la migración. */
export async function readHandoffLimits(tx: DbOrTx): Promise<HandoffLimits> {
  const [row] = await tx
    .select({
      dailyMax: handoffLimits.dailyMax,
      forwardIntervalMinutes: handoffLimits.forwardIntervalMinutes,
      noticesDailyMax: handoffLimits.noticesDailyMax,
    })
    .from(handoffLimits)
    .where(eq(handoffLimits.id, 1));
  return row ?? defaultHandoffLimits;
}

/** Guarda los límites en su transacción; valen desde el siguiente mensaje. */
export async function saveHandoffLimits(db: Db, input: unknown): Promise<HandoffLimits> {
  const limits = handoffLimitsSchema.parse(input);
  await db.transaction(async (tx) => {
    await tx
      .insert(handoffLimits)
      .values({ id: 1, ...limits })
      .onConflictDoUpdate({ target: handoffLimits.id, set: { ...limits, ...touch() } });
  });
  return limits;
}

/** Contadores de un día local. */
export interface HandoffDayCounters {
  started: number;
  refused: number;
  notices: number;
  noticesHeld: number;
}

export async function readHandoffDay(tx: DbOrTx, day: string): Promise<HandoffDayCounters> {
  const [row] = await tx
    .select({
      started: handoffDay.started,
      refused: handoffDay.refused,
      notices: handoffDay.notices,
      noticesHeld: handoffDay.noticesHeld,
    })
    .from(handoffDay)
    .where(eq(handoffDay.day, day));
  return row ?? { started: 0, refused: 0, notices: 0, noticesHeld: 0 };
}

/**
 * Reserva una plaza de `column` en el día si queda alguna (data-model §1.7): una sola sentencia,
 * así que con avisos en paralelo se reservan exactamente `max`. `true` si la reservó.
 */
async function reserve(
  tx: DbOrTx,
  column: 'started' | 'notices',
  day: string,
  max: number,
): Promise<boolean> {
  const col = sql.identifier(column);
  const result = await tx.execute(sql`
    insert into handoff_day (day, ${col}) values (${day}::date, 1)
    on conflict (day) do update set ${col} = handoff_day.${col} + 1
      where handoff_day.${col} < ${max}
    returning ${col}
  `);
  return result.rows.length > 0;
}

/** Plaza para una derivación nueva del día. */
export const reserveHandoffStart = (tx: DbOrTx, day: string, max: number): Promise<boolean> =>
  reserve(tx, 'started', day, max);

/** Plaza para un aviso al negocio del día (alerta, reenvío o recordatorio; uno por aviso). */
export const reserveNotice = (tx: DbOrTx, day: string, max: number): Promise<boolean> =>
  reserve(tx, 'notices', day, max);

/** Resultado de reservar las plazas de una derivación nueva. */
export type StartReservation = 'reserved' | 'daily_limit' | 'notices_limit';

/**
 * Plazas de una derivación nueva (contracts/handoff-limits.md § Derivación nueva): una de
 * derivación y otra para su alerta. Sin plaza de derivación, `refused + 1`; con ella pero sin
 * plaza de aviso, se devuelve la de derivación y `notices_held + 1`. Va en la transacción de quien
 * llama (la fila del día queda bloqueada hasta el final). Los eventos salen una vez al día.
 */
export async function reserveStart(
  tx: DbOrTx,
  day: string,
  limits: HandoffLimits,
  activityLog: ActivityLog,
): Promise<StartReservation> {
  if (!(await reserveHandoffStart(tx, day, limits.dailyMax))) {
    await recordRefused(tx, day, limits.dailyMax, activityLog);
    return 'daily_limit';
  }
  if (!(await reserveNotice(tx, day, limits.noticesDailyMax))) {
    await tx.execute(sql`update handoff_day set started = started - 1 where day = ${day}::date`);
    await recordNoticeHeld(tx, day, limits.noticesDailyMax, activityLog);
    return 'notices_limit';
  }
  return 'reserved';
}

/** Suma 1 a `column` y marca `flag`; `true` solo para quien marca primero en el día. */
async function countOnce(
  tx: DbOrTx,
  column: 'refused' | 'notices_held',
  flag: 'refused_logged' | 'held_logged',
  day: string,
): Promise<boolean> {
  const col = sql.identifier(column);
  const mark = sql.identifier(flag);
  await tx.execute(sql`
    insert into handoff_day (day, ${col}) values (${day}::date, 1)
    on conflict (day) do update set ${col} = handoff_day.${col} + 1
  `);
  const marked = await tx.execute(sql`
    update handoff_day set ${mark} = true where day = ${day}::date and not ${mark} returning day
  `);
  return marked.rows.length > 0;
}

/** Petición de derivación sin plaza: `refused + 1` y `handoff_daily_limit` una vez al día. */
export async function recordRefused(
  tx: DbOrTx,
  day: string,
  max: number,
  activityLog: ActivityLog,
): Promise<void> {
  if (await countOnce(tx, 'refused', 'refused_logged', day)) {
    activityLog.log({ event: 'handoff_daily_limit', max });
  }
}

/** Aviso sin plaza: `notices_held + 1` y `business_notices_held` una vez al día. */
export async function recordNoticeHeld(
  tx: DbOrTx,
  day: string,
  max: number,
  activityLog: ActivityLog,
): Promise<void> {
  if (await countOnce(tx, 'notices_held', 'held_logged', day)) {
    activityLog.log({ event: 'business_notices_held', max });
  }
}

/** Borra los días de hace más de 400 días (retención de los contadores). Devuelve cuántos. */
export async function purgeHandoffDays(tx: DbOrTx, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - 400 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const rows = await tx
    .delete(handoffDay)
    .where(lt(handoffDay.day, cutoff))
    .returning({ day: handoffDay.day });
  return rows.length;
}
