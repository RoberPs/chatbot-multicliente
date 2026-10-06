/**
 * Esquema de la base de datos de una instancia (data-model.md).
 * Una BD por instancia: ninguna tabla lleva identificador de cliente.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  check,
  customType,
  date,
  index,
  integer,
  jsonb,
  type AnyPgColumn,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  time,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const businessStatus = pgEnum('business_status', ['draft', 'active']);
export const priceType = pgEnum('price_type', ['fixed', 'from', 'on_request']);
export const addressForm = pgEnum('address_form', ['informal', 'formal']);
export const handoffChannelType = pgEnum('handoff_channel_type', ['phone', 'whatsapp', 'email']);

/** `updated_at` con reloj real (no el inicio de la transacción) y en texto para no perder microsegundos. */
const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true, mode: 'string' })
    .notNull()
    .default(sql`clock_timestamp()`);

const localTime = (name: string) => time(name, { precision: 0 });
const isoDate = (name: string) => date(name, { mode: 'string' });

export const business = pgTable(
  'business',
  {
    id: smallint('id').primaryKey().default(1),
    name: text('name').notNull().default(''),
    address: text('address'),
    directions: text('directions'),
    mapUrl: text('map_url'),
    phone: text('phone'),
    email: text('email'),
    timezone: text('timezone').notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    status: businessStatus('status').notNull().default('draft'),
    updatedAt: updatedAt(),
  },
  (t) => [check('business_singleton', sql`${t.id} = 1`)],
);

export const businessHours = pgTable(
  'business_hours',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    weekday: smallint('weekday').notNull(),
    startTime: localTime('start_time').notNull(),
    endTime: localTime('end_time').notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('business_hours_weekday', sql`${t.weekday} between 1 and 7`),
    check('business_hours_range', sql`${t.endTime} > ${t.startTime}`),
  ],
);

export const closure = pgTable(
  'closure',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    startDate: isoDate('start_date').notNull(),
    endDate: isoDate('end_date').notNull(),
    startTime: localTime('start_time'),
    endTime: localTime('end_time'),
    reason: text('reason'),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('closure_dates', sql`${t.endDate} >= ${t.startDate}`),
    check('closure_both_times', sql`(${t.startTime} is null) = (${t.endTime} is null)`),
    check('closure_times', sql`${t.startTime} is null or ${t.endTime} > ${t.startTime}`),
  ],
);

export const service = pgTable(
  'service',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    description: text('description'),
    priceType: priceType('price_type').notNull(),
    priceCents: integer('price_cents'),
    durationMinutes: integer('duration_minutes'),
    bookable: boolean('bookable').notNull().default(false),
    active: boolean('active').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('service_name_lower_idx').on(sql`lower(${t.name})`),
    check('service_price', sql`${t.priceCents} is null or ${t.priceCents} >= 0`),
    check(
      'service_duration',
      sql`${t.durationMinutes} is null or ${t.durationMinutes} between 1 and 1440`,
    ),
  ],
);

export const resource = pgTable(
  'resource',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    active: boolean('active').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('resource_name_lower_idx').on(sql`lower(${t.name})`)],
);

/** Asociación recurso ↔ servicio. Sin precio ni duración propios (FR-011a). */
export const resourceService = pgTable(
  'resource_service',
  {
    resourceId: uuid('resource_id')
      .notNull()
      .references(() => resource.id, { onDelete: 'cascade' }),
    serviceId: uuid('service_id')
      .notNull()
      .references(() => service.id, { onDelete: 'cascade' }),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.resourceId, t.serviceId] })],
);

export const resourceHours = pgTable(
  'resource_hours',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    resourceId: uuid('resource_id')
      .notNull()
      .references(() => resource.id, { onDelete: 'cascade' }),
    weekday: smallint('weekday').notNull(),
    startTime: localTime('start_time').notNull(),
    endTime: localTime('end_time').notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('resource_hours_weekday', sql`${t.weekday} between 1 and 7`),
    check('resource_hours_range', sql`${t.endTime} > ${t.startTime}`),
  ],
);

