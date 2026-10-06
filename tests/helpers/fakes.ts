/** Dobles de los puertos de src/conversation/ports.ts para tests. */
import { createHash } from 'node:crypto';
import type { ActivityLog, BotEvent, EventContext } from '../../src/conversation/activity-log.js';
import type { Channel } from '../../src/conversation/channels.js';
import {
  ChannelSendError,
  ChatModelError,
  MediaTooLargeError,
  SpeechToTextError,
  type Transcript,
  type ChannelSender,
  type ChatModel,
  type Clock,
  type MediaFetcher,
  type SendOptions,
  type SpeechToText,
} from '../../src/conversation/ports.js';
import type { ModelReply, ReplyContext } from '../../src/conversation/types.js';
import type { DbOrTx } from '../../src/conversation/repositories/customer.js';
import type {
  AlertRoute,
  AlertRoutesProvider,
  AlertSendResult,
  HandoffSummarizer,
} from '../../src/handoff/ports.js';
import { readHandoffAlerts } from '../../src/handoff/settings.js';
import type { BusinessNotice, HandoffKind, RouteName } from '../../src/handoff/types.js';
import type { TranscriptionRecordInput, UsageMeter } from '../../src/usage/meter.js';
import type { TokenUsage, UsageRecordInput } from '../../src/usage/types.js';

export class ManualClock implements Clock {
  private current: number;
  constructor(start: Date | string = '2026-09-24T08:00:00Z') {
    this.current = new Date(start).getTime();
  }
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current += ms;
  }
  set(at: Date | string): void {
    this.current = new Date(at).getTime();
  }
}

export const reply = (body: string, flags: Partial<ModelReply> = {}): ModelReply => ({
  body,
  handoffRequested: false,
  offerContact: false,
  bookingRequested: false,
  needsRephrase: false,
  mentionedServiceIds: [],
  complaint: false,
  acceptsHandoff: false,
  refusesContact: false,
  contactName: null,
  contactPhone: null,
  ...flags,
});

/** Tokens de prueba (010): como si el proveedor los informara. */
export const tokens = (
  input: number,
  output: number,
  cacheWrite = 0,
  cacheRead = 0,
): TokenUsage => ({ input, output, cacheWrite, cacheRead });

/** Paso programado del modelo falso. */
export type ModelStep =
  | ModelReply
  | ChatModelError
  | {
      reply?: ModelReply;
      error?: ChatModelError;
      /** Avanza el reloj manual como si la llamada tardara ese tiempo. */
      takesMs?: number;
      /** Espera real (ms) respetando el AbortSignal. */
      realDelayMs?: number;
      /**
       * Tokens que "informa el proveedor" por `onUsage` (010). También con `error`: la respuesta
       * llegó y se descartó. `null`: sin tokens aunque haya uno por defecto.
       */
      usage?: TokenUsage | null;
    };

export interface ModelCall {
  context: ReplyContext;
  feedback?: string;
}

export class FakeChatModel implements ChatModel {
  readonly calls: ModelCall[] = [];
  private readonly steps: ModelStep[] = [];
  /** Tokens por defecto de las respuestas (010); sin ellos el doble no informa uso. */
  private defaultUsage: TokenUsage | null = null;

  constructor(
    private readonly clock?: ManualClock,
    private readonly fallback: ModelReply = reply('Respuesta de prueba.'),
  ) {}

  /** Programa las respuestas siguientes, en orden. Sin pasos programados, usa `fallback`. */
  queue(...steps: ModelStep[]): this {
    this.steps.push(...steps);
    return this;
  }

  /** Cada respuesta (salvo errores sin `usage` propio) informa estos tokens por `onUsage`. */
  reportUsage(usage: TokenUsage | null): this {
    this.defaultUsage = usage;
    return this;
  }

  async reply(
    context: ReplyContext,
    opts: { signal: AbortSignal; feedback?: string; onUsage?: (usage: TokenUsage) => void },
  ): Promise<ModelReply> {
    this.calls.push({ context, feedback: opts.feedback });
    const step = this.steps.shift() ?? this.fallback;
    const report = (usage: TokenUsage | null | undefined) => {
      if (usage) opts.onUsage?.({ ...usage });
    };
    if (step instanceof ChatModelError) throw step;
    if ('body' in step) {
      report(this.defaultUsage);
      return step;
    }
    if (step.takesMs) this.clock?.advance(step.takesMs);
    if (step.realDelayMs) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, step.realDelayMs);
        opts.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new ChatModelError('timeout'));
        });
      });
    }
    if (opts.signal.aborted) throw new ChatModelError('timeout');
    if (step.error) {
      // Un error con tokens es una respuesta recibida y descartada (R1).
      report(step.usage);
      throw step.error;
    }
    report(step.usage === undefined ? this.defaultUsage : step.usage);
    return step.reply ?? this.fallback;
  }
}

export interface SentMessage {
  to: string;
  body: string;
}

export class FakeChannelSender implements ChannelSender {
  readonly sent: SentMessage[] = [];
  private failures: Array<{ status?: number }> = [];
  private counter = 0;

