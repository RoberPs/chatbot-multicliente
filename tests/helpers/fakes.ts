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
    };

export interface ModelCall {
  context: ReplyContext;
  feedback?: string;
}

export class FakeChatModel implements ChatModel {
  readonly calls: ModelCall[] = [];
  private readonly steps: ModelStep[] = [];

  constructor(
    private readonly clock?: ManualClock,
    private readonly fallback: ModelReply = reply('Respuesta de prueba.'),
  ) {}

  /** Programa las respuestas siguientes, en orden. Sin pasos programados, usa `fallback`. */
  queue(...steps: ModelStep[]): this {
    this.steps.push(...steps);
    return this;
  }

  async reply(
    context: ReplyContext,
    opts: { signal: AbortSignal; feedback?: string },
  ): Promise<ModelReply> {
    this.calls.push({ context, feedback: opts.feedback });
    const step = this.steps.shift() ?? this.fallback;
    if (step instanceof ChatModelError) throw step;
    if ('body' in step) return step;
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
    if (step.error) throw step.error;
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
    return { channelMessageId: `wamid.out.${this.counter}` };
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

  async fetchAudio(mediaId: string, maxBytes: number) {
    this.calls.push(mediaId);
    if (this.size > maxBytes) throw new MediaTooLargeError();
    return { data: Buffer.alloc(this.size), mimeType: 'audio/ogg' };
  }
}

/** Registro técnico que guarda los eventos en memoria. */
export class RecordingActivityLog implements ActivityLog {
  readonly events: Array<
    BotEvent & { via?: string; customer?: string; conversationId?: string }
  > = [];
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