export const resourceAbsence = pgTable(
  'resource_absence',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    resourceId: uuid('resource_id')
      .notNull()
      .references(() => resource.id, { onDelete: 'cascade' }),
    startDate: isoDate('start_date').notNull(),
    endDate: isoDate('end_date').notNull(),
    startTime: localTime('start_time'),
    endTime: localTime('end_time'),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('resource_absence_dates', sql`${t.endDate} >= ${t.startDate}`),
    check('resource_absence_both_times', sql`(${t.startTime} is null) = (${t.endTime} is null)`),
    check('resource_absence_times', sql`${t.startTime} is null or ${t.endTime} > ${t.startTime}`),
  ],
);

export const faq = pgTable('faq', {
  id: uuid('id').primaryKey().defaultRandom(),
  question: text('question').notNull(),
  answer: text('answer').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  updatedAt: updatedAt(),
});

export const policies = pgTable(
  'policies',
  {
    id: smallint('id').primaryKey().default(1),
    cancellationText: text('cancellation_text'),
    cancellationNoticeMinutes: integer('cancellation_notice_minutes'),
    minAdvanceMinutes: integer('min_advance_minutes'),
    maxAdvanceMinutes: integer('max_advance_minutes'),
    paymentMethods: text('payment_methods')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('policies_singleton', sql`${t.id} = 1`),
    check(
      'policies_notice',
      sql`${t.cancellationNoticeMinutes} is null or ${t.cancellationNoticeMinutes} >= 0`,
    ),
    check('policies_min', sql`${t.minAdvanceMinutes} is null or ${t.minAdvanceMinutes} >= 0`),
    check('policies_max', sql`${t.maxAdvanceMinutes} is null or ${t.maxAdvanceMinutes} > 0`),
    check(
      'policies_min_max',
      sql`${t.minAdvanceMinutes} is null or ${t.maxAdvanceMinutes} is null or ${t.minAdvanceMinutes} <= ${t.maxAdvanceMinutes}`,
    ),
  ],
);

export const tone = pgTable(
  'tone',
  {
    id: smallint('id').primaryKey().default(1),
    addressForm: addressForm('address_form').notNull(),
    styleDescription: text('style_description'),
    updatedAt: updatedAt(),
  },
  (t) => [check('tone_singleton', sql`${t.id} = 1`)],
);

export const handoffContact = pgTable(
  'handoff_contact',
  {
    id: smallint('id').primaryKey().default(1),
    updatedAt: updatedAt(),
  },
  (t) => [check('handoff_contact_singleton', sql`${t.id} = 1`)],
);

export const handoffChannel = pgTable(
  'handoff_channel',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    contactId: smallint('contact_id')
      .notNull()
      .default(1)
      .references(() => handoffContact.id, { onDelete: 'cascade' }),
    type: handoffChannelType('type').notNull(),
    value: text('value').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [unique('handoff_channel_type_value_unique').on(t.type, t.value)],
);

export const handoffHours = pgTable(
  'handoff_hours',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    contactId: smallint('contact_id')
      .notNull()
      .default(1)
      .references(() => handoffContact.id, { onDelete: 'cascade' }),
    weekday: smallint('weekday').notNull(),
    startTime: localTime('start_time').notNull(),
    endTime: localTime('end_time').notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('handoff_hours_weekday', sql`${t.weekday} between 1 and 7`),
    check('handoff_hours_range', sql`${t.endTime} > ${t.startTime}`),
  ],
);

// ---------------------------------------------------------------------------
// Conversaciones del bot (feature 002, data-model.md). Marcas de tiempo como instantes.
// ---------------------------------------------------------------------------

export const messageDirection = pgEnum('message_direction', ['inbound', 'outbound']);
export const messageKind = pgEnum('message_kind', ['text', 'audio', 'other']);
export const messageStatus = pgEnum('message_status', [
  'pending',
  'answered',
  'discarded',
  'rate_limited',
  'sending',
  'sent',
  'failed',
  'forwarded',
  // 012 (R7.4): entrante pendiente que no se reenvió porque la derivación terminó antes.
  'held',
]);
export const transcriptionStatus = pgEnum('transcription_status', ['pending', 'done', 'failed']);

