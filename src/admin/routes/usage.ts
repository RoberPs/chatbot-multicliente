/**
 * Pantalla "Consumo" del panel (010 US2 y US3, contracts/admin-usage-screen.md).
 *
 * El operador ve el consumo del modelo de hoy, del mes en curso y de los meses conservados, por
 * canal y por día, con el coste estimado según los precios que configura aquí; también fija la
 * moneda de coste y el tope mensual. No es información del negocio: no entra en el snapshot, en
 * los avisos ni en la exportación. Nada de esta pantalla identifica conversaciones ni clientes.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Channel } from '../../conversation/channels.js';
import { formatCents, formatMicros, formatPico } from '../../usage/money.js';
import {
  deletePrice,
  listPrices,
  readUsageSettings,
  saveUsageSettings,
  upsertPrice,
} from '../../usage/settings.js';
import { spendCapState } from '../../usage/spend-cap.js';
import {
  currentPeriods,
  monthRange,
  retainedMonths,
  summarizeDays,
  summarizePeriod,
} from '../../usage/summary.js';
import type { SpendCapLevel, UsageRow, UsageSummary } from '../../usage/types.js';
import { parseForm } from '../form-parse.js';
import { formErrorData, readState, renderPage, submitForm } from '../render.js';

const TITLE = 'Consumo';
const VIEW = 'usage';

const CHANNEL_LABELS: Record<Channel, string> = {
  whatsapp: 'WhatsApp',
  web: 'Chat web',
  playground: 'Probar el bot',
};

export const CAP_LEVEL_LABELS: Record<SpendCapLevel, string> = {
  none: 'Sin tope',
  normal: 'Normal',
  warning: '≥ 80 %',
  reached: 'Alcanzado',
};

/** Fila de una tabla de consumo: etiqueta y sus siete celdas ya formateadas. */
export interface UsageTableRow {
  label: string;
  cells: string[];
}

const count = (n: number): string => new Intl.NumberFormat('es-ES').format(n);

/**
 * Coste de una fila: lo valorado por moneda (sumado antes de redondear, SC-002) y, si hay
 * registros sin precio, «sin precio» o la marca «(hay consumo sin precio)»; nunca 0 por ellos.
 */
export function costText(row: UsageRow, currency: string): string {
  const parts = [...row.cost].map(([c, pico]) => `${formatPico(pico)} ${c}`);
  const unpriced = row.unpricedModels.length > 0;
  if (parts.length === 0) return unpriced ? 'sin precio' : `${formatPico(0n)} ${currency}`;
  return unpriced ? `${parts.join(' + ')} (hay consumo sin precio)` : parts.join(' + ');
}

const cellsOf = (row: UsageRow, currency: string): string[] => [
  count(row.replies),
  count(row.summaries),
  count(row.tokens.input),
  count(row.tokens.output),
  count(row.tokens.cacheWrite),
  count(row.tokens.cacheRead),
  costText(row, currency),
];

/** Canales, «Clientes finales» (WhatsApp + web) e «Instancia». */
function channelRows(summary: UsageSummary, currency: string): UsageTableRow[] {
  return [
    ...(['whatsapp', 'web', 'playground'] as const).map((c) => ({
      label: CHANNEL_LABELS[c],
      cells: cellsOf(summary.byChannel[c], currency),
    })),
    { label: 'Clientes finales', cells: cellsOf(summary.customers, currency) },
    { label: 'Instancia', cells: cellsOf(summary.instance, currency) },
  ];
}

