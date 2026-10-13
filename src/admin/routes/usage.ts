/**
 * Pantalla "Consumo" del panel (010 US2 y US3, contracts/admin-usage-screen.md).
 *
 * El operador ve el consumo del modelo de hoy, del mes en curso y de los meses conservados, por
 * canal y por día, con el coste estimado según los precios que configura aquí; también fija la
 * moneda de coste y el tope mensual. No es información del negocio: no entra en el snapshot, en
 * los avisos ni en la exportación. Nada de esta pantalla identifica conversaciones ni clientes.
 *
 * 012: tope diario de WhatsApp, precios de transcripción y límites de las derivaciones con los
 * contadores de hoy (contracts/admin-protection.md).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Channel } from '../../conversation/channels.js';
import { readHandoffDay, readHandoffLimits, saveHandoffLimits } from '../../handoff/limits.js';
import { localDay } from '../../knowledge/time/local-date.js';
import { formatCents, formatMicros, formatPico } from '../../usage/money.js';
import {
  deletePrice,
  deleteTranscriptionPrice,
  listPrices,
  listTranscriptionPrices,
  readUsageSettings,
  readWhatsappCap,
  saveTranscriptionPrice,
  saveUsageSettings,
  saveWhatsappCap,
  upsertPrice,
} from '../../usage/settings.js';
import { hasWhatsappUsage, readWhatsappReplies } from '../../usage/whatsapp-usage.js';
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
import type { FormErrorResponse } from '../form-errors.js';
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
  // 017: aquí es donde «sin dato» tiene que dejar de parecerse a un cero (FR-024). Lo pinta T065,
  // con su nota genérica y sus totales marcados como incompletos; hasta entonces un concepto no
  // informado sale como 0, y por eso el entorno de desarrollo se queda en un proveedor que informa
  // de los cuatro conceptos.
  count(row.tokens.cacheWrite ?? 0),
  count(row.tokens.cacheRead ?? 0),
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

/**
 * Los campos del formulario de precios de transcripción se llaman como los de la 010 (`model`);
 * en la página se pintan con su propio nombre para no mezclar sus errores.
 */
const TRANSCRIPTION_FIELDS: Record<string, string> = {
  model: 'transcriptionModel',
  perMinute: 'perMinute',
};

function renameFields<T>(
  values: Record<string, T> | undefined,
  names: Record<string, string>,
): Record<string, T> {
  return Object.fromEntries(Object.entries(values ?? {}).map(([k, v]) => [names[k] ?? k, v]));
}

export async function usageRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app.knowledge;
  const currentModel = app.env.LLM_MODEL;
  const protection = app.protection;

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

    // 012 (R5, R6): tope diario de WhatsApp y precios de transcripción. Sin WhatsApp o sin
    // audios solo se muestran si ya tienen datos.
    const whatsappDailyCap = await readWhatsappCap(db);
    const transcriptionPrices = await listTranscriptionPrices(db);
    const sttModel = protection.sttModel;
    const sttHasPrice = sttModel !== null && transcriptionPrices.some((p) => p.model === sttModel);
    const whatsapp = {
      show: (app.bot?.whatsapp ?? null) !== null || (await hasWhatsappUsage(db)),
      today: await readWhatsappReplies(db, localDay(now, timezone)),
      cap: whatsappDailyCap,
    };
    // 012 (US2): límites de derivación y lo que llevan hoy.
    const limits = await readHandoffLimits(db);
    const handoffDay = await readHandoffDay(db, localDay(now, timezone));
    const handoffs = { limits, today: handoffDay };
    const transcription = {
      show: sttModel !== null || transcriptionPrices.length > 0,
      sttModel,
      sttHasPrice,
      prices: transcriptionPrices.map((p) => ({
        model: p.model,
        current: p.model === sttModel,
        perMinute: formatMicros(p.microsPerMinute),
      })),
    };

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
      production: protection.production,
      whatsapp,
      transcription,
      handoffs,
      values: {
        whatsappDailyCap: String(whatsappDailyCap),
        dailyMax: String(limits.dailyMax),
        forwardIntervalMinutes: String(limits.forwardIntervalMinutes),
        noticesDailyMax: String(limits.noticesDailyMax),
        transcriptionModel: sttModel !== null && !sttHasPrice ? sttModel : '',
        perMinute: '',
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

  /** Repinta la página con los errores del formulario enviado (y sus valores). */
  const repaint =
    (request: FastifyRequest, reply: FastifyReply, form?: Record<string, unknown>) =>
    async (error: FormErrorResponse) =>
      renderPage(
        request,
        reply,
        VIEW,
        { ...(await pageData(request, form)), ...formErrorData(error) },
        error.status,
      );

  app.post('/usage/whatsapp-cap', async (request, reply) => {
    const form = parseForm(request.body);
    return submitForm(request, reply, {
      run: () => saveWhatsappCap(db, form),
      redirectTo: '/admin/usage',
      onError: repaint(request, reply, form),
    });
  });

  app.post('/usage/handoff-limits', async (request, reply) => {
    const form = parseForm(request.body);
    return submitForm(request, reply, {
      run: () => saveHandoffLimits(db, form),
      redirectTo: '/admin/usage',
      onError: repaint(request, reply, form),
    });
  });

  app.post('/usage/transcription-prices', async (request, reply) => {
    const form = parseForm(request.body);
    return submitForm(request, reply, {
      run: () => saveTranscriptionPrice(db, form),
      redirectTo: '/admin/usage',
      onError: async (error) =>
        repaint(
          request,
          reply,
          renameFields(form, TRANSCRIPTION_FIELDS),
        )({ ...error, errors: renameFields(error.errors, TRANSCRIPTION_FIELDS) }),
    });
  });

  app.post<{ Params: { model: string } }>(
    '/usage/transcription-prices/:model/delete',
    async (request, reply) =>
      submitForm(request, reply, {
        run: () => deleteTranscriptionPrice(db, request.params.model, protection),
        redirectTo: '/admin/usage',
        message: 'Precio eliminado',
        onError: repaint(request, reply),
      }),
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
      run: () => deletePrice(db, model, protection),
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
      run: () => saveUsageSettings(db, form, currentModel, protection),
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
