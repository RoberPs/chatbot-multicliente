/**
 * Resumen del motivo de una derivación (005, R4). Lo pide al `HandoffSummarizer` con un plazo
 * de 8 s, lo verifica por código (ningún dato que el cliente no escribiera, ≤ 300 caracteres,
 * una línea) y, si algo falla, usa un respaldo literal: el aviso nunca se queda sin motivo.
 */
import type { ActivityLog, EventContext } from '../conversation/activity-log.js';
import { extractFacts, type ExtractedFact } from '../conversation/grounding.js';
import { detectsHandoffRequest } from '../conversation/handoff-detector.js';
import type { HandoffSummarizer } from './ports.js';
import type { HandoffKind } from './types.js';

export const SUMMARY_MAX_CHARS = 300;
export const SUMMARY_BUDGET_MS = 8_000;
export const NO_REASON_SUMMARY = 'El cliente pidió hablar con una persona sin dar el motivo.';

/** Un mensaje que solo pide la persona no explica el motivo. */
const BARE_REQUEST_MAX_CHARS = 60;

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** Claves comparables de un dato: su valor y sus equivalentes. */
function factKeys(fact: ExtractedFact): string[] {
  return [
    `${fact.category}:${fact.value}`,
    ...(fact.alternatives ?? []).map((v) => `${fact.category}:${v}`),
    ...(fact.asNumber === undefined ? [] : [`number:${fact.asNumber}`]),
  ];
}

/** Todos los datos concretos del resumen aparecen en los textos del cliente (FR-007). */
export function summaryIsGrounded(summary: string, customerTexts: string[]): boolean {
  const known = new Set(customerTexts.flatMap((t) => extractFacts(t).flatMap(factKeys)));
  return extractFacts(summary).every((f) => factKeys(f).some((k) => known.has(k)));
}

/** Resumen aceptable: una línea, no vacío, ≤ 300 caracteres y sin datos inventados. */
export function acceptableSummary(summary: string, customerTexts: string[]): boolean {
  const text = summary.trim();
  return (
    text !== '' &&
    !/[\r\n\t]/.test(text) &&
    text.length <= SUMMARY_MAX_CHARS &&
    summaryIsGrounded(text, customerTexts)
  );
}

/**
 * Respaldo por código: un extracto literal de los últimos mensajes del cliente (sin los que
 * solo piden la persona), recortado a 300 caracteres; sin ninguno, la frase de "sin motivo".
 */
export function fallbackSummary(kind: HandoffKind, customerTexts: string[]): string {
  const texts = customerTexts
    .map(oneLine)
    .filter((t) => t !== '')
    .filter((t) => !(detectsHandoffRequest(t) && t.length <= BARE_REQUEST_MAX_CHARS));
  if (texts.length === 0) return NO_REASON_SUMMARY;
  const prefix = kind === 'complaint' ? 'Queja: ' : '';
  const room = SUMMARY_MAX_CHARS - prefix.length;
  // Desde el final: los últimos mensajes que caben enteros.
  const picked: string[] = [];
  let length = 0;
  for (const text of [...texts].reverse()) {
    const added = text.length + (picked.length > 0 ? 3 : 0);
    if (length + added > room) break;
    picked.unshift(text);
    length += added;
  }
  if (picked.length === 0) {
    const last = texts.at(-1) ?? '';
    return `${prefix}${last.slice(0, room - 1).trimEnd()}…`;
  }
  return `${prefix}${picked.join(' / ')}`;
}

export interface SummarizeInput {
  summarizer: HandoffSummarizer;
  kind: HandoffKind;
  /** Solo textos del cliente, en orden (R4). */
  customerTexts: string[];
  activityLog: ActivityLog;
  logContext?: EventContext;
  /** Plazo del resumen; 8 s en producción. */
  budgetMs?: number;
}

export async function summarizeHandoff(
  input: SummarizeInput,
): Promise<{ summary: string; source: 'model' | 'fallback' }> {
  const { kind, customerTexts } = input;
  const controller = new AbortController();
  const budget = input.budgetMs ?? SUMMARY_BUDGET_MS;
  const timer = setTimeout(() => {
    controller.abort();
  }, budget);
  let reason: 'timeout' | 'model_error' | 'unverified';
  try {
    const { summary } = await Promise.race([
      input.summarizer.summarize({ kind, customerTexts }, { signal: controller.signal }),
      new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => {
          reject(new Error('timeout'));
        });
      }),
    ]);
    const text = summary.trim();
    if (acceptableSummary(text, customerTexts)) return { summary: text, source: 'model' };
    reason = 'unverified';
  } catch {
    reason = controller.signal.aborted ? 'timeout' : 'model_error';
  } finally {
    clearTimeout(timer);
  }
  input.activityLog.log({ event: 'handoff_summary_fallback', reason }, input.logContext);
  return { summary: fallbackSummary(kind, customerTexts), source: 'fallback' };
}
