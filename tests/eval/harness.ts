/**
 * Arnés de la suite `eval` (research R12): carga un negocio de ejemplo, pasa cada pregunta por
 * la cadena real (recepción → procesador → modelo de Anthropic) con un canal falso y comprueba
 * la respuesta. Requiere ANTHROPIC_API_KEY; sin ella la suite se omite.
 */
import { loadDotEnvIfPresent } from '../../src/config/env.js';
import { createIntake } from '../../src/conversation/intake.js';
import type { Clock } from '../../src/conversation/ports.js';
import { createProcessor } from '../../src/conversation/processor.js';
import { conversationSettings } from '../../src/conversation/settings.js';
import { activateBusiness } from '../../src/knowledge/services/business-status.js';
import { createKnowledgeReader } from '../../src/knowledge/snapshot.js';
import { createAnthropicChatModel, type Effort } from '../../src/llm/anthropic-chat-model.js';
import { loadFixture } from '../fixtures/load.js';
import type { BusinessFixture } from '../fixtures/types.js';
import { createTestDatabase, resetDb, type TestDatabase } from '../helpers/db.js';
import { FakeChannelSender, RecordingActivityLog } from '../helpers/fakes.js';
import { recordLatency } from './report.js';

loadDotEnvIfPresent();

export const hasApiKey = Boolean(process.env.ANTHROPIC_API_KEY?.trim());

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
}

export interface EvalQuestion {
  id: string;
  category: string;
  text: string;
  /** Instante en que se pregunta; por defecto el del sector. */
  at?: string;
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
  const hasContact = text.includes(normalize(contactLine));
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
}

export interface SectorRunner {
  ask(question: EvalQuestion): Promise<EvalAnswer>;
  close(): Promise<void>;
}

let phoneCounter = 0;

export async function createSectorRunner(sector: SectorQuestions): Promise<SectorRunner> {
  const t: TestDatabase = await createTestDatabase();
  await resetDb(t.db);
  await loadFixture(t.deps, sector.fixture);
  await activateBusiness(t.db);
  const reader = createKnowledgeReader(t.db);
  const chatModel = createAnthropicChatModel({
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: process.env.LLM_MODEL?.trim() || 'claude-sonnet-5',
    effort: (process.env.LLM_EFFORT?.trim() || 'medium') as Effort,
  });
  const contactLine = `Para hablar con una persona de ${String(sector.fixture.business.name)}`;

  return {
    async ask(question) {
      const clock = new OffsetClock(question.at ?? sector.at);
      const sender = new FakeChannelSender();
      const log = new RecordingActivityLog();
      const processor = createProcessor({
        db: t.db,
        reader,
        chatModel,
        sender,
        clock,
        activityLog: log,
        emergencyContactPhone: '+34600999888',
      });
      const intake = createIntake({ db: t.db, reader, clock, activityLog: log });
      // Un cliente nuevo por pregunta: cada una es una conversación independiente.
      phoneCounter += 1;
      const from = `+3469${String(phoneCounter).padStart(7, '0')}`;
      await intake.handle([
        {
          waMessageId: `eval-${question.id}-${phoneCounter}`,
          from,
          sentAt: clock.now(),
          kind: 'text',
          text: question.text,
          caption: null,
          mediaId: null,
          otherType: null,
          isGroup: false,
        },
      ]);
      clock.advance(conversationSettings.batchQuietMs);
      await processor.runOnce();
      const body = sender.sent.at(-1)?.body ?? '';
      const latencyMs = log.named('reply_sent')[0]?.latencyMs ?? null;
      if (latencyMs !== null) recordLatency(latencyMs);
      return {
        body,
        latencyMs,
        problems: body ? check(body, question.expect, contactLine) : ['sin respuesta'],
      };
    },
    close: () => t.close(),
  };
}
