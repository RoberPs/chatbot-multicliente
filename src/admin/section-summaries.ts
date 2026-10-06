/**
 * Resúmenes de Políticas, Tono y Derivación para la portada (003, FR-009). Se calculan en cada
 * petición a partir del estado que ya carga la portada; no se guardan.
 */
import { effectiveHandoff } from '../knowledge/handoff.js';
import type { KnowledgeState } from '../knowledge/types.js';

export const NOT_CONFIGURED = 'Sin configurar';

export interface SectionSummaries {
  policies: string;
  tone: string;
  handoff: string;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function policiesSummary(state: KnowledgeState): string {
  const p = state.policies;
  const hasCancellation = !!p?.cancellationText?.trim() || p?.cancellationNoticeMinutes != null;
  const empty =
    !p ||
    (!hasCancellation &&
      p.minAdvanceMinutes === null &&
      p.maxAdvanceMinutes === null &&
      p.paymentMethods.length === 0);
  if (!p || empty) return NOT_CONFIGURED;
  const n = p.paymentMethods.length;
  const payments = n === 0 ? 'sin formas de pago' : plural(n, 'forma de pago', 'formas de pago');
  return `${payments} · ${hasCancellation ? 'con' : 'sin'} política de cancelación`;
}

function toneSummary(state: KnowledgeState): string {
  const t = state.tone;
  if (!t) return NOT_CONFIGURED;
  const form = t.addressForm === 'formal' ? 'trato de usted' : 'trato de tú';
  return t.styleDescription?.trim() ? `${form} · con estilo propio` : form;
}

function handoffSummary(state: KnowledgeState): string {
  const effective = effectiveHandoff(state);
  switch (effective.source) {
    case 'configured':
      return plural(effective.channels.length, 'medio', 'medios');
    case 'business_phone':
      return 'usa el teléfono del negocio';
    case 'none':
      return NOT_CONFIGURED;
  }
}

export function sectionSummaries(state: KnowledgeState): SectionSummaries {
  return {
    policies: policiesSummary(state),
    tone: toneSummary(state),
    handoff: handoffSummary(state),
  };
}