  /**
   * Prefijo del `channelMessageId` (columna `UNIQUE`): por defecto vacío, como antes. Los
   * llamantes que reutilizan la misma base de datos entre varias instancias (p. ej. la
   * evaluación, una por pregunta) deben dar un prefijo distinto para no chocar entre sí.
   */
  constructor(private readonly idPrefix = '') {}

  /** Los siguientes `n` envíos fallan con ese status. */
  failNext(n = 1, status?: number): this {
    for (let i = 0; i < n; i++) this.failures.push({ status });
    return this;
  }

  /**
   * Como el cliente real: falla `n` veces seguidas reintentando; antes de cada reintento llama
   * a `beforeRetry` (p. ej. para avanzar el reloj) y consulta `canRetry`.
   */
  failRetrying(n: number, beforeRetry: () => void, status = 503): this {
    this.retrying = { remaining: n, beforeRetry, status };
    return this;
  }
  private retrying: { remaining: number; beforeRetry: () => void; status: number } | null = null;
  readonly canRetryAnswers: boolean[] = [];

  async sendText(to: string, body: string, opts?: SendOptions) {
    const retrying = this.retrying;
    if (retrying) {
      this.retrying = null;
      let attempts = 1;
      while (retrying.remaining >= attempts) {
        retrying.beforeRetry();
        const allowed = opts?.canRetry?.() ?? true;
        this.canRetryAnswers.push(allowed);
        if (!allowed) throw new ChannelSendError(attempts, retrying.status);
        attempts += 1;
      }
    }
    const failure = this.failures.shift();
    if (failure) throw new ChannelSendError(1, failure.status);
    this.sent.push({ to, body });
    this.counter += 1;
    return { channelMessageId: `wamid.out.${this.idPrefix}${this.counter}` };
  }
}

/** Resultado programado de la transcripción falsa. */
export type SttStep =
  (Partial<Transcript> & { text: string; realDelayMs?: number }) | Error | { hang: true };

export class FakeSpeechToText implements SpeechToText {
  readonly calls: number[] = [];
  private readonly results: SttStep[] = [];

  queue(...results: SttStep[]): this {
    this.results.push(...results);
    return this;
  }

  async transcribe(
    audio: { data: Buffer; mimeType: string },
    opts: { signal: AbortSignal },
  ): Promise<Transcript> {
    this.calls.push(audio.data.length);
    const next = this.results.shift() ?? { text: '' };
    if (next instanceof Error) throw next;
    const delay = 'hang' in next ? Number.POSITIVE_INFINITY : (next.realDelayMs ?? 0);
    if (delay > 0) {
      // Espera real que respeta el AbortSignal (plazo de la transcripción).
      await new Promise<void>((resolve, reject) => {
        const timer = Number.isFinite(delay) ? setTimeout(resolve, delay) : undefined;
        opts.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new SpeechToTextError('timeout'));
        });
      });
    }
    if ('hang' in next) throw new SpeechToTextError('timeout');
    return { language: 'es', durationSeconds: 5, ...next };
  }
}

export class FakeMediaFetcher implements MediaFetcher {
  readonly calls: string[] = [];
  constructor(private readonly size = 1024) {}

  /** Señal de cada descarga (012: el plazo de la transcripción la cubre). */
  readonly signals: Array<AbortSignal | undefined> = [];
  async fetchAudio(mediaId: string, maxBytes: number, opts: { signal?: AbortSignal } = {}) {
    this.calls.push(mediaId);
    this.signals.push(opts.signal);
    if (this.size > maxBytes) throw new MediaTooLargeError();
    return { data: Buffer.alloc(this.size), mimeType: 'audio/ogg' };
  }
}

/** Registro técnico que guarda los eventos en memoria. */
export class RecordingActivityLog implements ActivityLog {
  readonly events: Array<BotEvent & { via?: string; customer?: string; conversationId?: string }> =
    [];
  log(event: BotEvent, context: EventContext = {}): void {
    const { channel, customerKey } = context;
    // Los eventos del negocio (005) llevan su propio `via` y se emiten sin contexto de cliente.
    this.events.push({
      ...event,
      ...(channel ? { via: channel } : {}),
      ...(channel && customerKey ? { customer: this.pseudonym(channel, customerKey) } : {}),
      ...(context.conversationId ? { conversationId: context.conversationId } : {}),
    } as (typeof this.events)[number]);
  }
  pseudonym(channel: Channel, customerKey: string): string {
    return createHash('sha256').update(`${channel}:${customerKey}`).digest('hex').slice(0, 12);
  }
  named<N extends BotEvent['event']>(name: N): Array<Extract<BotEvent, { event: N }>> {
    return this.events.filter((e) => e.event === name) as Array<Extract<BotEvent, { event: N }>>;
  }
}

// ---------------------------------------------------------------------------
// Derivación al negocio (005): vías de aviso y resumen.
// ---------------------------------------------------------------------------

/** Guion de una vía de aviso falsa. */
export type AlertStep =
  | { ok: true; ref?: string | null }
  | { fail: string }
  /** No responde hasta que se cancela (plazo de 15 s de la vía). */
  | { hang: true };

