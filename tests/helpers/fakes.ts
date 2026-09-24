/** Dobles de los puertos de src/conversation/ports.ts para tests. */
import { createHash } from 'node:crypto';
import type { ActivityLog, BotEvent, EventContext } from '../../src/conversation/activity-log.js';
import {
  ChannelSendError,
  ChatModelError,
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

  async sendText(to: string, body: string, _opts?: SendOptions) {
    const failure = this.failures.shift();
    if (failure) throw new ChannelSendError(1, failure.status);
    this.sent.push({ to, body });
    this.counter += 1;
    return { channelMessageId: `wamid.out.${this.counter}` };
  }
}

export class FakeSpeechToText implements SpeechToText {
  readonly calls: number[] = [];
  private readonly results: Array<{ text: string; language: string } | Error> = [];

  queue(...results: Array<{ text: string; language: string } | Error>): this {
    this.results.push(...results);
    return this;
  }

  async transcribe(audio: { data: Buffer; mimeType: string }) {
    this.calls.push(audio.data.length);
    const next = this.results.shift() ?? { text: '', language: 'es' };
    if (next instanceof Error) throw next;
    return next;
  }
}

export class FakeMediaFetcher implements MediaFetcher {
  readonly calls: string[] = [];
  constructor(private readonly size = 1024) {}

  async fetchAudio(mediaId: string, maxBytes: number) {
    this.calls.push(mediaId);
    if (this.size > maxBytes) throw new Error('Audio demasiado grande');
    return { data: Buffer.alloc(this.size), mimeType: 'audio/ogg' };
  }
}

/** Registro técnico que guarda los eventos en memoria. */
export class RecordingActivityLog implements ActivityLog {
  readonly events: Array<BotEvent & { customer?: string; conversationId?: string }> = [];
  log(event: BotEvent, context: EventContext = {}): void {
    this.events.push({
      ...event,
      ...(context.phone ? { customer: this.pseudonym(context.phone) } : {}),
      ...(context.conversationId ? { conversationId: context.conversationId } : {}),
    });
  }
  pseudonym(phone: string): string {
    return createHash('sha256').update(phone).digest('hex').slice(0, 12);
  }
  named<N extends BotEvent['event']>(name: N): Array<Extract<BotEvent, { event: N }>> {
    return this.events.filter((e) => e.event === name) as Array<Extract<BotEvent, { event: N }>>;
  }
}