/** `bytea` de PostgreSQL como `Buffer` (drizzle no lo trae de serie). */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

const instant = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const customerChannel = pgEnum('customer_channel', ['whatsapp', 'web', 'playground']);

/**
 * Cliente final de cualquier canal (004, FR-001): solo su identificador en el canal
 * (WhatsApp: E.164; web: SHA-256 de la sesión; playground: UUID).
 */
export const customer = pgTable(
  'customer',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    channel: customerChannel('channel').notNull(),
    channelUserId: text('channel_user_id').notNull(),
    rateLimitNotifiedAt: instant('rate_limit_notified_at'),
    createdAt: instant('created_at').notNull().defaultNow(),
  },
  (t) => [unique('customer_channel_user_unique').on(t.channel, t.channelUserId)],
);

export const conversation = pgTable(
  'conversation',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customer.id, { onDelete: 'cascade' }),
    startedAt: instant('started_at').notNull(),
    lastInboundAt: instant('last_inbound_at').notNull(),
    lastMessageAt: instant('last_message_at').notNull(),
    greeted: boolean('greeted').notNull().default(false),
    /** Nombre del cliente para la derivación (005): perfil de WhatsApp o el que dio. ≤ 80 car. */
    contactName: text('contact_name'),
    /** Teléfono del cliente para la derivación (005), en E.164. */
    contactPhone: text('contact_phone'),
    /** Paso previo a la derivación (005, R2): `offered` o `collecting`; ver `handoffStepSchema`. */
    handoffStep: jsonb('handoff_step'),
    /** Intentos fallidos seguidos del lote de pendientes (012, R10). */
    batchAttempts: smallint('batch_attempts').notNull().default(0),
    /** El procesador no la reclama antes de este instante (reintento o reenvío agrupado, R7, R10). */
    processAfter: instant('process_after'),
  },
  (t) => [
    index('conversation_customer_last_inbound_idx').on(t.customerId, t.lastInboundAt.desc()),
    index('conversation_last_message_idx').on(t.lastMessageAt),
    check('conversation_batch_attempts', sql`${t.batchAttempts} between 0 and 5`),
  ],
);

export const message = pgTable(
  'message',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversation.id, { onDelete: 'cascade' }),
    direction: messageDirection('direction').notNull(),
    kind: messageKind('kind').notNull(),
    channelMessageId: text('channel_message_id').unique(),
    body: text('body'),
    otherType: text('other_type'),
    sentAt: instant('sent_at').notNull(),
    receivedAt: instant('received_at').notNull(),
    status: messageStatus('status').notNull(),
    transcription: transcriptionStatus('transcription'),
    replyId: uuid('reply_id').references((): AnyPgColumn => message.id, { onDelete: 'set null' }),
    /** Solo en salientes: cómo se compuso la respuesta (004, R7). Sin textos ni datos personales. */
    replyTrace: jsonb('reply_trace'),
  },
  (t) => [
    index('message_conversation_sent_idx').on(t.conversationId, t.sentAt),
    index('message_pending_idx')
      .on(t.conversationId)
      .where(sql`${t.direction} = 'inbound' and ${t.status} = 'pending'`),
  ],
);

/** Configuración del chat web (004, R8): una sola fila, editable en el panel. */
export const webChatSettings = pgTable(
  'web_chat_settings',
  {
    id: smallint('id').primaryKey().default(1),
    enabled: boolean('enabled').notNull().default(false),
    allowedOrigins: text('allowed_origins')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    privacyUrl: text('privacy_url'),
    dailyCap: integer('daily_cap').notNull().default(200),
    monthlyCap: integer('monthly_cap').notNull().default(3000),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('web_chat_settings_singleton', sql`${t.id} = 1`),
    check('web_chat_settings_daily_cap', sql`${t.dailyCap} >= 1`),
    check('web_chat_settings_monthly_cap', sql`${t.monthlyCap} >= ${t.dailyCap}`),
  ],
);

