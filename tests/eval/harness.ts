/**
 * Arnés de la suite `eval` (research R12): carga un negocio de ejemplo, pasa cada pregunta por
 * la cadena real (recepción → procesador → modelo de Anthropic) con un canal falso y comprueba
 * la respuesta. Requiere ANTHROPIC_API_KEY; sin ella la suite se omite.
 *
 * `EVAL_CHANNEL=web` (004, SC-002) envía las preguntas por el canal web, con el chat activado
 * en la BD de la evaluación; por defecto, `whatsapp`.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { loadDotEnvIfPresent } from '../../src/config/env.js';
import { buildChannelPolicies, type Channel } from '../../src/conversation/channels.js';
import { createIntake } from '../../src/conversation/intake.js';
import { MediaTooLargeError, type Clock, type MediaFetcher } from '../../src/conversation/ports.js';
import { createProcessor } from '../../src/conversation/processor.js';
import { conversationSettings } from '../../src/conversation/settings.js';
import { createTranscriber } from '../../src/conversation/transcription.js';
import type { ReplyTemplate } from '../../src/conversation/activity-log.js';
import type { HandoffAction } from '../../src/conversation/types.js';
import { createHandoffService } from '../../src/handoff/service.js';
import { createSimulatedRoute } from '../../src/handoff/simulated-route.js';
import { createTokenCipher } from '../../src/handoff/tokens.js';
import type { InboundEvent } from '../../src/conversation/types.js';
import { webChatSettings } from '../../src/db/schema.js';
import { activateBusiness } from '../../src/knowledge/services/business-status.js';
import { createKnowledgeReader } from '../../src/knowledge/snapshot.js';
import { createAnthropicChatModel, type Effort } from '../../src/llm/anthropic-chat-model.js';
import { createWhisperSpeechToText } from '../../src/speech/whisper.js';
import { loadFixture } from '../fixtures/load.js';
import type { BusinessFixture } from '../fixtures/types.js';
import { createTestDatabase, resetDb, setHandoffAlerts, type TestDatabase } from '../helpers/db.js';
import {
  FakeAlertRoute,
  FakeAlertRoutesProvider,
  FakeChannelSender,
  FakeSummarizer,
  RecordingActivityLog,
} from '../helpers/fakes.js';
import { recordLatency } from './report.js';

loadDotEnvIfPresent();

export const hasApiKey = Boolean(process.env.ANTHROPIC_API_KEY?.trim());
export const hasSttKey = Boolean(process.env.STT_API_KEY?.trim());

/** Canal por el que se hacen las preguntas (SC-002 de la 004). */
export const evalChannel: Extract<Channel, 'whatsapp' | 'web'> =
  process.env.EVAL_CHANNEL?.trim() === 'web' ? 'web' : 'whatsapp';

/** Audios de prueba de SC-009 (tests/fixtures/audio/README.md). */
export const AUDIO_DIR = new URL('../fixtures/audio/', import.meta.url);

export type Pattern = string | RegExp;

export interface Expectation {
  /** Deben aparecer todos. */
  includes?: Pattern[];
  /** Debe aparecer al menos uno de cada grupo. */
  includesAny?: Pattern[][];
  /** No debe aparecer ninguno. */
  excludes?: Pattern[];
  /** Debe (true) o no debe (false) llevar el bloque de contacto. */
  contact?: boolean;
  /** Ningún importe fuera del bloque de contacto (SC-002). */
  noAmounts?: boolean;
  /** Debe (true) o no debe (false) empezar por el saludo de presentación (SC-005). */
  greeting?: boolean;
  /** Longitud máxima de lo que va antes del contacto (respuestas breves a cortesías). */
  maxLength?: number;
}

/** Criterio de éxito que mide cada pregunta (spec, "Success Criteria"). */
export type Criterion = 'SC-001' | 'SC-002' | 'SC-005' | 'SC-006' | 'SC-007' | 'SC-008' | 'SC-009';

