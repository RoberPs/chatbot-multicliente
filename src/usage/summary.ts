/**
 * Resumen del consumo para el panel (010 US2; FR-007 – FR-010, FR-012, R6). Se consulta por `day`
 * (día local guardado al registrar) y se agrega en enteros exactos: el coste se suma antes de
 * redondear (SC-002) y por moneda. No identifica conversaciones ni clientes.
 */
import { asc, between, desc, gte, sql } from 'drizzle-orm';
import { CHANNELS, type Channel } from '../conversation/channels.js';
import type { DbOrTx } from '../conversation/repositories/customer.js';
import { modelUsage } from '../db/schema.js';
import { localDay, localMonthRange } from '../knowledge/time/local-date.js';
import { usageCutoff } from './retention.js';
import {
  addTokenUsage,
  ZERO_TOKENS,
  type ConceptState,
  type UsagePurpose,
  type UsageRow,
  type UsageSummary,
} from './types.js';

export interface DayRange {
  first: string;
  last: string;
}

/** Hoy y el mes en curso en la zona del negocio (FR-008). */
export function currentPeriods(now: Date, timezone: string): { today: DayRange; month: DayRange } {
  const today = localDay(now, timezone);
  return { today: { first: today, last: today }, month: localMonthRange(now, timezone) };
}

/** Primer y último día de un mes `AAAA-MM`. */
export function monthRange(month: string): DayRange {
  const year = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  const lastDay = new Date(Date.UTC(year, m, 0)).getUTCDate();
  return { first: `${month}-01`, last: `${month}-${String(lastDay).padStart(2, '0')}` };
}

export const emptyRow = (): UsageRow => ({
  calls: 0,
  unmeasuredCalls: 0,
  replies: 0,
  summaries: 0,
  tokens: { ...ZERO_TOKENS },
  // Un grupo sin ninguna fila que informe el concepto está «informado» y vale 0: no hubo llamadas
  // que informar. «Sin dato» se afirma solo cuando hubo llamadas y ninguna lo informó.
  cache: { write: 'reported', read: 'reported' },
  cost: new Map(),
  unpricedModels: [],
});

/** Fila agregada de la consulta: un grupo de canal, propósito, modelo y moneda. */
export interface Group {
  channel: Channel;
  purpose: UsagePurpose;
  model: string;
  currency: string | null;
  records: number;
  calls: number;
  unmeasuredCalls: number;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  /** Filas del grupo con el concepto **no nulo**: `count()` no cuenta los nulos (017, R15). */
  cacheWriteRows: number;
  cacheReadRows: number;
  cost: string | null;
}

/**
 * 017 (R15): recuentos con los que se deduce el estado de cada concepto. Viven aparte de
 * `UsageRow` —en un `Map` local a la agregación— para no meter contadores intermedios en el tipo
 * que lee el panel.
 */
interface ConceptCounts {
  /** Filas a las que el concepto se aplica. */
  rows: number;
  write: number;
  read: number;
}

/**
 * Las transcripciones no entran en el recuento: guardan `0` en los conceptos de caché porque no
 * tienen caché, no porque el proveedor del modelo informe de ella. Contarlas haría que una
 * instancia cuyo proveedor **nunca** informa de la escritura de caché pareciese «parcialmente
 * informada» en cuanto transcribiese un audio.
 */
const conceptApplies = (purpose: UsagePurpose) => purpose !== 'transcription';

function conceptState(withConcept: number, rows: number): ConceptState {
  if (rows === 0 || withConcept === rows) return 'reported';
  return withConcept === 0 ? 'unreported' : 'partial';
}

function addGroup(row: UsageRow, g: Group, counts?: ConceptCounts): void {
  row.calls += g.calls;
  row.unmeasuredCalls += g.unmeasuredCalls;
  if (counts && conceptApplies(g.purpose)) {
    counts.rows += g.records;
    counts.write += g.cacheWriteRows;
    counts.read += g.cacheReadRows;
  }
  // Las transcripciones (012) suman llamadas y coste, pero no son respuestas ni resúmenes.
  if (g.purpose === 'reply') row.replies += g.records;
  else if (g.purpose === 'handoff_summary') row.summaries += g.records;
  row.tokens = addTokenUsage(row.tokens, {
    input: g.input,
    output: g.output,
    cacheWrite: g.cacheWrite,
    cacheRead: g.cacheRead,
  });
  if (g.currency === null) {
    if (!row.unpricedModels.includes(g.model)) {
      row.unpricedModels = [...row.unpricedModels, g.model].sort();
    }
  } else {
    row.cost.set(g.currency, (row.cost.get(g.currency) ?? 0n) + BigInt(g.cost ?? '0'));
  }
}

/** Monedas en orden alfabético, para que la tabla salga siempre igual. */
function sortCost(row: UsageRow): UsageRow {
  row.cost = new Map([...row.cost.entries()].sort(([a], [b]) => a.localeCompare(b)));
  return row;
}