/**
 * Diseño del chat web (011, data-model §1): una sola fila; si no existe, el chat tiene el
 * aspecto original. Las opciones son `text` sin enums ni `CHECK` de valores: se validan al
 * escribir y se leen con tolerancia, campo a campo (R1, R13).
 */
export const chatDesign = pgTable(
  'chat_design',
  {
    id: smallint('id').primaryKey().default(1),
    primaryColor: text('primary_color').notNull(),
    onPrimaryColor: text('on_primary_color').notNull(),
    backgroundColor: text('background_color').notNull(),
    textColor: text('text_color').notNull(),
    botBubbleColor: text('bot_bubble_color').notNull(),
    shape: text('shape').notNull(),
    position: text('position').notNull(),
    size: text('size').notNull(),
    /** Nulo = "Asistente de" + nombre del negocio. */
    chatName: text('chat_name'),
    /** Nulo = sin bienvenida. */
    welcomeText: text('welcome_text'),
    /** Nulo = "Escribe tu mensaje". */
    placeholderText: text('placeholder_text'),
    /** Nulo = "Enviar". */
    sendLabel: text('send_label'),
    updatedAt: updatedAt(),
  },
  (t) => [check('chat_design_singleton', sql`${t.id} = 1`)],
);

/** Imágenes del diseño (011, R7): una fila por hueco ocupado, ya sin metadatos. */
export const chatDesignImage = pgTable(
  'chat_design_image',
  {
    slot: text('slot').primaryKey(),
    designId: smallint('design_id')
      .notNull()
      .references(() => chatDesign.id, { onDelete: 'cascade' }),
    /** Tipo detectado por el contenido, no el declarado. */
    mimeType: text('mime_type').notNull(),
    bytes: bytea('bytes').notNull(),
    /** SHA-256 en hexadecimal de `bytes` (URL de la imagen y comparación). */
    sha256: text('sha256').notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    byteSize: integer('byte_size').notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('chat_design_image_byte_size', sql`${t.byteSize} between 1 and 262144`),
    check(
      'chat_design_image_dimensions',
      sql`${t.width} between 16 and 1024 and ${t.height} between 16 and 1024`,
    ),
  ],
);

/** Respuestas del canal web por día en la zona horaria del negocio (004, R9). */
export const webUsageDay = pgTable('web_usage_day', {
  day: isoDate('day').primaryKey(),
  replies: integer('replies').notNull().default(0),
});

// ---------------------------------------------------------------------------
// Derivación de la conversación al negocio (feature 005, data-model.md).
// ---------------------------------------------------------------------------

export const handoffKind = pgEnum('handoff_kind', ['person', 'unresolved', 'complaint']);
export const handoffStatus = pgEnum('handoff_status', ['active', 'ended']);
export const handoffSummarySource = pgEnum('handoff_summary_source', ['model', 'fallback']);
export const handoffActionVia = pgEnum('handoff_action_via', ['whatsapp', 'email']);
export const handoffEndCause = pgEnum('handoff_end_cause', [
  'business',
  'inactivity',
  'operator',
  'playground',
  // 012 (R10.4): un reintento no sabe si la alerta de inicio llegó al negocio.
  'interrupted',
]);
export const handoffNoticeType = pgEnum('handoff_notice_type', ['alert', 'reminder', 'forward']);
export const handoffRoute = pgEnum('handoff_route', ['whatsapp', 'email', 'simulated']);
export const handoffNoticeStatus = pgEnum('handoff_notice_status', ['sent', 'failed']);

