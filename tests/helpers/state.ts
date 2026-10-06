/** Constructores de estados en memoria para los tests unitarios de avisos y snapshot. */
import type {
  KnowledgeState,
  ResourceRecord,
  ServiceRecord,
  WeeklySlot,
  Weekday,
} from '../../src/knowledge/types.js';

const T = '2026-09-24T10:00:00.000000Z';

export function emptyState(overrides: Partial<KnowledgeState> = {}): KnowledgeState {
  return {
    business: {
      name: '',
      address: null,
      directions: null,
      mapUrl: null,
      phone: null,
      email: null,
      timezone: 'Europe/Madrid',
      currency: 'EUR',
      status: 'draft',
      updatedAt: T,
    },
    businessHours: [],
    businessHoursUpdatedAt: null,
    closures: [],
    services: [],
    resources: [],
    faqs: [],
    policies: null,
    tone: null,
    handoff: null,
    handoffAlerts: { whatsapp: null, email: null, routes: { whatsapp: false, email: false } },
    maxUpdatedAt: T,
    ...overrides,
  };
}

let counter = 0;
const nextId = () => {
  counter += 1;
  return `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
};

export function service(overrides: Partial<ServiceRecord> = {}): ServiceRecord {
  return {
    id: nextId(),
    name: 'Servicio',
    description: null,
    priceType: 'fixed',
    priceCents: 2000,
    durationMinutes: 30,
    bookable: true,
    active: true,
    sortOrder: 0,
    updatedAt: T,
    ...overrides,
  };
}

export function resource(overrides: Partial<ResourceRecord> = {}): ResourceRecord {
  return {
    id: nextId(),
    name: 'Recurso',
    active: true,
    sortOrder: 0,
    updatedAt: T,
    serviceIds: [],
    hours: [],
    absences: [],
    ...overrides,
  };
}

export const slot = (weekday: Weekday, start: string, end: string): WeeklySlot => ({
  weekday,
  start,
  end,
});

/** L–V 09:00–14:00 y 16:00–20:00, S 10:00–14:00. */
export const typicalWeek = (): WeeklySlot[] => [
  ...([1, 2, 3, 4, 5] as const).flatMap((d) => [
    slot(d, '09:00', '14:00'),
    slot(d, '16:00', '20:00'),
  ]),
  slot(6, '10:00', '14:00'),
];

export const configuredHandoff = (): KnowledgeState['handoff'] => ({
  channels: [{ id: nextId(), type: 'whatsapp', value: '+34611222333', sortOrder: 0 }],
  hours: [],
  updatedAt: T,
});

/** Destinos de avisos de derivación con las dos vías disponibles (005): sin avisos de vías. */
export const bothAlertRoutes = (): KnowledgeState['handoffAlerts'] => ({
  whatsapp: '+34611000111',
  email: 'avisos@ejemplo.com',
  routes: { whatsapp: true, email: true },
});
