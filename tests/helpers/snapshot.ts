/** Snapshot y contexto de respuesta en memoria para los tests unitarios de conversación. */
import type { DerivedFacts, ReplyContext } from '../../src/conversation/types.js';
import { buildSnapshot } from '../../src/knowledge/snapshot.js';
import type { KnowledgeSnapshot, KnowledgeState } from '../../src/knowledge/types.js';
import { configuredHandoff, emptyState, service, typicalWeek } from './state.js';

/** Negocio activo con horario típico, un servicio de cada tipo de precio y contacto. */
export function activeState(overrides: Partial<KnowledgeState> = {}): KnowledgeState {
  const base = emptyState();
  return emptyState({
    business: {
      ...base.business,
      name: 'Negocio Demo',
      address: 'Calle Mayor 12, 28013 Madrid',
      directions: 'Junto a la plaza, portal 3',
      phone: '+34 910 000 000',
      status: 'active',
    },
    businessHours: typicalWeek(),
    services: [
      service({ id: '00000000-0000-4000-8000-00000000a001', name: 'Básico', priceCents: 2500 }),
      service({
        id: '00000000-0000-4000-8000-00000000a002',
        name: 'Completo',
        priceType: 'from',
        priceCents: 4000,
        durationMinutes: 90,
      }),
      service({
        id: '00000000-0000-4000-8000-00000000a003',
        name: 'Especial',
        priceType: 'on_request',
        priceCents: null,
      }),
    ],
    handoff: configuredHandoff(),
    ...overrides,
  });
}

export const activeSnapshot = (overrides: Partial<KnowledgeState> = {}): KnowledgeSnapshot =>
  buildSnapshot(activeState(overrides));

export const emptyDerived = (): DerivedFacts => ({
  now: { date: '2026-09-24', time: '10:00', weekday: 4, timezone: 'Europe/Madrid' },
  openNow: true,
  next14Days: [],
  prices: [],
  policies: { cancellationNotice: null, minAdvance: null, maxAdvance: null },
  handoffHoursText: null,
});

export function replyContext(overrides: Partial<ReplyContext> = {}): ReplyContext {
  return {
    snapshot: activeSnapshot(),
    derived: emptyDerived(),
    history: [],
    pending: [{ kind: 'text', text: '¿A qué hora abrís?' }],
    greetingPrepended: false,
    addressForm: null,
    ...overrides,
  };
}