/** Cierre de una fila: monedas ordenadas y estado de cada concepto de caché (017). */
function finishRow(row: UsageRow, counts: ConceptCounts | undefined): UsageRow {
  const { rows, write, read } = counts ?? { rows: 0, write: 0, read: 0 };
  row.cache = { write: conceptState(write, rows), read: conceptState(read, rows) };
  return sortCost(row);
}

const groupColumns = {
  channel: modelUsage.channel,
  purpose: modelUsage.purpose,
  model: modelUsage.model,
  currency: modelUsage.currency,
  records: sql<number>`count(*)::int`,
  calls: sql<number>`sum(${modelUsage.calls})::int`,
  unmeasuredCalls: sql<number>`sum(${modelUsage.unmeasuredCalls})::int`,
  // `bigint` en Postgres → texto; los tokens de un mes caben de sobra en un `number`.
  input: sql<number>`sum(${modelUsage.inputTokens})::float8`,
  output: sql<number>`sum(${modelUsage.outputTokens})::float8`,
  cacheWrite: sql<number>`sum(${modelUsage.cacheWriteTokens})::float8`,
  cacheRead: sql<number>`sum(${modelUsage.cacheReadTokens})::float8`,
  // `count(columna)` ignora los nulos: es exactamente «cuántas filas informaron el concepto».
  cacheWriteRows: sql<number>`count(${modelUsage.cacheWriteTokens})::int`,
  cacheReadRows: sql<number>`count(${modelUsage.cacheReadTokens})::int`,
  cost: sql<string | null>`sum(${modelUsage.costPico})::text`,
};

/**
 * Núcleo **puro** de la agregación: de los grupos de la consulta a las filas del panel. Exportado
 * para que la deducción del estado de cada concepto (017, R15) se pueda probar sin base de datos.
 */
export function aggregateGroups(groups: Group[], period: DayRange): UsageSummary {
  const byChannel = Object.fromEntries(CHANNELS.map((c) => [c, emptyRow()])) as Record<
    Channel,
    UsageRow
  >;
  const customers = emptyRow();
  const instance = emptyRow();
  const counts = new Map<UsageRow, ConceptCounts>();
  const countsOf = (row: UsageRow): ConceptCounts => {
    const existing = counts.get(row);
    if (existing) return existing;
    const fresh: ConceptCounts = { rows: 0, write: 0, read: 0 };
    counts.set(row, fresh);
    return fresh;
  };
  for (const g of groups) {
    const channelRow = byChannel[g.channel];
    addGroup(channelRow, g, countsOf(channelRow));
    if (g.channel !== 'playground') addGroup(customers, g, countsOf(customers));
    addGroup(instance, g, countsOf(instance));
  }
  for (const row of [...Object.values(byChannel), customers, instance]) {
    finishRow(row, counts.get(row));
  }
  return { period, byChannel, customers, instance };
}

/** Consumo de un periodo de días locales (ambos incluidos). */
export async function summarizePeriod(tx: DbOrTx, period: DayRange): Promise<UsageSummary> {
  const groups = await tx
    .select(groupColumns)
    .from(modelUsage)
    .where(between(modelUsage.day, period.first, period.last))
    .groupBy(modelUsage.channel, modelUsage.purpose, modelUsage.model, modelUsage.currency);
  return aggregateGroups(groups, period);
}

/** Consumo de la instancia por día de un mes `AAAA-MM`; solo los días con consumo. */
export async function summarizeDays(
  tx: DbOrTx,
  month: string,
): Promise<Array<{ day: string; row: UsageRow }>> {
  const { first, last } = monthRange(month);
  const groups = await tx
    .select({ day: modelUsage.day, ...groupColumns })
    .from(modelUsage)
    .where(between(modelUsage.day, first, last))
    .groupBy(
      modelUsage.day,
      modelUsage.channel,
      modelUsage.purpose,
      modelUsage.model,
      modelUsage.currency,
    )
    .orderBy(asc(modelUsage.day));
  const days = new Map<string, UsageRow>();
  const counts = new Map<string, ConceptCounts>();
  for (const g of groups) {
    const row = days.get(g.day) ?? emptyRow();
    const dayCounts = counts.get(g.day) ?? { rows: 0, write: 0, read: 0 };
    addGroup(row, g, dayCounts);
    days.set(g.day, row);
    counts.set(g.day, dayCounts);
  }
  return [...days.entries()].map(([day, row]) => ({ day, row: finishRow(row, counts.get(day)) }));
}

/** Meses `AAAA-MM` conservados (R14) que tienen consumo, del más reciente al más antiguo. */
export async function retainedMonths(tx: DbOrTx, now: Date, timezone: string): Promise<string[]> {
  const month = sql<string>`to_char(${modelUsage.day}, 'YYYY-MM')`;
  const rows = await tx
    .selectDistinct({ month })
    .from(modelUsage)
    .where(gte(modelUsage.day, usageCutoff(now, timezone)))
    .orderBy(desc(month));
  return rows.map((r) => r.month);
}