/** Vía de aviso falsa: guarda los avisos recibidos y responde según su guion. */
export class FakeAlertRoute implements AlertRoute {
  readonly received: BusinessNotice[] = [];
  private readonly steps: AlertStep[] = [];
  private counter = 0;

  constructor(
    readonly name: RouteName,
    private fallback: AlertStep = { ok: true },
  ) {}

  /** Programa las respuestas siguientes, en orden. Sin pasos programados, usa `fallback`. */
  queue(...steps: AlertStep[]): this {
    this.steps.push(...steps);
    return this;
  }

  /** Cambia la respuesta por defecto (p. ej. para que falle siempre). */
  always(step: AlertStep): this {
    this.fallback = step;
    return this;
  }

  async send(notice: BusinessNotice, opts: { signal: AbortSignal }): Promise<AlertSendResult> {
    this.received.push(notice);
    const step = this.steps.shift() ?? this.fallback;
    if ('hang' in step) {
      return new Promise((resolve) => {
        const done = () => {
          resolve({ ok: false, failure: 'timeout' });
        };
        if (opts.signal.aborted) done();
        else opts.signal.addEventListener('abort', done, { once: true });
      });
    }
    if ('fail' in step) return { ok: false, failure: step.fail };
    this.counter += 1;
    return {
      ok: true,
      ref: step.ref === undefined ? `${this.name}-ref-${this.counter}` : step.ref,
    };
  }
}

/**
 * Guion del resumidor falso. `usage` (010): tokens que "informa el proveedor" por `onUsage`,
 * también en un fallo tras recibir respuesta; `null` = sin tokens aunque haya uno por defecto.
 */
export type SummaryStep =
  | { summary: string; usage?: TokenUsage | null }
  | { fail: true; usage?: TokenUsage | null }
  | { hang: true };

/** Resumidor falso: guarda las entradas y responde según su guion. */
export class FakeSummarizer implements HandoffSummarizer {
  readonly calls: Array<{ kind: HandoffKind; customerTexts: string[] }> = [];
  private readonly steps: SummaryStep[] = [];
  private defaultUsage: TokenUsage | null = null;

  constructor(
    private readonly fallback: SummaryStep = { summary: 'Resumen de prueba del motivo.' },
  ) {}

  queue(...steps: SummaryStep[]): this {
    this.steps.push(...steps);
    return this;
  }

  /** Cada resumen (salvo `hang` y pasos con `usage` propio) informa estos tokens. */
  reportUsage(usage: TokenUsage | null): this {
    this.defaultUsage = usage;
    return this;
  }

  async summarize(
    input: { kind: HandoffKind; customerTexts: string[] },
    opts: { signal: AbortSignal; onUsage?: (usage: TokenUsage) => void },
  ): Promise<{ summary: string }> {
    this.calls.push({ kind: input.kind, customerTexts: [...input.customerTexts] });
    const step = this.steps.shift() ?? this.fallback;
    if ('hang' in step) {
      return new Promise((_resolve, reject) => {
        const done = () => {
          reject(new Error('timeout'));
        };
        if (opts.signal.aborted) done();
        else opts.signal.addEventListener('abort', done, { once: true });
      });
    }
    const usage = step.usage === undefined ? this.defaultUsage : step.usage;
    if (usage) opts.onUsage?.({ ...usage });
    if ('fail' in step) throw new Error('fallo del resumidor');
    return { summary: step.summary };
  }
}

/** Medidor de consumo sin BD (010): guarda lo que se le pide registrar. */
export class RecordingUsageMeter implements UsageMeter {
  readonly records: UsageRecordInput[] = [];
  readonly transcriptions: TranscriptionRecordInput[] = [];
  async record(input: UsageRecordInput): Promise<void> {
    this.records.push(structuredClone(input));
  }
  async recordTranscription(input: TranscriptionRecordInput): Promise<void> {
    this.transcriptions.push(structuredClone(input));
  }
}

/** Medidor que lanza: comprueba que quien lo llama no deja de responder (FR-005). */
export class FailingUsageMeter implements UsageMeter {
  attempts = 0;
  async record(): Promise<void> {
    this.attempts += 1;
    throw new Error('fallo del medidor');
  }
  async recordTranscription(): Promise<void> {
    this.attempts += 1;
    throw new Error('fallo del medidor');
  }
}

/**
 * Proveedor de vías falso: devuelve las vías dadas cuyo destino está configurado en
 * `handoff_alerts` (leído sin caché, como el real) y, en el playground, solo la simulada.
 */
export class FakeAlertRoutesProvider implements AlertRoutesProvider {
  constructor(
    private readonly routes: { whatsapp?: AlertRoute; email?: AlertRoute },
    private readonly simulated: AlertRoute,
  ) {}

  async available(tx: DbOrTx, opts: { simulate: boolean }): Promise<AlertRoute[]> {
    if (opts.simulate) return [this.simulated];
    const alerts = await readHandoffAlerts(tx);
    const out: AlertRoute[] = [];
    if (this.routes.whatsapp && alerts.whatsapp) out.push(this.routes.whatsapp);
    if (this.routes.email && alerts.email) out.push(this.routes.email);
    return out;
  }
}
