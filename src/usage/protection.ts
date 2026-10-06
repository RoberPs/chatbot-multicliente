/**
 * Estado de protección de la instancia (012, research R1 – R6; contracts/protection-conversation.md).
 *
 * Reúne en una sola consulta, sin caché, lo que decide si un canal de clientes finales puede usar
 * el modelo: tope de gasto (010) y si es obligatorio (producción), precio del modelo y del de
 * transcripción, tope diario de WhatsApp y contadores de derivación del día. Falla cerrado: si la
 * consulta falla o tarda más de 2 s, los clientes reciben solo el contacto (FR-004). Dominio puro:
 * sin HTTP ni `process.env`; quien llama le pasa la configuración.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { ActivityLog, EventContext } from '../conversation/activity-log.js';
import type { DbOrTx } from '../conversation/repositories/customer.js';
import { usageSettings } from '../db/schema.js';
import type { Warning } from '../knowledge/types.js';
import { localDay, localMonthRange } from '../knowledge/time/local-date.js';
import { capLevel, capPercent } from './money.js';
import { markNotified } from './spend-cap.js';
import type {
  CapReason,
  ContactOnlyReason,
  ProtectionState,
  SpendCapState,
} from './types.js';

/** Plazo de la lectura del estado (R2). */
export const PROTECTION_READ_TIMEOUT_MS = 2_000;
/** Como mucho un `protection_read_failed` por minuto (R2). */
const READ_FAILURE_LOG_MS = 60_000;

/** Configuración de la instancia que decide la protección (la da el arranque, no el dominio). */
export interface ProtectionConfig {
  /** `NODE_ENV === 'production'`. */
  production: boolean;
  /** `LLM_MODEL`. */
  llmModel: string;
  /** `STT_MODEL` con `AUDIO_TRANSCRIPTION=on`; `null` con los audios apagados. */
  sttModel: string | null;
}

export interface ProtectionInput extends ProtectionConfig {
  now: Date;
  /** Zona IANA del negocio: da el día y el mes locales. */
  timezone: string;
  /** Plazo de la lectura (pruebas); por defecto 2 s. */
  readTimeoutMs?: number;
}

/** Canales de clientes finales: «Probar el bot» nunca se corta (010 FR-019). */
export type CustomerChannel = 'whatsapp' | 'web';

/** Configuración fuera de producción y sin audios (herramientas y pruebas). */
export const defaultProtectionConfig = (llmModel: string): ProtectionConfig => ({
  production: false,
  llmModel,
  sttModel: null,
});

/** Orden de los motivos cuando hay varios (contracts/protection-conversation.md). */
const REASON_ORDER: CapReason[] = [
  'spend_unreadable',
  'cap_disabled',
  'model_unpriced',
  'stt_unpriced',
  'spend_cap',
  'whatsapp_daily',
];

interface Row extends Record<string, unknown> {
  currency: string;
  cap_enabled: boolean;
  monthly_cap_cents: number | null;
  whatsapp_daily_cap: number;
  spent: string;
  llm_priced: boolean;
  stt_priced: boolean;
  wa_today: number;
  daily_max: number | null;
  forward_interval_minutes: number | null;
  notices_daily_max: number | null;
  h_started: number;
  h_refused: number;
  h_notices: number;
  h_held: number;
}

/** Estado de protección con el motivo técnico si no se pudo leer (no se guarda nunca). */
export type ProtectionRead = ProtectionState & {
  /** Clase del error de lectura (`TimeoutError` si venció el plazo); `null` si se leyó. */
  readFailure: string | null;
};

class ProtectionTimeout extends Error {
  constructor() {
    super('Plazo de la lectura del estado de protección');
    this.name = 'TimeoutError';
  }
}

function unreadable(input: ProtectionInput, errorClass: string): ProtectionRead {
  return {
    production: input.production,
    contactOnly: ['spend_unreadable'],
    spendCap: null,
    whatsapp: null,
    handoffs: null,
    unpricedModels: { llm: null, stt: null },
    readFailure: errorClass,
  };
}