/** Derivación de una conversación al negocio. Como mucho una activa por conversación. */
export const handoff = pgTable(
  'handoff',
  {
    id: uuid('id').primaryKey(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversation.id, { onDelete: 'cascade' }),
    kind: handoffKind('kind').notNull(),
    status: handoffStatus('status').notNull(),
    summary: text('summary').notNull(),
    summarySource: handoffSummarySource('summary_source').notNull(),
    /** `sha256(token)`; el token en claro solo existe en memoria y en los avisos (R9). */
    tokenHash: bytea('token_hash').notNull().unique(),
    /**
     * Token cifrado con AES-256-GCM y una clave derivada de SESSION_SECRET: los reenvíos y el
     * recordatorio llevan los mismos botones y enlaces que el aviso. Sin el secreto, una copia
     * de la BD no permite actuar (R9).
     */
    tokenEnc: bytea('token_enc').notNull(),
    startedAt: instant('started_at').notNull(),
    confirmedAt: instant('confirmed_at'),
    confirmedVia: handoffActionVia('confirmed_via'),
    reminderDueAt: instant('reminder_due_at'),
    reminderSentAt: instant('reminder_sent_at'),
    endedAt: instant('ended_at'),
    endCause: handoffEndCause('end_cause'),
    /** Alguna vía entregó la alerta de inicio (012, R10.4). */
    alertsSentAt: instant('alerts_sent_at'),
    /** La confirmación al cliente quedó guardada (012, R10.4). */
    customerNotifiedAt: instant('customer_notified_at'),
    /** Último aviso al negocio de esta derivación: alerta, reenvío o recordatorio (012, R7.2). */
    lastNoticeAt: instant('last_notice_at'),
  },
  (t) => [
    uniqueIndex('handoff_one_active_per_conversation')
      .on(t.conversationId)
      .where(sql`${t.status} = 'active'`),
    index('handoff_status_reminder_idx').on(t.status, t.reminderDueAt),
    check(
      'handoff_ended',
      sql`(${t.status} = 'ended') = (${t.endedAt} is not null and ${t.endCause} is not null)`,
    ),
    check('handoff_confirmed', sql`(${t.confirmedAt} is null) = (${t.confirmedVia} is null)`),
  ],
);

/** Cada mensaje al negocio de una derivación, por vía. */
export const handoffNotice = pgTable('handoff_notice', {
  id: uuid('id').primaryKey().defaultRandom(),
  handoffId: uuid('handoff_id')
    .notNull()
    .references(() => handoff.id, { onDelete: 'cascade' }),
  type: handoffNoticeType('type').notNull(),
  route: handoffRoute('route').notNull(),
  status: handoffNoticeStatus('status').notNull(),
  /** Código corto de fallo; nunca textos del cliente. */
  failure: text('failure'),
  /** `wamid` o `Message-ID` del email. */
  providerRef: text('provider_ref'),
  messagesCovered: smallint('messages_covered'),
  /** Solo con la vía simulada (playground): texto del aviso para el operador. */
  body: text('body'),
  createdAt: instant('created_at').notNull(),
});

/** Destinos de los avisos de derivación (R16): una sola fila, editable en el panel. */
export const handoffAlerts = pgTable(
  'handoff_alerts',
  {
    id: smallint('id').primaryKey().default(1),
    whatsappPhone: text('whatsapp_phone'),
    email: text('email'),
    updatedAt: updatedAt(),
  },
  (t) => [check('handoff_alerts_singleton', sql`${t.id} = 1`)],
);

/**
 * Configuración que tenía la instancia justo antes de la última importación aplicada (008,
 * FR-022): una sola fila con el fichero exportado tal cual (con destinos de avisos). No es
 * configuración del negocio: no entra en el snapshot, en los avisos ni en la exportación.
 */
export const configPreImport = pgTable(
  'config_pre_import',
  {
    id: smallint('id').primaryKey().default(1),
    content: text('content').notNull(),
    importedAt: instant('imported_at').notNull(),
    sourceInstance: text('source_instance'),
  },
  (t) => [check('config_pre_import_singleton', sql`${t.id} = 1`)],
);

// ---------------------------------------------------------------------------
// Consumo y coste del modelo (feature 010, data-model.md). No es configuración del negocio: no
// entra en el snapshot, en los avisos ni en la exportación de la 008 (R15).
// ---------------------------------------------------------------------------

