import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { allTableNames } from '../db/schema.js';
import { toIsoTimestamp } from '../db/timestamps.js';
import type {
  AddressForm,
  BusinessStatus,
  HandoffChannelType,
  KnowledgeState,
  PriceType,
  WeeklySlot,
  Weekday,
} from './types.js';

// Filas tal como las devuelve `row_to_json` (nombres de columna de la BD).
interface SlotRow {
  weekday: number;
  start_time: string;
  end_time: string;
  updated_at: string;
}
interface BlockRow {
  id: string;
  start_date: string;
  end_date: string;
  start_time: string | null;
  end_time: string | null;
  updated_at: string;
}
interface RawState {
  business: {
    name: string;
    address: string | null;
    directions: string | null;
    map_url: string | null;
    phone: string | null;
    email: string | null;
    timezone: string;
    currency: string;
    status: BusinessStatus;
    updated_at: string;
  } | null;
  business_hours: SlotRow[];
  closures: Array<BlockRow & { reason: string | null }>;
  services: Array<{
    id: string;
    name: string;
    description: string | null;
    price_type: PriceType;
    price_cents: number | null;
    duration_minutes: number | null;
    bookable: boolean;
    active: boolean;
    sort_order: number;
    updated_at: string;
  }>;
  resources: Array<{
    id: string;
    name: string;
    active: boolean;
    sort_order: number;
    updated_at: string;
  }>;
  resource_services: Array<{ resource_id: string; service_id: string }>;
  resource_hours: Array<SlotRow & { resource_id: string }>;
  resource_absences: Array<BlockRow & { resource_id: string }>;
  faqs: Array<{
    id: string;
    question: string;
    answer: string;
    sort_order: number;
    updated_at: string;
  }>;
  policies: {
    cancellation_text: string | null;
    cancellation_notice_minutes: number | null;
    min_advance_minutes: number | null;
    max_advance_minutes: number | null;
    payment_methods: string[];
    updated_at: string;
  } | null;
  tone: { address_form: AddressForm; style_description: string | null; updated_at: string } | null;
  handoff_contact: { updated_at: string } | null;
  handoff_channels: Array<{
    id: string;
    type: HandoffChannelType;
    value: string;
    sort_order: number;
  }>;
  handoff_hours: SlotRow[];
  max_updated_at: string | null;
}

const hhmm = (value: string): string => value.slice(0, 5);
const hhmmOrNull = (value: string | null): string | null => (value === null ? null : hhmm(value));

const toSlot = (row: SlotRow): WeeklySlot => ({
  weekday: row.weekday as Weekday,
  start: hhmm(row.start_time),
  end: hhmm(row.end_time),
});

const toBlock = (row: BlockRow) => ({
  id: row.id,
  startDate: row.start_date,
  endDate: row.end_date,
  startTime: hhmmOrNull(row.start_time),
  endTime: hhmmOrNull(row.end_time),
  updatedAt: toIsoTimestamp(row.updated_at),
});

const list = (query: ReturnType<typeof sql>) => sql`coalesce((${query}), '[]'::json)`;

/**
 * Toda la instancia en una sola consulta (un único viaje a la BD): así la lectura del bot
 * y el guardado protegido no dependen de la latencia de red multiplicada por cada tabla.
 */
function stateQuery() {
  const maxParts = sql.join(
    allTableNames.map((table) => sql`select max(updated_at) as u from ${sql.identifier(table)}`),
    sql` union all `,
  );
  return sql`select json_build_object(
    'business', (select row_to_json(b) from business b limit 1),
    'business_hours', ${list(sql`select json_agg(h order by h.weekday, h.start_time) from business_hours h`)},
    'closures', ${list(sql`select json_agg(c order by c.start_date, c.start_time) from closure c`)},
    'services', ${list(sql`select json_agg(s order by s.sort_order, s.name) from service s`)},
    'resources', ${list(sql`select json_agg(r order by r.sort_order, r.name) from resource r`)},
    'resource_services', ${list(sql`select json_agg(rs) from resource_service rs`)},
    'resource_hours', ${list(sql`select json_agg(h order by h.weekday, h.start_time) from resource_hours h`)},
    'resource_absences', ${list(sql`select json_agg(a order by a.start_date, a.start_time) from resource_absence a`)},
    'faqs', ${list(sql`select json_agg(f order by f.sort_order, f.question) from faq f`)},
    'policies', (select row_to_json(p) from policies p limit 1),
    'tone', (select row_to_json(t) from tone t limit 1),
    'handoff_contact', (select row_to_json(hc) from handoff_contact hc limit 1),
    'handoff_channels', ${list(sql`select json_agg(ch order by ch.sort_order) from handoff_channel ch`)},
    'handoff_hours', ${list(sql`select json_agg(h order by h.weekday, h.start_time) from handoff_hours h`)},
    'max_updated_at', (select to_char(max(u) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') from (${maxParts}) m)
  ) as state`;
}

