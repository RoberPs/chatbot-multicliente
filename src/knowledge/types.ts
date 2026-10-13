/** Tipos del dominio de la base de conocimiento (contracts/knowledge-reader.md y warnings.md). */

export type ISODate = string;
export type LocalTime = string;
export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface WeeklySlot {
  weekday: Weekday;
  start: LocalTime;
  end: LocalTime;
}

export interface DateRangeBlock {
  startDate: ISODate;
  endDate: ISODate;
  startTime: LocalTime | null;
  endTime: LocalTime | null;
  reason: string | null;
}

export type BusinessStatus = 'draft' | 'active';
export type PriceType = 'fixed' | 'from' | 'on_request';
export type AddressForm = 'informal' | 'formal';
export type HandoffChannelType = 'phone' | 'whatsapp' | 'email';

// ---------------------------------------------------------------------------
// Estado completo de la instancia (lo que hay en la BD), base de avisos y snapshot.
// ---------------------------------------------------------------------------

export interface BusinessRecord {
  name: string;
  address: string | null;
  directions: string | null;
  /** Enlace https a un mapa (003, FR-011). */
  mapUrl: string | null;
  phone: string | null;
  email: string | null;
  timezone: string;
  currency: string;
  status: BusinessStatus;
  updatedAt: string;
}

export interface ClosureRecord extends DateRangeBlock {
  id: string;
  updatedAt: string;
}

export interface ServiceRecord {
  id: string;
  name: string;
  description: string | null;
  priceType: PriceType;
  priceCents: number | null;
  durationMinutes: number | null;
  bookable: boolean;
  active: boolean;
  sortOrder: number;
  updatedAt: string;
}

export interface AbsenceRecord extends DateRangeBlock {
  id: string;
  updatedAt: string;
}

export interface ResourceRecord {
  id: string;
  name: string;
  active: boolean;
  sortOrder: number;
  updatedAt: string;
  serviceIds: string[];
  hours: WeeklySlot[];
  absences: AbsenceRecord[];
}

export interface FaqRecord {
  id: string;
  question: string;
  answer: string;
  sortOrder: number;
  updatedAt: string;
}

export interface PoliciesRecord {
  cancellationText: string | null;
  cancellationNoticeMinutes: number | null;
  minAdvanceMinutes: number | null;
  maxAdvanceMinutes: number | null;
  paymentMethods: string[];
  updatedAt: string;
}

export interface ToneRecord {
  addressForm: AddressForm;
  styleDescription: string | null;
  updatedAt: string;
}

export interface HandoffChannelRecord {
  id: string;
  type: HandoffChannelType;
  value: string;
  sortOrder: number;
}

export interface HandoffRecord {
  channels: HandoffChannelRecord[];
  hours: WeeklySlot[];
  updatedAt: string;
}

/** Vías de aviso de derivación que esta instancia puede usar (005, R16). */
export interface AlertRouteAvailability {
  /** Hay canal de WhatsApp configurado. */
  whatsapp: boolean;
  /** Hay `SMTP_URL`, `SMTP_FROM` y `PUBLIC_BASE_URL`. */
  email: boolean;
}

/**
 * Destinos de los avisos de derivación (005, R16) y vías de la instancia. Solo para los avisos
 * del panel: no entra en el `KnowledgeSnapshot`, el bot no debe conocerlos.
 */
export interface HandoffAlertsState {
  whatsapp: string | null;
  email: string | null;
  routes: AlertRouteAvailability;
}

export interface KnowledgeState {
  business: BusinessRecord;
  businessHours: WeeklySlot[];
  /** Última modificación del horario semanal; `null` si no hay franjas. */
  businessHoursUpdatedAt: string | null;
  closures: ClosureRecord[];
  services: ServiceRecord[];
  resources: ResourceRecord[];
  faqs: FaqRecord[];
  policies: PoliciesRecord | null;
  tone: ToneRecord | null;
  /** `null` si no hay contacto de derivación configurado. */
  handoff: HandoffRecord | null;
  /** Destinos de los avisos de derivación (005). */
  handoffAlerts: HandoffAlertsState;
  /** Máximo `updated_at` de todas las tablas, ISO 8601. */
  maxUpdatedAt: string;
}