export const usagePurpose = pgEnum('usage_purpose', [
  'reply',
  'handoff_summary',
  // 012 (R6): una transcripción de audio, valorada por minutos.
  'transcription',
]);

/**
 * Una fila por respuesta con modelo o por resumen de derivación (R2). Sin textos ni
 * identificadores de cliente, de conversación ni IP, y sin claves ajenas (FR-003). Nunca se
 * actualiza: el coste queda congelado al insertar (FR-011).
 */
export const modelUsage = pgTable(
  'model_usage',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    at: instant('at').notNull(),
    /** Día local del negocio en `at` (R6). */
    day: isoDate('day').notNull(),
    channel: customerChannel('channel').notNull(),
    purpose: usagePurpose('purpose').notNull(),
    model: text('model').notNull(),
    /** Llamadas al modelo que informaron tokens en esta respuesta (reintento del verificador). */
    calls: smallint('calls').notNull(),
    inputTokens: integer('input_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    cacheWriteTokens: integer('cache_write_tokens').notNull(),
    cacheReadTokens: integer('cache_read_tokens').notNull(),
    /** Billonésimas (10⁻¹²) de `currency`; nulo = sin precio al registrar (FR-012). */
    costPico: bigint('cost_pico', { mode: 'bigint' }),
    currency: char('currency', { length: 3 }),
    /** Duración del audio en ms; solo en `purpose = 'transcription'` (012, R6). */
    audioMs: integer('audio_ms'),
  },
  (t) => [
    index('model_usage_day_idx').on(t.day),
    check('model_usage_audio_ms', sql`${t.audioMs} is null or ${t.audioMs} >= 0`),
    check('model_usage_calls', sql`${t.calls} >= 1`),
    check(
      'model_usage_tokens',
      sql`${t.inputTokens} >= 0 and ${t.outputTokens} >= 0 and ${t.cacheWriteTokens} >= 0 and ${t.cacheReadTokens} >= 0`,
    ),
    check('model_usage_cost', sql`${t.costPico} is null or ${t.costPico} >= 0`),
    check('model_usage_cost_currency', sql`(${t.costPico} is null) = (${t.currency} is null)`),
  ],
);

/** Precio vigente por modelo, en millonésimas de la moneda por millón de tokens (R4). */
export const modelPrice = pgTable(
  'model_price',
  {
    model: text('model').primaryKey(),
    inputMicrosPerMtok: bigint('input_micros_per_mtok', { mode: 'bigint' }).notNull(),
    outputMicrosPerMtok: bigint('output_micros_per_mtok', { mode: 'bigint' }).notNull(),
    cacheWriteMicrosPerMtok: bigint('cache_write_micros_per_mtok', { mode: 'bigint' }).notNull(),
    cacheReadMicrosPerMtok: bigint('cache_read_micros_per_mtok', { mode: 'bigint' }).notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'model_price_non_negative',
      sql`${t.inputMicrosPerMtok} >= 0 and ${t.outputMicrosPerMtok} >= 0 and ${t.cacheWriteMicrosPerMtok} >= 0 and ${t.cacheReadMicrosPerMtok} >= 0`,
    ),
  ],
);

/** Ajustes de consumo de la instancia (R10, R13): una sola fila, editable en el panel. */
export const usageSettings = pgTable(
  'usage_settings',
  {
    id: smallint('id').primaryKey().default(1),
    currency: char('currency', { length: 3 }).notNull().default('USD'),
    capEnabled: boolean('cap_enabled').notNull().default(false),
    /** Céntimos; se conserva al desactivar el tope. */
    monthlyCapCents: integer('monthly_cap_cents'),
    /** Primer día del mes local en que ya se registró `spend_cap_reached` (R10). */
    capNotifiedMonth: isoDate('cap_notified_month'),
    updatedAt: updatedAt(),
    /** Respuestas de WhatsApp con modelo por día local (012, R5). Sin interruptor. */
    whatsappDailyCap: integer('whatsapp_daily_cap').notNull().default(200),
    /** Día local en que ya se registró `whatsapp_quota_reached` (012, R5). */
    whatsappCapNotifiedDay: isoDate('whatsapp_cap_notified_day'),
  },
  (t) => [
    check('usage_settings_singleton', sql`${t.id} = 1`),
    // `is not null` explícito: con un importe nulo, `null > 0` haría pasar el check.
    check(
      'usage_settings_cap',
      sql`not ${t.capEnabled} or (${t.monthlyCapCents} is not null and ${t.monthlyCapCents} > 0)`,
    ),
    check('usage_settings_whatsapp_cap', sql`${t.whatsappDailyCap} between 1 and 10000`),
  ],
);