/** Lee el estado en una sola consulta con plazo; nunca lanza (fallo → `spend_unreadable`). */
export async function protectionState(tx: DbOrTx, input: ProtectionInput): Promise<ProtectionRead> {
  const today = localDay(input.now, input.timezone);
  const { first, last } = localMonthRange(input.now, input.timezone);
  const query = tx.execute<Row>(sql`
    select s.currency, s.cap_enabled, s.monthly_cap_cents, s.whatsapp_daily_cap,
      (select coalesce(sum(u.cost_pico), 0)::text from model_usage u
        where u.currency = s.currency and u.day between ${first}::date and ${last}::date) as spent,
      exists (select 1 from model_price p where p.model = ${input.llmModel}) as llm_priced,
      (${input.sttModel}::text is null
        or exists (select 1 from transcription_price t where t.model = ${input.sttModel}))
        as stt_priced,
      coalesce((select w.replies from whatsapp_usage_day w where w.day = ${today}::date), 0)
        as wa_today,
      l.daily_max, l.forward_interval_minutes, l.notices_daily_max,
      coalesce(h.started, 0) as h_started, coalesce(h.refused, 0) as h_refused,
      coalesce(h.notices, 0) as h_notices, coalesce(h.notices_held, 0) as h_held
    from usage_settings s
    left join handoff_limits l on l.id = 1
    left join handoff_day h on h.day = ${today}::date
    where s.id = 1
  `);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new ProtectionTimeout());
    }, input.readTimeoutMs ?? PROTECTION_READ_TIMEOUT_MS);
  });
  let row: Row | undefined;
  try {
    row = (await Promise.race([query, timeout])).rows[0];
  } catch (error) {
    // La consulta abandonada no debe dejar un rechazo sin atender.
    query.then(undefined, () => undefined);
    return unreadable(input, error instanceof Error ? error.name : 'Error');
  } finally {
    clearTimeout(timer);
  }
  // Sin la fila única de ajustes no se sabe si hay tope: también falla cerrado.
  if (!row) return unreadable(input, 'MissingSettings');

  const spentPico = BigInt(row.spent);
  const level = capLevel(spentPico, row.monthly_cap_cents, row.cap_enabled);
  const spendCap: SpendCapState = {
    level,
    spentPico,
    capCents: row.monthly_cap_cents,
    currency: row.currency,
    percent:
      level === 'none' || row.monthly_cap_cents === null
        ? null
        : capPercent(spentPico, row.monthly_cap_cents),
  };
  const contactOnly: ContactOnlyReason[] = [];
  if (input.production) {
    if (!row.cap_enabled) contactOnly.push('cap_disabled');
    if (!row.llm_priced) contactOnly.push('model_unpriced');
    if (!row.stt_priced) contactOnly.push('stt_unpriced');
  }
  const waToday = row.wa_today;
  return {
    production: input.production,
    contactOnly,
    spendCap,
    whatsapp: {
      today: waToday,
      cap: row.whatsapp_daily_cap,
      reached: waToday >= row.whatsapp_daily_cap,
    },
    handoffs:
      row.daily_max === null || row.forward_interval_minutes === null || row.notices_daily_max === null
        ? null
        : {
            started: row.h_started,
            refused: row.h_refused,
            notices: row.h_notices,
            held: row.h_held,
            limits: {
              dailyMax: row.daily_max,
              forwardIntervalMinutes: row.forward_interval_minutes,
              noticesDailyMax: row.notices_daily_max,
            },
          },
    unpricedModels: {
      llm: row.llm_priced ? null : input.llmModel,
      stt: row.stt_priced ? null : input.sttModel,
    },
    readFailure: null,
  };
}

/** Último `protection_read_failed` registrado por cada registro de actividad. */
const lastReadFailure = new WeakMap<ActivityLog, number>();

/** Marca el día local como avisado; `true` solo para quien lo marca primero (como el mes, R10). */
async function markWhatsappNotified(tx: DbOrTx, day: string): Promise<boolean> {
  const rows = await tx
    .update(usageSettings)
    .set({ whatsappCapNotifiedDay: day })
    .where(
      and(
        eq(usageSettings.id, 1),
        sql`${usageSettings.whatsappCapNotifiedDay} is distinct from ${day}::date`,
      ),
    )
    .returning({ id: usageSettings.id });
  return rows.length > 0;
}

/**
 * Comprobación de los canales de clientes finales (procesador, recepción, transcripción y
 * disponibilidad del chat web): el estado y, la primera vez en su periodo, los eventos
 * `spend_cap_reached` y `whatsapp_quota_reached` (marcas persistidas). Un fallo de lectura se
 * registra como mucho una vez por minuto. Nunca lanza.
 */