/** `AAAA-MM` → «Agosto de 2026». */
function monthLabel(month: string): string {
  const date = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1));
  const text = new Intl.DateTimeFormat('es-ES', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const dayLabel = (iso: string): string => iso.split('-').reverse().join('/');

export async function usageRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app.knowledge;
  const currentModel = app.env.LLM_MODEL;

  /**
   * Datos de la página, leídos sin caché. `month` es el `?month` pedido (solo si es un mes
   * conservado con consumo); `form` son los valores escritos por el operador al volver con errores.
   */
  async function pageData(request: FastifyRequest, form?: Record<string, unknown>) {
    const state = await readState(app.knowledge);
    const timezone = state.business.timezone;
    const now = app.bot?.clock.now() ?? new Date();
    const settings = await readUsageSettings(db);
    const prices = await listPrices(db);
    const cap = await spendCapState(db, now, timezone);
    const months = await retainedMonths(db, now, timezone);

    const query = (request.query ?? {}) as { month?: unknown };
    const asked = typeof query.month === 'string' ? query.month : undefined;
    const month = asked !== undefined && months.includes(asked) ? asked : null;

    const periods = currentPeriods(now, timezone);
    const tables: Array<{ id: string; title: string; first: string; rows: UsageTableRow[] }> = [];
    const unpriced = new Set<string>();
    const addSummary = (id: string, title: string, summary: UsageSummary) => {
      summary.instance.unpricedModels.forEach((m) => unpriced.add(m));
      tables.push({ id, title, first: 'Canal', rows: channelRows(summary, settings.currency) });
    };
    if (month) {
      addSummary('month', monthLabel(month), await summarizePeriod(db, monthRange(month)));
      const days = await summarizeDays(db, month);
      tables.push({
        id: 'days',
        title: 'Por día',
        first: 'Día',
        rows: days.map((d) => ({
          label: dayLabel(d.day),
          cells: cellsOf(d.row, settings.currency),
        })),
      });
    } else {
      addSummary(
        'today',
        `Hoy · ${dayLabel(periods.today.first)}`,
        await summarizePeriod(db, periods.today),
      );
      addSummary(
        'month',
        `Este mes · ${monthLabel(periods.month.first.slice(0, 7))}`,
        await summarizePeriod(db, periods.month),
      );
    }

    const currentHasPrice = prices.some((p) => p.model === currentModel);
    return {
      state,
      title: TITLE,
      botPresent: app.bot !== null,
      monthUnavailable: asked !== undefined && month === null,
      tables,
      unpricedModels: [...unpriced].sort(),
      months: months.map((m) => ({ value: m, label: monthLabel(m), selected: m === month })),
      currency: settings.currency,
      currentModel,
      currentHasPrice,
      prices: prices.map((p) => ({
        model: p.model,
        current: p.model === currentModel,
        input: formatMicros(p.inputMicros),
        output: formatMicros(p.outputMicros),
        cacheWrite: formatMicros(p.cacheWriteMicros),
        cacheRead: formatMicros(p.cacheReadMicros),
      })),
      cap: {
        level: cap.level,
        label: CAP_LEVEL_LABELS[cap.level],
        spent: `${formatPico(cap.spentPico)} ${cap.currency}`,
        cap: cap.capCents === null ? null : `${formatCents(cap.capCents)} ${cap.currency}`,
        percent: cap.percent,
      },
      values: {
        model: currentHasPrice ? '' : currentModel,
        input: '',
        output: '',
        cacheWrite: '',
        cacheRead: '',
        currency: settings.currency,
        capEnabled: settings.capEnabled,
        monthlyCap: settings.monthlyCapCents === null ? '' : formatCents(settings.monthlyCapCents),
        ...form,
      },
    };
  }

  app.get('/usage', async (request, reply) =>
    renderPage(request, reply, VIEW, await pageData(request)),
  );

  app.post('/usage/prices', async (request, reply) => {
    const form = parseForm(request.body);
    return submitForm(request, reply, {
      run: () => upsertPrice(db, form),
      redirectTo: '/admin/usage',
      onError: async (error) =>
        renderPage(
          request,
          reply,
          VIEW,
          { ...(await pageData(request, form)), ...formErrorData(error) },
          error.status,
        ),
    });
  });

  app.post('/usage/prices/delete', async (request, reply) => {
    const form = parseForm(request.body);
    const model = typeof form.model === 'string' ? form.model : '';
    return submitForm(request, reply, {
      run: () => deletePrice(db, model),
      redirectTo: '/admin/usage',
      message: 'Precio eliminado',
      onError: async (error) =>
        renderPage(
          request,
          reply,
          VIEW,
          { ...(await pageData(request)), ...formErrorData(error) },
          error.status,
        ),
    });
  });

  app.post('/usage/settings', async (request, reply) => {
    const form = parseForm(request.body);
    return submitForm(request, reply, {
      run: () => saveUsageSettings(db, form, currentModel),
      redirectTo: '/admin/usage',
      onError: async (error) =>
        renderPage(
          request,
          reply,
          VIEW,
          {
            ...(await pageData(request, { ...form, capEnabled: form.capEnabled !== undefined })),
            ...formErrorData(error),
          },
          error.status,
        ),
    });
  });
}