// ---------------------------------------------------------------------------
// Vista del bot (contracts/knowledge-reader.md).
// ---------------------------------------------------------------------------

export type SnapshotPrice =
  | { type: 'fixed'; amountCents: number }
  | { type: 'from'; amountCents: number }
  | { type: 'on_request' }
  | { type: 'missing' };

export interface SnapshotService {
  id: string;
  name: string;
  description: string | null;
  price: SnapshotPrice;
  durationMinutes: number | null;
  bookable: boolean;
  resourceIds: string[];
}

export interface SnapshotResource {
  id: string;
  name: string;
  serviceIds: string[];
  hours: WeeklySlot[];
  absences: DateRangeBlock[];
}

export type SnapshotScheduling =
  { mode: 'single_agenda' } | { mode: 'resources'; resources: SnapshotResource[] };

export interface HandoffChannel {
  type: HandoffChannelType;
  value: string;
}

export interface EffectiveHandoff {
  source: 'configured' | 'business_phone' | 'none';
  channels: HandoffChannel[];
  hours: WeeklySlot[];
}

/**
 * Cambio del contacto que usa el bot tras un guardado de Datos o Derivación (003, FR-006).
 * Derivado: se calcula dentro de la transacción del guardado y no se guarda.
 */
export interface HandoffChange {
  before: EffectiveHandoff;
  after: EffectiveHandoff;
  /** El guardado modificó el teléfono del negocio o los medios guardados (FR-006 b). */
  touched: boolean;
  /** Estado del negocio después del guardado. */
  status: BusinessStatus;
}

export interface KnowledgeSnapshot {
  status: BusinessStatus;
  business: {
    name: string;
    address: string | null;
    directions: string | null;
    /** Enlace https a un mapa; `null` si no hay (003, FR-014). */
    mapUrl: string | null;
    phone: string | null;
    email: string | null;
    timezone: string;
    currency: string;
  };
  openingHours: WeeklySlot[];
  closures: DateRangeBlock[];
  services: SnapshotService[];
  scheduling: SnapshotScheduling;
  faqs: Array<{ question: string; answer: string }>;
  policies: {
    cancellationText: string | null;
    cancellationNoticeMinutes: number | null;
    minAdvanceMinutes: number | null;
    maxAdvanceMinutes: number | null;
    paymentMethods: string[];
  };
  tone: {
    addressForm: AddressForm | null;
    styleDescription: string | null;
  };
  handoff: EffectiveHandoff;
  updatedAt: string;
}

export interface KnowledgeReader {
  /** Lee de la BD en cada llamada; sin caché (FR-021). */
  getSnapshot(): Promise<KnowledgeSnapshot>;
}

// ---------------------------------------------------------------------------
// Avisos (contracts/warnings.md).
// ---------------------------------------------------------------------------

export type WarningSeverity = 'normal' | 'critical';

export type WarningCode =
  | 'HANDOFF_ALERTS_NONE'
  | 'HANDOFF_ALERTS_SINGLE'
  | 'SERVICE_DURATION_MISSING'
  | 'BUSINESS_HOURS_MISSING'
  | 'SERVICE_PRICE_MISSING'
  | 'SERVICE_WITHOUT_RESOURCE'
  | 'RESOURCE_HOURS_OUTSIDE_BUSINESS'
  | 'HANDOFF_CONTACT_MISSING'
  | 'HANDOFF_UNREACHABLE'
  // Avisos de protección (012, R3): los calcula `protectionWarnings`, nunca `computeWarnings`.
  | 'SPEND_CAP_REQUIRED'
  | 'MODEL_UNPRICED'
  | 'STT_MODEL_UNPRICED'
  | 'SPEND_UNREADABLE'
  | 'BUSINESS_NOTICES_HELD'
  // 017 (FR-005b): el proveedor rechaza la credencial del modelo.
  | 'LLM_KEY_REJECTED';

/** `instance`: avisos de la instancia, no de la configuración del negocio (012). */
export type WarningTargetKind =
  'business' | 'service' | 'resource' | 'handoff' | 'handoff_alerts' | 'instance';

export interface Warning {
  code: WarningCode;
  severity: WarningSeverity;
  target: { kind: WarningTargetKind; id?: string; label: string };
  field?: string;
  message: string;
  details?: Record<string, unknown>;
}
