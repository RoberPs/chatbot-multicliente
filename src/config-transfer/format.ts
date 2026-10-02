/**
 * Formato del fichero de configuración del negocio (008, contracts/config-file-format.md).
 *
 * El documento va en la forma del dominio (céntimos, minutos, `HH:MM`, días ISO, E.164) y sin
 * identificadores internos: los recursos citan sus servicios por nombre (research R1, R2).
 */
import type {
  AddressForm,
  BusinessStatus,
  HandoffChannelType,
  PriceType,
  WeeklySlot,
} from '../knowledge/types.js';

export const FORMAT_ID = 'business-config';

/**
 * Versión del formato que escribe y entiende este núcleo. Toda migración que añada o cambie
 * configuración del negocio la sube y añade su actualizador a `UPDATERS` (research R4).
 */
export const CURRENT_FORMAT_VERSION = 2;

/** Convierte un fichero de la versión N (ya analizado como JSON) a la N + 1. */
export type Updater = (raw: unknown) => unknown;

/**
 * `UPDATERS[n]` actualiza de la versión `n` a la `n + 1`.
 *
 * - 1 → 2 (011, diseño del chat): un fichero sin la sección es un negocio sin diseño, así que
 *   se importa como `chatDesign: null` (el destino vuelve al aspecto original, US5-4).
 */
export const UPDATERS: Readonly<Record<number, Updater>> = {
  1: (raw) =>
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? { ...raw, chatDesign: null }
      : raw,
};

export interface ConfigDateBlock {
  startDate: string;
  endDate: string;
  startTime: string | null;
  endTime: string | null;
}

export interface ConfigBusiness {
  name: string;
  address: string | null;
  directions: string | null;
  mapUrl: string | null;
  phone: string | null;
  email: string | null;
  timezone: string;
  currency: string;
}

export interface ConfigService {
  name: string;
  description: string | null;
  priceType: PriceType;
  priceCents: number | null;
  durationMinutes: number | null;
  bookable: boolean;
  active: boolean;
}

export interface ConfigResource {
  name: string;
  active: boolean;
  /** Nombres de los servicios que presta, en el orden de los servicios. */
  services: string[];
  hours: WeeklySlot[];
  absences: ConfigDateBlock[];
}

export interface ConfigPolicies {
  cancellationText: string | null;
  cancellationNoticeMinutes: number | null;
  minAdvanceMinutes: number | null;
  maxAdvanceMinutes: number | null;
  paymentMethods: string[];
}

export interface ConfigHandoff {
  channels: Array<{ type: HandoffChannelType; value: string }>;
  hours: WeeklySlot[];
}

export interface ConfigWebChat {
  allowedOrigins: string[];
  privacyUrl: string | null;
  dailyCap: number;
  monthlyCap: number;
}

/** Imagen del diseño en el fichero: tipo y bytes ya normalizados en base64 (011). */
export interface ConfigChatImage {
  type: 'image/png' | 'image/jpeg' | 'image/webp';
  data: string;
}

/** Diseño del chat web (011, contracts/config-file-chat-design.md). */
export interface ConfigChatDesign {
  primaryColor: string;
  onPrimaryColor: string;
  backgroundColor: string;
  textColor: string;
  botBubbleColor: string;
  shape: 'square' | 'soft' | 'round';
  position: 'right' | 'left';
  size: 'small' | 'medium' | 'large';
  chatName: string | null;
  welcomeText: string | null;
  placeholder: string | null;
  sendLabel: string | null;
  images: {
    logo: ConfigChatImage | null;
    avatar: ConfigChatImage | null;
    icon: ConfigChatImage | null;
  };
}

export interface ConfigAlertDestinations {
  whatsapp: string | null;
  email: string | null;
}

/** Toda la configuración del negocio (data-model §1). */
export interface ConfigDocument {
  business: ConfigBusiness;
  openingHours: WeeklySlot[];
  closures: Array<ConfigDateBlock & { reason: string | null }>;
  services: ConfigService[];
  resources: ConfigResource[];
  faqs: Array<{ question: string; answer: string }>;
  policies: ConfigPolicies | null;
  tone: { addressForm: AddressForm; styleDescription: string | null } | null;
  handoff: ConfigHandoff | null;
  webChat: ConfigWebChat;
  /** `null`: sin diseño, el chat tiene el aspecto original (011). */
  chatDesign: ConfigChatDesign | null;
  /** Solo si el fichero incluye los destinos de los avisos (FR-005). */
  alertDestinations?: ConfigAlertDestinations;
}