export interface EvalQuestion {
  id: string;
  category: string;
  /** Por defecto SC-001 (pregunta con dato registrado). */
  criterion?: Criterion;
  text: string;
  /** Instante en que se pregunta; por defecto el del sector. */
  at?: string;
  /** Mensajes anteriores de la misma conversación, contestados antes que `text`. */
  previous?: string[];
  /** La misma pregunta con faltas o lenguaje coloquial (SC-004): misma expectativa. */
  variants?: string[];
  /**
   * El mensaje es un archivo en lugar de un texto: `text` es su pie (vacío si no tiene) o,
   * en un audio, lo que dice la grabación `file` de tests/fixtures/audio/.
   */
  media?: { type: 'image' | 'sticker' | 'video' | 'document' | 'audio'; file?: string };
  expect: Expectation;
}

export interface SectorQuestions {
  fixture: BusinessFixture;
  /** Instante por defecto de las preguntas. */
  at: string;
  questions: EvalQuestion[];
}

/** Patrones de uso común en las expectativas. */
export const CLOSED =
  /cerrad|cerramos|no abr|no (?:estamos|esta|está) abiert|no (?:hay|tenemos) horario/;
export const OPEN = /abiert|\bs[ií]\b/;
/** Reconoce que no tiene el dato (sobre texto normalizado, sin tildes). */
export const NO_INFO =
  /no (?:dispong|dispone|tengo|tenemos|cuento|consta|figura|aparece|ofrec|hac|realiz|trabaj|reparam|atend|se )|sin informacion|no hay informacion|no puedo (?:darte|darle|confirmar|indicar|decir)/;
/** Comienzo del saludo, normalizado. */
const GREETING_START = '¡hola! soy el asistente automatico de';
/** Formas de tú, que no deben aparecer cuando se trata de usted. */
export const TU_FORMS =
  /\b(?:puedes|quieres|tienes|necesitas|prefieres|llamanos|escribenos|te (?:ayudo|recomiendo|puedo)|contigo|tu consulta)\b/;
/** Formas de usted, que no deben aparecer cuando se trata de tú. */
export const USTED_FORMS = /\busted\b|\b(?:le (?:ayudo|recomiendo|puedo)|su consulta)\b/;
/** Dice que no gestiona citas por este medio. */
export const NO_BOOKING =
  /no (?:puedo|podemos|es posible|gestiono|me es posible)|no (?:tengo|dispongo de) acceso/;

/** Reconduce hacia lo que puede atender (preguntas ajenas, SC-006). */
export const REDIRECT =
  /solo (?:puedo|te puedo|le puedo)|unicamente puedo|no puedo (?:ayudar|responder|contestar|hablar)|(?:puedo|podemos) (?:ayudarte|ayudarle|informarte|informarle) (?:con|sobre)|no es algo (?:en lo|con lo) que/;
/** Afirma que algo es gratis (sin contar "no es gratis"). */
export const SAYS_FREE = /(?<!no )(?:es|sera|seria) gratis|gratuit/;

/** Cualquier importe con moneda (sobre texto normalizado): "25 €", "25,00 eur", "40 euros". */
export const AMOUNT = /\d+(?:[.,]\d+)?\s?(?:€|eur\b|euros?\b)|€\s?\d/;

/** Minúsculas, sin tildes y con las horas sin cero inicial ("09:00" → "9:00"). */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\b0(\d):(\d{2})\b/g, '$1:$2')
    .replace(/\s+/g, ' ');
}

const matches = (text: string, p: Pattern) =>
  typeof p === 'string' ? text.includes(normalize(p)) : p.test(text);