/**
 * Carga el estado completo de la instancia dentro de la transacción recibida.
 * Es la base de `computeWarnings` y de `buildSnapshot`.
 */
export async function loadKnowledgeState(tx: Tx): Promise<KnowledgeState> {
  const result = await tx.execute<{ state: RawState }>(stateQuery());
  const raw = result.rows[0]?.state;
  if (!raw?.business) {
    throw new Error('La instancia no tiene negocio: ejecuta las migraciones (pnpm db:migrate)');
  }

  const serviceOrder = new Map(raw.services.map((s, i) => [s.id, i]));
  const latest = (values: string[]) => values.map(toIsoTimestamp).sort().at(-1) ?? null;

  return {
    business: {
      name: raw.business.name,
      address: raw.business.address,
      directions: raw.business.directions,
      mapUrl: raw.business.map_url,
      phone: raw.business.phone,
      email: raw.business.email,
      timezone: raw.business.timezone,
      currency: raw.business.currency,
      status: raw.business.status,
      updatedAt: toIsoTimestamp(raw.business.updated_at),
    },
    businessHours: raw.business_hours.map(toSlot),
    businessHoursUpdatedAt: latest(raw.business_hours.map((h) => h.updated_at)),
    closures: raw.closures.map((c) => ({ ...toBlock(c), reason: c.reason })),
    services: raw.services.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      priceType: s.price_type,
      priceCents: s.price_cents,
      durationMinutes: s.duration_minutes,
      bookable: s.bookable,
      active: s.active,
      sortOrder: s.sort_order,
      updatedAt: toIsoTimestamp(s.updated_at),
    })),
    resources: raw.resources.map((r) => ({
      id: r.id,
      name: r.name,
      active: r.active,
      sortOrder: r.sort_order,
      updatedAt: toIsoTimestamp(r.updated_at),
      serviceIds: raw.resource_services
        .filter((l) => l.resource_id === r.id)
        .map((l) => l.service_id)
        .sort((a, b) => (serviceOrder.get(a) ?? 0) - (serviceOrder.get(b) ?? 0)),
      hours: raw.resource_hours.filter((h) => h.resource_id === r.id).map(toSlot),
      absences: raw.resource_absences
        .filter((a) => a.resource_id === r.id)
        .map((a) => ({ ...toBlock(a), reason: null })),
    })),
    faqs: raw.faqs.map((f) => ({
      id: f.id,
      question: f.question,
      answer: f.answer,
      sortOrder: f.sort_order,
      updatedAt: toIsoTimestamp(f.updated_at),
    })),
    policies: raw.policies
      ? {
          cancellationText: raw.policies.cancellation_text,
          cancellationNoticeMinutes: raw.policies.cancellation_notice_minutes,
          minAdvanceMinutes: raw.policies.min_advance_minutes,
          maxAdvanceMinutes: raw.policies.max_advance_minutes,
          paymentMethods: raw.policies.payment_methods,
          updatedAt: toIsoTimestamp(raw.policies.updated_at),
        }
      : null,
    tone: raw.tone
      ? {
          addressForm: raw.tone.address_form,
          styleDescription: raw.tone.style_description,
          updatedAt: toIsoTimestamp(raw.tone.updated_at),
        }
      : null,
    handoff: raw.handoff_contact
      ? {
          channels: raw.handoff_channels.map((c) => ({
            id: c.id,
            type: c.type,
            value: c.value,
            sortOrder: c.sort_order,
          })),
          hours: raw.handoff_hours.map(toSlot),
          updatedAt: toIsoTimestamp(raw.handoff_contact.updated_at),
        }
      : null,
    maxUpdatedAt: raw.max_updated_at ?? new Date(0).toISOString(),
  };
}