/** Estado informativo del origen: nunca se importa (FR-004, FR-017). */
export interface ConfigInfo {
  businessStatus: BusinessStatus;
  webChatEnabled: boolean;
}

/** Sobre del fichero (data-model §2). */
export interface ConfigFileEnvelope {
  format: typeof FORMAT_ID;
  formatVersion: number;
  exportedAt: string;
  source: { instanceId: string | null; schema: string };
  includesAlertDestinations: boolean;
  info: ConfigInfo;
}

/** Secciones del documento, en el orden del fichero. */
export const SECTION_KEYS = [
  'business',
  'openingHours',
  'closures',
  'services',
  'resources',
  'faqs',
  'policies',
  'tone',
  'handoff',
  'webChat',
  'chatDesign',
  'alertDestinations',
] as const;

export type SectionKey = (typeof SECTION_KEYS)[number];

/** Sección de un error: una del documento, o `file` para el fichero y su sobre. */
export type IssueSection = SectionKey | 'file';

export const SECTION_LABELS: Record<IssueSection, string> = {
  file: 'Fichero',
  business: 'Datos del negocio',
  openingHours: 'Horario',
  closures: 'Cierres',
  services: 'Servicios',
  resources: 'Recursos',
  faqs: 'Preguntas frecuentes',
  policies: 'Políticas',
  tone: 'Tono',
  handoff: 'Contacto de derivación',
  webChat: 'Chat web',
  chatDesign: 'Diseño del chat',
  alertDestinations: 'Destinos de los avisos de derivación',
};

export const isSectionKey = (value: unknown): value is SectionKey =>
  typeof value === 'string' && (SECTION_KEYS as readonly string[]).includes(value);

/** Rechazos del fichero antes de validar sus secciones (data-model §4). */
export type FileRejectReason =
  | 'too_large'
  | 'unreadable'
  | 'not_export'
  | 'future_version'
  | 'unsupported_version';

/** Error de un fichero que no se puede importar (data-model §4). */
export interface ImportIssue {
  section: IssueSection;
  sectionLabel: string;
  /** Nombre o pregunta del elemento entre « », `n.º N`, o `null` en el fichero y filas únicas. */
  item: string | null;
  field: string | null;
  message: string;
  /** Solo en los rechazos del fichero entero. */
  code?: FileRejectReason;
}

/** Campo que cambia en un elemento, con los valores ya formateados para la vista. */
export interface FieldChange {
  field: string;
  fieldLabel: string;
  before: string;
  after: string;
}

/** Cambios de una sección entre la configuración actual y la del fichero (data-model §6). */
export interface SectionDiff {
  section: SectionKey;
  sectionLabel: string;
  added: Array<{ label: string }>;
  modified: Array<{ label: string; fields: FieldChange[] }>;
  removed: Array<{ label: string }>;
  reordered: boolean;
}

/**
 * Normalización de nombres, preguntas y referencias recurso → servicio: sin espacios a los
 * lados, espacios internos colapsados y en minúsculas (data-model §1).
 */
export const normalizeKey = (text: string): string =>
  text.trim().replace(/\s+/g, ' ').toLocaleLowerCase('es');

/**
 * Columnas de las tablas de configuración que cubre el formato, con el campo del documento que
 * las lleva (research R4). Lo vigila `tests/unit/config-transfer/column-coverage.test.ts`: una
 * columna nueva que no esté aquí ni en `EXCLUDED_COLUMNS` hace fallar la suite.
 */