export function check(body: string, expectation: Expectation, contactLine: string): string[] {
  const text = normalize(body);
  const problems: string[] = [];
  for (const p of expectation.includes ?? []) {
    if (!matches(text, p)) problems.push(`falta ${String(p)}`);
  }
  for (const group of expectation.includesAny ?? []) {
    if (!group.some((p) => matches(text, p)))
      problems.push(`falta uno de ${group.map(String).join(' | ')}`);
  }
  for (const p of expectation.excludes ?? []) {
    if (matches(text, p)) problems.push(`sobra ${String(p)}`);
  }
  const contactAt = text.indexOf(normalize(contactLine));
  const hasContact = contactAt >= 0;
  const beforeContact = hasContact ? text.slice(0, contactAt) : text;
  if (expectation.noAmounts && AMOUNT.test(beforeContact)) problems.push('sobra un importe');
  const greeted = text.startsWith(GREETING_START);
  if (expectation.greeting === true && !greeted) problems.push('falta el saludo');
  if (expectation.greeting === false && text.includes(GREETING_START))
    problems.push('sobra el saludo');
  if (expectation.maxLength !== undefined && beforeContact.trim().length > expectation.maxLength)
    problems.push(`más de ${expectation.maxLength} caracteres`);
  if (expectation.contact === true && !hasContact) problems.push('falta el contacto');
  if (expectation.contact === false && hasContact) problems.push('sobra el contacto');
  return problems;
}

/** Reloj real desplazado: la espera de agrupado se salta sin perder la latencia real. */
class OffsetClock implements Clock {
  private offset: number;
  constructor(at: string) {
    this.offset = new Date(at).getTime() - Date.now();
  }
  now(): Date {
    return new Date(Date.now() + this.offset);
  }
  advance(ms: number): void {
    this.offset += ms;
  }
}

export interface EvalAnswer {
  body: string;
  latencyMs: number | null;
  problems: string[];
  /** Plantilla de la última respuesta (005: R-HANDOFF-OK, R-HANDOFF-ASK…); `null` si no. */
  template: ReplyTemplate | null;
  /** Qué hizo la derivación en la última respuesta (005: offered, asked, started…). */
  handoffAction: HandoffAction | null;
}

export interface SectorRunner {
  ask(question: EvalQuestion): Promise<EvalAnswer>;
  close(): Promise<void>;
}

let phoneCounter = 0;

/** Lee los audios de prueba del disco en lugar de la Graph API. */
const fixtureAudio: MediaFetcher = {
  async fetchAudio(file, maxBytes) {
    const url = new URL(file, AUDIO_DIR);
    if ((await stat(url)).size > maxBytes) throw new MediaTooLargeError();
    return { data: await readFile(url), mimeType: 'audio/ogg' };
  },
};

/** Evento de entrada para el último mensaje de una pregunta. */
function lastEvent(
  question: EvalQuestion,
  audio: boolean,
): Omit<InboundEvent, 'channel' | 'channelUserId' | 'channelMessageId' | 'sentAt'> {
  const base = {
    caption: null,
    mediaId: null,
    otherType: null,
    isGroup: false,
    profileName: null,
    buttonPayload: null,
  };
  const media = question.media;
  if (!media) return { ...base, kind: 'text', text: question.text };
  if (media.type === 'audio' && audio && media.file) {
    return { ...base, kind: 'audio', text: null, mediaId: media.file };
  }
  return {
    ...base,
    kind: 'other',
    text: null,
    otherType: media.type,
    caption: question.text.trim() || null,
  };
}

export interface RunnerOptions {
  /** Activa los audios con Whisper real (requiere STT_API_KEY). */
  audio?: boolean;
  /**
   * Con vías de aviso falsas (005): destinos de WhatsApp y email configurados, las vías
   * siempre entregan y el resumen es fijo. Sin esta opción el bot no tiene vías (como la 002).
   */
  handoffRoutes?: boolean;
}

