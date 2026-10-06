/**
 * Tope mensual de gasto de la instancia (010 US3; data-model.md §3 y §5, R7, R10). El nivel se
 * calcula en cada comprobación con una sola consulta y sin caché (FR-020); solo
 * `cap_notified_month` recuerda que el evento del mes ya salió.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { ActivityLog, EventContext } from '../conversation/activity-log.js';
import type { DbOrTx } from '../conversation/repositories/customer.js';
import { usageSettings } from '../db/schema.js';
import { localMonthRange } from '../knowledge/time/local-date.js';
import { capLevel, capPercent } from './money.js';
import type { SpendCapState } from './types.js';

/**
 * Nivel del tope ahora: gasto del mes local en la moneda actual (incluye playground y resúmenes;
 * lo sin precio y lo de otra moneda no suma). Lo usan el panel y `/health` (solo leen).
 */
export async function spendCapState(
  tx: DbOrTx,
  now: Date,
  timezone: string,
): Promise<SpendCapState> {
  const { first, last } = localMonthRange(now, timezone);
  const result = await tx.execute<{
    currency: string;
    cap_enabled: boolean;
    monthly_cap_cents: number | null;
    spent: string;
  }>(sql`
    select s.currency, s.cap_enabled, s.monthly_cap_cents,
           coalesce(sum(u.cost_pico), 0)::text as spent
    from usage_settings s
    left join model_usage u
      on u.currency = s.currency and u.day between ${first}::date and ${last}::date
    where s.id = 1
    group by s.id
  `);
  const row = result.rows[0];
  if (!row) {
    return { level: 'none', spentPico: 0n, capCents: null, currency: 'USD', percent: null };
  }
  const spentPico = BigInt(row.spent);
  const capCents = row.monthly_cap_cents;
  const level = capLevel(spentPico, capCents, row.cap_enabled);
  return {
    level,
    spentPico,
    capCents,
    currency: row.currency,
    percent: level === 'none' || capCents === null ? null : capPercent(spentPico, capCents),
  };
}

/**
 * Marca el mes (`AAAA-MM-01`) como avisado. `true` solo para quien lo marca primero: la
 * condición se reevalúa tras el bloqueo de fila, así que en paralelo solo una gana (R10).
 */
export async function markNotified(tx: DbOrTx, monthFirstDay: string): Promise<boolean> {
  const rows = await tx
    .update(usageSettings)
    .set({ capNotifiedMonth: monthFirstDay })
    .where(
      and(
        eq(usageSettings.id, 1),
        sql`${usageSettings.capNotifiedMonth} is distinct from ${monthFirstDay}::date`,
      ),
    )
    .returning({ id: usageSettings.id });
  return rows.length > 0;
}

/**
 * Comprobación de los canales de clientes finales (procesador, recepción web y disponibilidad
 * del chat web): el estado y, la primera vez que ve `reached` en el mes local, el evento
 * `spend_cap_reached` (R10). Sin importes en el evento.
 */
export async function checkSpendCap(
  tx: DbOrTx,
  now: Date,
  timezone: string,
  activityLog: ActivityLog,
  logContext?: EventContext,
): Promise<SpendCapState> {
  const state = await spendCapState(tx, now, timezone);
  if (state.level === 'reached') {
    const { first } = localMonthRange(now, timezone);
    if (await markNotified(tx, first)) {
      activityLog.log({ event: 'spend_cap_reached', month: first.slice(0, 7) }, logContext);
    }
  }
  return state;
}