export const COLUMN_COVERAGE: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  business: {
    name: 'business.name',
    address: 'business.address',
    directions: 'business.directions',
    map_url: 'business.mapUrl',
    phone: 'business.phone',
    email: 'business.email',
    timezone: 'business.timezone',
    currency: 'business.currency',
  },
  business_hours: {
    weekday: 'openingHours[].weekday',
    start_time: 'openingHours[].start',
    end_time: 'openingHours[].end',
  },
  closure: {
    start_date: 'closures[].startDate',
    end_date: 'closures[].endDate',
    start_time: 'closures[].startTime',
    end_time: 'closures[].endTime',
    reason: 'closures[].reason',
  },
  service: {
    name: 'services[].name',
    description: 'services[].description',
    price_type: 'services[].priceType',
    price_cents: 'services[].priceCents',
    duration_minutes: 'services[].durationMinutes',
    bookable: 'services[].bookable',
    active: 'services[].active',
  },
  resource: { name: 'resources[].name', active: 'resources[].active' },
  resource_service: {
    resource_id: 'resources[].services',
    service_id: 'resources[].services[]',
  },
  resource_hours: {
    weekday: 'resources[].hours[].weekday',
    start_time: 'resources[].hours[].start',
    end_time: 'resources[].hours[].end',
  },
  resource_absence: {
    start_date: 'resources[].absences[].startDate',
    end_date: 'resources[].absences[].endDate',
    start_time: 'resources[].absences[].startTime',
    end_time: 'resources[].absences[].endTime',
  },
  faq: { question: 'faqs[].question', answer: 'faqs[].answer' },
  policies: {
    cancellation_text: 'policies.cancellationText',
    cancellation_notice_minutes: 'policies.cancellationNoticeMinutes',
    min_advance_minutes: 'policies.minAdvanceMinutes',
    max_advance_minutes: 'policies.maxAdvanceMinutes',
    payment_methods: 'policies.paymentMethods',
  },
  tone: { address_form: 'tone.addressForm', style_description: 'tone.styleDescription' },
  handoff_contact: {},
  handoff_channel: { type: 'handoff.channels[].type', value: 'handoff.channels[].value' },
  handoff_hours: {
    weekday: 'handoff.hours[].weekday',
    start_time: 'handoff.hours[].start',
    end_time: 'handoff.hours[].end',
  },
  web_chat_settings: {
    allowed_origins: 'webChat.allowedOrigins',
    privacy_url: 'webChat.privacyUrl',
    daily_cap: 'webChat.dailyCap',
    monthly_cap: 'webChat.monthlyCap',
  },
  handoff_alerts: {
    whatsapp_phone: 'alertDestinations.whatsapp',
    email: 'alertDestinations.email',
  },
  chat_design: {
    primary_color: 'chatDesign.primaryColor',
    on_primary_color: 'chatDesign.onPrimaryColor',
    background_color: 'chatDesign.backgroundColor',
    text_color: 'chatDesign.textColor',
    bot_bubble_color: 'chatDesign.botBubbleColor',
    shape: 'chatDesign.shape',
    position: 'chatDesign.position',
    size: 'chatDesign.size',
    chat_name: 'chatDesign.chatName',
    welcome_text: 'chatDesign.welcomeText',
    placeholder_text: 'chatDesign.placeholder',
    send_label: 'chatDesign.sendLabel',
  },
  chat_design_image: {
    slot: 'chatDesign.images.<slot>',
    mime_type: 'chatDesign.images.<slot>.type',
    bytes: 'chatDesign.images.<slot>.data',
  },
};

/**
 * Columnas de configuración que no viajan en el fichero: identificadores, claves ajenas, marcas
 * de tiempo, el orden (va implícito en las listas) y los estados que nunca se importan
 * (FR-004, FR-017).
 */
export const EXCLUDED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  business: ['id', 'status', 'updated_at'],
  business_hours: ['id', 'updated_at'],
  closure: ['id', 'updated_at'],
  service: ['id', 'sort_order', 'updated_at'],
  resource: ['id', 'sort_order', 'updated_at'],
  resource_service: ['updated_at'],
  resource_hours: ['id', 'resource_id', 'updated_at'],
  resource_absence: ['id', 'resource_id', 'updated_at'],
  faq: ['id', 'sort_order', 'updated_at'],
  policies: ['id', 'updated_at'],
  tone: ['id', 'updated_at'],
  handoff_contact: ['id', 'updated_at'],
  handoff_channel: ['id', 'contact_id', 'sort_order', 'updated_at'],
  handoff_hours: ['id', 'contact_id', 'updated_at'],
  web_chat_settings: ['id', 'enabled', 'updated_at'],
  handoff_alerts: ['id', 'updated_at'],
  // Huella, dimensiones y tamaño se derivan de los bytes (011).
  chat_design: ['id', 'updated_at'],
  chat_design_image: ['design_id', 'sha256', 'width', 'height', 'byte_size', 'updated_at'],
};