export async function createSectorRunner(
  sector: SectorQuestions,
  opts: RunnerOptions = {},
): Promise<SectorRunner> {
  const t: TestDatabase = await createTestDatabase();
  await resetDb(t.db);
  await loadFixture(t.deps, sector.fixture);
  await activateBusiness(t.db);
  if (opts.handoffRoutes) {
    await setHandoffAlerts(t.db, { whatsapp: '+34611000111', email: 'avisos@negocio.example' });
  }
  if (evalChannel === 'web') {
    await t.db.update(webChatSettings).set({
      enabled: true,
      allowedOrigins: ['https://negocio.example'],
      privacyUrl: 'https://negocio.example/privacidad',
      // Sin tope efectivo durante la evaluación.
      dailyCap: 1_000_000,
      monthlyCap: 1_000_000,
    });
  }
  const reader = createKnowledgeReader(t.db);
  const chatModel = createAnthropicChatModel({
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: process.env.LLM_MODEL?.trim() || 'claude-sonnet-5',
    effort: (process.env.LLM_EFFORT?.trim() || 'medium') as Effort,
  });
  const contactLine = `Para hablar con una persona de ${String(sector.fixture.business.name)}`;
  const audio = opts.audio ?? false;
  const stt = audio
    ? createWhisperSpeechToText({
        apiKey: process.env.STT_API_KEY ?? '',
        model: process.env.STT_MODEL?.trim() || 'whisper-1',
      })
    : null;

  return {
    async ask(question) {
      const clock = new OffsetClock(question.at ?? sector.at);
      const sender = new FakeChannelSender();
      const log = new RecordingActivityLog();
      // El mismo doble recoge las respuestas de WhatsApp y las guardadas de la web.
      const policies = buildChannelPolicies({ whatsappSender: sender, stored: sender });
      // Derivación (005) con vías falsas; sin destinos configurados no hay vías.
      const handoff = createHandoffService({
        db: t.db,
        clock,
        reader,
        activityLog: log,
        routes: new FakeAlertRoutesProvider(
          { whatsapp: new FakeAlertRoute('whatsapp'), email: new FakeAlertRoute('email') },
          createSimulatedRoute(clock),
        ),
        summarizer: new FakeSummarizer(),
        cipher: createTokenCipher('00'.repeat(32)),
        phoneRegion: 'ES',
        policies,
      });
      const processor = createProcessor({
        db: t.db,
        reader,
        chatModel,
        policies,
        clock,
        activityLog: log,
        emergencyContactPhone: '+34600999888',
        audioTranscription: audio,
        handoff,
      });
      const transcriber = stt
        ? createTranscriber({
            db: t.db,
            media: fixtureAudio,
            stt,
            activityLog: log,
            wake: () => undefined,
          })
        : null;
      const intake = createIntake({
        db: t.db,
        reader,
        clock,
        activityLog: log,
        policies,
        ...(transcriber ? { transcriber } : {}),
      });
      // Un cliente nuevo por pregunta: cada una es una conversación independiente.
      phoneCounter += 1;
      const channelUserId =
        evalChannel === 'web'
          ? createHash('sha256').update(randomUUID()).digest('hex')
          : `+3469${String(phoneCounter).padStart(7, '0')}`;
      const messageId = (i: number) =>
        evalChannel === 'web'
          ? `web:${channelUserId}:${randomUUID()}`
          : `eval-${question.id}-${phoneCounter}-${i}`;
      // Los mensajes previos se contestan uno a uno en la misma conversación.
      const texts = [...(question.previous ?? []), question.text];
      for (const [i, text] of texts.entries()) {
        const last = i === texts.length - 1;
        await intake.handle([
          {
            channel: evalChannel,
            channelUserId,
            channelMessageId: messageId(i),
            sentAt: clock.now(),
            ...(last
              ? lastEvent(question, audio)
              : {
                  kind: 'text' as const,
                  text,
                  caption: null,
                  mediaId: null,
                  otherType: null,
                  isGroup: false,
                  profileName: null,
                  buttonPayload: null,
                }),
          },
        ]);
        await transcriber?.idle();
        clock.advance(conversationSettings.batchQuietMs);
        await processor.runOnce();
      }
      const body = sender.sent.length === texts.length ? (sender.sent.at(-1)?.body ?? '') : '';
      const lastReply = log.named('reply_sent').at(-1);
      const latencyMs = lastReply?.latencyMs ?? null;
      if (latencyMs !== null) recordLatency(latencyMs);
      return {
        body,
        latencyMs,
        template: lastReply?.template ?? null,
        handoffAction: lastReply?.handoffAction ?? null,
        problems: body ? check(body, question.expect, contactLine) : ['sin respuesta'],
      };
    },
    close: () => t.close(),
  };
}