// ---------------------------------------------------------------------------
// Protección frente a abuso (feature 012, data-model.md). No es configuración del negocio: no
// entra en el snapshot, en los avisos ni en la exportación de la 008 (FR-036).
// ---------------------------------------------------------------------------

/** Precio por minuto de audio de cada modelo de transcripción (R6), en la moneda del consumo. */
export const transcriptionPrice = pgTable(
  'transcription_price',
  {
    model: text('model').primaryKey(),
    /** Millonésimas de la moneda por minuto de audio. */
    microsPerMinute: bigint('micros_per_minute', { mode: 'bigint' }).notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [check('transcription_price_non_negative', sql`${t.microsPerMinute} >= 0`)],
);

/** Respuestas de WhatsApp que llamaron al modelo, por día local del negocio (R5). */
export const whatsappUsageDay = pgTable(
  'whatsapp_usage_day',
  {
    day: isoDate('day').primaryKey(),
    replies: integer('replies').notNull().default(0),
  },
  (t) => [check('whatsapp_usage_day_replies', sql`${t.replies} >= 0`)],
);

/** Límites de las derivaciones (R7): una sola fila, editable en «Consumo». */
export const handoffLimits = pgTable(
  'handoff_limits',
  {
    id: smallint('id').primaryKey().default(1),
    dailyMax: integer('daily_max').notNull().default(20),
    forwardIntervalMinutes: integer('forward_interval_minutes').notNull().default(15),
    noticesDailyMax: integer('notices_daily_max').notNull().default(60),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('handoff_limits_singleton', sql`${t.id} = 1`),
    check('handoff_limits_daily_max', sql`${t.dailyMax} between 1 and 200`),
    check('handoff_limits_interval', sql`${t.forwardIntervalMinutes} between 5 and 240`),
    check('handoff_limits_notices', sql`${t.noticesDailyMax} between 10 and 500`),
  ],
);

/** Contadores de las derivaciones por día local (R7): solo las reales, nunca las simuladas. */
export const handoffDay = pgTable(
  'handoff_day',
  {
    day: isoDate('day').primaryKey(),
    started: integer('started').notNull().default(0),
    refused: integer('refused').notNull().default(0),
    notices: integer('notices').notNull().default(0),
    noticesHeld: integer('notices_held').notNull().default(0),
    refusedLogged: boolean('refused_logged').notNull().default(false),
    heldLogged: boolean('held_logged').notNull().default(false),
  },
  (t) => [
    check(
      'handoff_day_counters',
      sql`${t.started} >= 0 and ${t.refused} >= 0 and ${t.notices} >= 0 and ${t.noticesHeld} >= 0`,
    ),
  ],
);

/** Tablas de conversaciones del bot (sin `updated_at`: no forman parte del snapshot). */
export const conversationTableNames = [
  'handoff_notice',
  'handoff',
  'message',
  'conversation',
  'customer',
  'web_usage_day',
  'whatsapp_usage_day',
  'handoff_day',
] as const;

/** Todas las tablas de la base de conocimiento, en orden seguro para TRUNCATE en tests. */
export const allTableNames = [
  'resource_service',
  'resource_hours',
  'resource_absence',
  'resource',
  'service',
  'business_hours',
  'closure',
  'faq',
  'policies',
  'tone',
  'handoff_channel',
  'handoff_hours',
  'handoff_contact',
  'business',
] as const;
