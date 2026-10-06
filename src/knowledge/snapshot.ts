/**
 * Puerto de lectura del bot (contracts/knowledge-reader.md).
 *
 * CONTRATO (FR-021): el snapshot se lee de la BD en cada llamada. Ningún módulo puede
 * cachearlo, memoizarlo ni guardarlo entre turnos de una conversación; así cualquier cambio
 * confirmado se aplica en la siguiente respuesta del bot.
 */
import { withReadSnapshot, type Db } from '../db/client.js';
import { effectiveHandoff } from './handoff.js';
import { loadKnowledgeState } from './state.js';
import type {
  DateRangeBlock,
  KnowledgeReader,
  KnowledgeSnapshot,
  KnowledgeState,
  ServiceRecord,
  SnapshotPrice,
  SnapshotScheduling,
} from './types.js';

const blankToNull = (v: string | null): string | null => (v === null || v.trim() === '' ? null : v);

function snapshotPrice(s: ServiceRecord): SnapshotPrice {
  if (s.priceType === 'on_request') return { type: 'on_request' };
  if (s.priceCents === null) return { type: 'missing' };
  return { type: s.priceType, amountCents: s.priceCents };
}

const toBlock = (b: DateRangeBlock): DateRangeBlock => ({
  startDate: b.startDate,
  endDate: b.endDate,
  startTime: b.startTime,
  endTime: b.endTime,
  reason: b.reason,
});

/** Construye la vista del bot. Función pura: solo lo registrado y activo, sin inventar nada. */
export function buildSnapshot(state: KnowledgeState): KnowledgeSnapshot {
  const activeServices = state.services.filter((s) => s.active);
  const activeServiceIds = new Set(activeServices.map((s) => s.id));
  const activeResources = state.resources.filter((r) => r.active);
  // Agenda única solo si no hay ningún recurso registrado, activo o inactivo (FR-013).
  const hasResources = state.resources.length > 0;

  const scheduling: SnapshotScheduling = hasResources
    ? {
        mode: 'resources',
        resources: activeResources.map((r) => ({
          id: r.id,
          name: r.name,
          serviceIds: r.serviceIds.filter((id) => activeServiceIds.has(id)),
          hours: r.hours.map((h) => ({ ...h })),
          absences: r.absences.map(toBlock),
        })),
      }
    : { mode: 'single_agenda' };

  return {
    status: state.business.status,
    business: {
      name: state.business.name,
      address: blankToNull(state.business.address),
      directions: blankToNull(state.business.directions),
      mapUrl: blankToNull(state.business.mapUrl),
      phone: blankToNull(state.business.phone),
      email: blankToNull(state.business.email),
      timezone: state.business.timezone,
      currency: state.business.currency,
    },
    openingHours: state.businessHours.map((h) => ({ ...h })),
    closures: state.closures.map(toBlock),
    services: activeServices.map((s) => {
      const resourceIds = activeResources
        .filter((r) => r.serviceIds.includes(s.id))
        .map((r) => r.id);
      const bookable =
        s.bookable && s.durationMinutes !== null && (!hasResources || resourceIds.length > 0);
      return {
        id: s.id,
        name: s.name,
        description: blankToNull(s.description),
        price: snapshotPrice(s),
        durationMinutes: s.durationMinutes,
        bookable,
        resourceIds,
      };
    }),
    scheduling,
    faqs: state.faqs.map((f) => ({ question: f.question, answer: f.answer })),
    policies: {
      cancellationText: blankToNull(state.policies?.cancellationText ?? null),
      cancellationNoticeMinutes: state.policies?.cancellationNoticeMinutes ?? null,
      minAdvanceMinutes: state.policies?.minAdvanceMinutes ?? null,
      maxAdvanceMinutes: state.policies?.maxAdvanceMinutes ?? null,
      paymentMethods: [...(state.policies?.paymentMethods ?? [])],
    },
    tone: {
      addressForm: state.tone?.addressForm ?? null,
      styleDescription: blankToNull(state.tone?.styleDescription ?? null),
    },
    handoff: effectiveHandoff(state),
    updatedAt: state.maxUpdatedAt,
  };
}

/** Lector del bot: cada `getSnapshot()` abre una transacción de solo lectura nueva, sin caché. */
export function createKnowledgeReader(db: Db): KnowledgeReader {
  return {
    async getSnapshot() {
      const state = await withReadSnapshot(db, (tx) => loadKnowledgeState(tx));
      return buildSnapshot(state);
    },
  };
}