export async function checkProtection(
  tx: DbOrTx,
  input: ProtectionInput,
  activityLog: ActivityLog,
  logContext?: EventContext,
): Promise<ProtectionRead> {
  const state = await protectionState(tx, input);
  if (state.readFailure !== null) {
    const now = input.now.getTime();
    const last = lastReadFailure.get(activityLog);
    if (last === undefined || now - last >= READ_FAILURE_LOG_MS || now < last) {
      lastReadFailure.set(activityLog, now);
      activityLog.log({ event: 'protection_read_failed', errorClass: state.readFailure });
    }
    return state;
  }
  try {
    if (state.spendCap?.level === 'reached') {
      const { first } = localMonthRange(input.now, input.timezone);
      if (await markNotified(tx, first)) {
        activityLog.log({ event: 'spend_cap_reached', month: first.slice(0, 7) }, logContext);
      }
    }
    if (state.whatsapp?.reached) {
      if (await markWhatsappNotified(tx, localDay(input.now, input.timezone))) {
        activityLog.log({ event: 'whatsapp_quota_reached', cap: state.whatsapp.cap });
      }
    }
  } catch {
    // Las marcas solo evitan repetir el evento: si fallan, el estado sigue valiendo.
  }
  return state;
}

type Decision = { ok: true } | { ok: false; reason: CapReason };

function decide(reasons: CapReason[]): Decision {
  const first = REASON_ORDER.find((r) => reasons.includes(r));
  return first === undefined ? { ok: true } : { ok: false, reason: first };
}

function blockers(state: ProtectionState, channel: CustomerChannel): CapReason[] {
  const reasons: CapReason[] = state.contactOnly.filter((r) => r !== 'stt_unpriced');
  if (state.spendCap?.level === 'reached') reasons.push('spend_cap');
  if (channel === 'whatsapp' && state.whatsapp?.reached) reasons.push('whatsapp_daily');
  return reasons;
}

/** ¿Puede responder con el modelo un canal de clientes finales? El tope de la 004 va aparte. */
export function canCallModel(state: ProtectionState, channel: CustomerChannel): Decision {
  return decide(blockers(state, channel));
}

/** ¿Puede descargarse y transcribirse un audio de este canal? (R6). */
export function canTranscribe(state: ProtectionState, channel: CustomerChannel): Decision {
  const reasons = blockers(state, channel);
  if (state.contactOnly.includes('stt_unpriced')) reasons.push('stt_unpriced');
  return decide(reasons);
}

const INSTANCE_TARGET = { kind: 'instance' as const, label: 'Consumo' };

/**
 * Avisos de protección (data-model §2.2): se calculan en cada página y nunca se guardan; no
 * entran en `computeWarnings` ni en las escrituras protegidas (R3). Los críticos impiden activar.
 */
export function protectionWarnings(state: ProtectionState): Warning[] {
  const warnings: Warning[] = [];
  const critical = (code: Warning['code'], message: string): void => {
    warnings.push({ code, severity: 'critical', target: INSTANCE_TARGET, message });
  };
  if (state.contactOnly.includes('spend_unreadable')) {
    critical(
      'SPEND_UNREADABLE',
      'No se puede leer el gasto; el bot responde solo con el contacto del negocio.',
    );
  }
  if (state.contactOnly.includes('cap_disabled')) {
    critical(
      'SPEND_CAP_REQUIRED',
      'En producción el tope de gasto es obligatorio; mientras no lo actives, los clientes reciben solo el contacto del negocio.',
    );
  }
  if (state.contactOnly.includes('model_unpriced')) {
    critical(
      'MODEL_UNPRICED',
      `El modelo «${state.unpricedModels.llm ?? '?'}» no tiene precio; mientras no lo tenga, los clientes reciben solo el contacto del negocio.`,
    );
  }
  if (state.contactOnly.includes('stt_unpriced')) {
    critical(
      'STT_MODEL_UNPRICED',
      `El modelo de transcripción «${state.unpricedModels.stt ?? '?'}» no tiene precio; los audios se responden con el contacto del negocio.`,
    );
  }
  const held = state.handoffs?.held ?? 0;
  if (held > 0) {
    warnings.push({
      code: 'BUSINESS_NOTICES_HELD',
      severity: 'normal',
      target: INSTANCE_TARGET,
      message: `${held} ${held === 1 ? 'aviso al negocio retenido' : 'avisos al negocio retenidos'} hoy por el límite diario de avisos.`,
    });
  }
  return warnings;
}

/** Texto en español de cada motivo de «solo contacto» (recordatorio de «Probar el bot»). */
export const CONTACT_ONLY_TEXT: Record<ContactOnlyReason, string> = {
  cap_disabled: 'el tope de gasto está desactivado',
  model_unpriced: 'el modelo no tiene precio',
  stt_unpriced: 'el modelo de transcripción no tiene precio (solo los audios)',
  spend_unreadable: 'no se puede leer el gasto',
};
