/**
 * Ayudas de los tests de exportar e importar la configuración (008): el negocio completo de
 * `tests/fixtures/config/valid-full.json` registrado por el dominio, datos de clientes finales,
 * una huella de las tablas de configuración y documentos grandes para SC-007.
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { serializeConfigFile } from '../../src/config-transfer/canonical.js';
import { parseConfigFile } from '../../src/config-transfer/parse.js';
import {
  applyImport,
  previewImport,
  type ImportOptions,
  type ImportPreview,
  type ImportResult,
  type ImportSource,
} from '../../src/config-transfer/service.js';
import {
  CURRENT_FORMAT_VERSION,
  type ConfigDocument,
  type ConfigFileEnvelope,
} from '../../src/config-transfer/format.js';
import type { Db } from '../../src/db/client.js';
import {
  conversation,
  customer,
  handoff,
  handoffNotice,
  message,
  webUsageDay,
} from '../../src/db/schema.js';
import {
  createClosure,
  saveBusiness,
  saveBusinessHours,
} from '../../src/knowledge/services/business-info.js';
import { activateBusiness } from '../../src/knowledge/services/business-status.js';
import { createService } from '../../src/knowledge/services/catalog.js';
import type { KnowledgeDeps } from '../../src/knowledge/services/deps.js';
import { createFaq } from '../../src/knowledge/services/faqs.js';
import {
  createAbsence,
  createResource,
  saveResourceHours,
} from '../../src/knowledge/services/resources.js';
import { saveHandoff, savePolicies, saveTone } from '../../src/knowledge/services/settings.js';
import type { Weekday } from '../../src/knowledge/types.js';
import { saveWebChatSettings } from '../../src/webchat/settings.js';
import { resetDb, setHandoffAlerts } from './db.js';

const FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'config');

/** Fichero de `tests/fixtures/config/` tal cual, como lo subiría el operador. */
export const loadFixture = (name: string): Buffer => readFileSync(join(FIXTURES, name));

/** Fichero de ejemplo ya analizado (para cambiarlo en un test). */
export const fixtureJson = (name: string): Record<string, unknown> =>
  JSON.parse(loadFixture(name).toString('utf8')) as Record<string, unknown>;

export const FULL_ALERTS = { whatsapp: '+34600123456', email: 'avisos@example.com' };

/** Variables de una instancia con `INSTANCE_ID` (van juntas con las de las copias). */
export const instanceEnv = (id: string): Record<string, string> => ({
  INSTANCE_ID: id,
  BACKUP_DIR: join(FIXTURES, 'no-usada'),
  BACKUP_KEY: randomBytes(32).toString('hex'),
});

export interface SeedOptions {
  /** Estado del negocio tras registrarlo; por defecto activo, como `valid-full.json`. */
  status?: 'draft' | 'active';
  /** Chat web activado; por defecto sí, como `valid-full.json`. */
  webChatEnabled?: boolean;
  /** Destinos de los avisos de derivación. */
  alerts?: { whatsapp: string | null; email: string | null };
}

const slots = (list: Array<[number, string, string]>) =>
  list.map(([weekday, start, end]) => ({ weekday: String(weekday), start, end }));

/**
 * Vacía la BD y registra por los casos de uso del dominio el mismo negocio que
 * `valid-full.json` (sin destinos de avisos salvo `alerts`).
 */
export async function seedFullBusiness(deps: KnowledgeDeps, opts: SeedOptions = {}): Promise<void> {
  const { db } = deps;
  await resetDb(db);
  await saveBusiness(deps, {
    name: 'Negocio de ejemplo',
    address: 'Calle Mayor 1',
    directions: '',
    map_url: 'https://maps.example.com/abc',
    phone: '+34910123456',
    email: 'hola@example.com',
    timezone: 'Europe/Madrid',
    currency: 'EUR',
  });
  await saveBusinessHours(deps, {
    slots: slots([
      [1, '09:00', '14:00'],
      [1, '16:00', '20:00'],
      [2, '09:00', '14:00'],
      [6, '10:00', '14:00'],
    ]),
  });
  await createClosure(deps, {
    start_date: '2026-12-24',
    end_date: '2026-12-26',
    reason: 'Navidad',
  });
  await createClosure(deps, {
    start_date: '2026-11-02',
    end_date: '2026-11-02',
    start_time: '09:00',
    end_time: '12:00',
    reason: 'Formación',
  });
  const a = await createService(deps, {
    name: 'Servicio A',
    price_type: 'fixed',
    price: '25',
    duration: '30',
    bookable: 'on',
    active: 'on',
  });
  await createService(deps, {
    name: 'Servicio B',
    description: 'Descripción del servicio B',
    price_type: 'from',
    price: '40',
    duration: '60',
    active: 'on',
  });
  const r = await createResource(deps, { name: 'Recurso 1', service_ids: [a], active: 'on' });
  await saveResourceHours(deps, r, { slots: slots([[1, '09:00', '14:00']]) });
  await createAbsence(deps, r, { start_date: '2026-08-01', end_date: '2026-08-15' });
  await createFaq(deps, { question: '¿Hay aparcamiento?', answer: 'Sí, en la calle de atrás.' });
  await createFaq(deps, {
    question: '¿Se puede pagar con tarjeta?',
    answer: 'Sí, con cualquier tarjeta.',
  });
  await savePolicies(deps, {
    cancellation_text: 'Avisa con un día de antelación.',
    cancellation_notice: '1',
    cancellation_notice_unit: 'days',
    min_advance: '1',
    min_advance_unit: 'hours',
    max_advance: '30',
    max_advance_unit: 'days',
    payment_methods: ['Efectivo', 'Tarjeta'],
  });
  await saveTone(deps, { address_form: 'informal' });
  await saveHandoff(deps, {
    channels: [
      { type: 'phone', value: '+34910123456' },
      { type: 'email', value: 'atencion@example.com' },
    ],
    slots: slots([[1, '09:00', '14:00']]),
  });
  await saveWebChatSettings(db, {
    ...(opts.webChatEnabled === false ? {} : { enabled: 'on' }),
    allowed_origins: 'https://www.example.com',
    privacy_url: 'https://www.example.com/privacidad',
    daily_cap: '200',
    monthly_cap: '3000',
  });
  if (opts.alerts) await setHandoffAlerts(db, opts.alerts);
  if ((opts.status ?? 'active') === 'active') await activateBusiness(db);
}

/**
 * Clientes, conversaciones, mensajes, derivaciones, avisos enviados y uso del chat web de todos
 * los canales. Devuelve los valores que nunca deben aparecer en una exportación (SC-003).
 */
export async function seedCustomerData(db: Db): Promise<string[]> {
  const values = {
    whatsappUser: '+34699111222',
    webUser: 'c3'.repeat(32),
    playgroundUser: '6f1c2b0e-8d4a-4f5e-9b3c-2a1d0e9f8c7b',
    contactName: 'Persona Cliente Privada',
    contactPhone: '+34699333444',
    inbound: 'Mensaje privado del cliente con código 58213',
    outbound: 'Respuesta privada del bot con código 77104',
    summary: 'Resumen privado de la derivación 44190',
    notice: 'Aviso privado simulado 99312',
    wamid: 'wamid.PRIVADO123456',
    providerRef: 'ref-privada-445566',
    usage: '8765',
  };
  const now = new Date('2026-09-29T10:00:00.000Z');
  const channels = [
    ['whatsapp', values.whatsappUser],
    ['web', values.webUser],
    ['playground', values.playgroundUser],
  ] as const;
  for (const [i, [channel, user]] of channels.entries()) {
    const [c] = await db
      .insert(customer)
      .values({ channel, channelUserId: user })
      .returning({ id: customer.id });
    if (!c) throw new Error('no se creó el cliente');
    const [conv] = await db
      .insert(conversation)
      .values({
        customerId: c.id,
        startedAt: now,
        lastInboundAt: now,
        lastMessageAt: now,
        greeted: true,
        contactName: values.contactName,
        contactPhone: values.contactPhone,
      })
      .returning({ id: conversation.id });
    if (!conv) throw new Error('no se creó la conversación');
    await db.insert(message).values([
      {
        conversationId: conv.id,
        direction: 'inbound',
        kind: 'text',
        channelMessageId: `${values.wamid}-${i}`,
        body: values.inbound,
        sentAt: now,
        receivedAt: now,
        status: 'answered',
      },
      {
        conversationId: conv.id,
        direction: 'outbound',
        kind: 'text',
        body: values.outbound,
        sentAt: now,
        receivedAt: now,
        status: 'sent',
      },
    ]);
    const handoffId = crypto.randomUUID();
    await db.insert(handoff).values({
      id: handoffId,
      conversationId: conv.id,
      kind: 'person',
      status: 'active',
      summary: values.summary,
      summarySource: 'model',
      tokenHash: createHash('sha256').update(randomBytes(16)).digest(),
      tokenEnc: randomBytes(48),
      startedAt: now,
    });
    await db.insert(handoffNotice).values({
      handoffId,
      type: 'alert',
      route: 'simulated',
      status: 'sent',
      providerRef: values.providerRef,
      body: values.notice,
      createdAt: now,
    });
  }
  await db.insert(webUsageDay).values({ day: '2026-09-29', replies: Number(values.usage) });
  return Object.values(values);
}

/** Tablas de configuración, más las filas únicas del chat web, los avisos y la copia previa. */
const FINGERPRINT_TABLES = [
  'business',
  'business_hours',
  'closure',
  'service',
  'resource',
  'resource_service',
  'resource_hours',
  'resource_absence',
  'faq',
  'policies',
  'tone',
  'handoff_contact',
  'handoff_channel',
  'handoff_hours',
  'web_chat_settings',
  'handoff_alerts',
  'chat_design',
  'chat_design_image',
  'config_pre_import',
];

/**
 * Huella de todas las filas (con identificadores y `updated_at`) de las tablas de
 * configuración: cambia con cualquier escritura, aunque deje los mismos valores.
 */
export async function configTablesFingerprint(
  db: Db,
  opts: { exclude?: string[] } = {},
): Promise<string> {
  const hash = createHash('sha256');
  for (const table of FINGERPRINT_TABLES.filter((t) => !opts.exclude?.includes(t))) {
    const result = await db.execute<{ rows: string }>(
      sql`select coalesce(json_agg(t.r order by t.r), '[]')::text as rows
          from (select row_to_json(x)::text as r from ${sql.identifier(table)} x) t`,
    );
    hash.update(`${table}:${result.rows[0]?.rows ?? ''}\n`);
  }
  return hash.digest('hex');
}

/** Sobre de un fichero de prueba. */
export function envelopeFor(
  doc: ConfigDocument,
  over: Partial<ConfigFileEnvelope> = {},
): ConfigFileEnvelope {
  return {
    format: 'business-config',
    formatVersion: CURRENT_FORMAT_VERSION,
    exportedAt: '2026-09-30T10:15:00.000Z',
    source: { instanceId: 'demo-01', schema: '0005_config_transfer' },
    includesAlertDestinations: doc.alertDestinations !== undefined,
    info: { businessStatus: 'active', webChatEnabled: false },
    ...over,
  };
}

/** Fichero canónico de un documento, como lo subiría el operador. */
export const fileFromDocument = (
  doc: ConfigDocument,
  over: Partial<ConfigFileEnvelope> = {},
): Buffer => Buffer.from(serializeConfigFile(envelopeFor(doc, over), doc), 'utf8');

/** Diez franjas sin solapes: mañanas de lunes a domingo y tardes de lunes a miércoles. */
const TEN_SLOTS = [
  ...[1, 2, 3, 4, 5, 6, 7].map((d) => ({ weekday: d as Weekday, start: '09:00', end: '13:00' })),
  ...[1, 2, 3].map((d) => ({ weekday: d as Weekday, start: '15:00', end: '19:00' })),
].sort((a, b) => a.weekday - b.weekday || a.start.localeCompare(b.start));

/** Negocio grande para SC-007: recursos con ~10 franjas y ~20 servicios cada uno. */
export function buildLargeDocument(size: {
  services: number;
  resources: number;
  faqs: number;
}): ConfigDocument {
  const services = Array.from({ length: size.services }, (_, i) => ({
    name: `Servicio ${String(i + 1).padStart(3, '0')}`,
    description: `Descripción del servicio ${i + 1}`,
    priceType: 'fixed' as const,
    priceCents: 1000 + i,
    durationMinutes: 30,
    bookable: true,
    active: true,
  }));
  return {
    business: {
      name: 'Negocio grande de ejemplo',
      address: 'Calle Mayor 1',
      directions: null,
      mapUrl: null,
      phone: '+34910123456',
      email: 'hola@example.com',
      timezone: 'Europe/Madrid',
      currency: 'EUR',
    },
    openingHours: TEN_SLOTS,
    closures: [
      { startDate: '2026-12-24', endDate: '2026-12-26', startTime: null, endTime: null, reason: null },
    ],
    services,
    resources: Array.from({ length: size.resources }, (_, i) => ({
      name: `Recurso ${String(i + 1).padStart(2, '0')}`,
      active: true,
      services: Array.from(
        { length: Math.min(20, services.length) },
        (_, j) => services[(i * 4 + j) % services.length]?.name ?? '',
      ).filter((name, k, all) => all.indexOf(name) === k),
      hours: TEN_SLOTS,
      absences: [
        { startDate: '2026-08-01', endDate: '2026-08-15', startTime: null, endTime: null },
      ],
    })),
    faqs: Array.from({ length: size.faqs }, (_, i) => ({
      question: `¿Pregunta frecuente número ${i + 1}?`,
      answer: `Respuesta a la pregunta ${i + 1}.`,
    })),
    policies: {
      cancellationText: null,
      cancellationNoticeMinutes: 1440,
      minAdvanceMinutes: 60,
      maxAdvanceMinutes: 43200,
      paymentMethods: ['Efectivo'],
    },
    tone: { addressForm: 'formal', styleDescription: null },
    handoff: { channels: [{ type: 'phone', value: '+34910123456' }], hours: [] },
    webChat: { allowedOrigins: [], privacyUrl: null, dailyCap: 200, monthlyCap: 3000 },
    chatDesign: null,
  };
}

export interface MultipartPart {
  name: string;
  value: string | Buffer;
  filename?: string;
  type?: string;
}

/** Cuerpo `multipart/form-data` como el de un `<input type="file">` de un formulario. */
export function multipartBody(parts: MultipartPart[]): { payload: Buffer; contentType: string } {
  const boundary = `----prueba${randomBytes(8).toString('hex')}`;
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const disposition = `form-data; name="${part.name}"${
      part.filename === undefined ? '' : `; filename="${part.filename}"`
    }`;
    const type = part.filename === undefined ? '' : `Content-Type: ${part.type ?? 'application/json'}\r\n`;
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: ${disposition}\r\n${type}\r\n`));
    chunks.push(Buffer.isBuffer(part.value) ? part.value : Buffer.from(part.value));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

/** Fichero analizado y validado, listo para `previewImport` / `applyImport`. */
export function importSource(bytes: Buffer): ImportSource {
  const parsed = parseConfigFile(bytes, { phoneRegion: 'ES' });
  if (!parsed.ok) throw new Error(`Fichero no válido: ${JSON.stringify(parsed.issues)}`);
  return { document: parsed.document, envelope: parsed.envelope };
}

/** Vista previa y confirmación seguidas, como el operador en el panel. */
export async function previewAndApply(
  db: Db,
  source: ImportSource,
  opts: Partial<ImportOptions> & { now?: Date } = {},
): Promise<{ preview: ImportPreview; result: ImportResult }> {
  const options: ImportOptions = {
    includeAlerts: opts.includeAlerts ?? false,
    instanceId: opts.instanceId ?? null,
    alertRoutes: opts.alertRoutes,
  };
  const preview = await previewImport(db, source, options);
  const result = await applyImport(db, source, {
    ...options,
    baseFingerprint: preview.baseFingerprint,
    now: opts.now ?? new Date('2026-09-30T11:00:00.000Z'),
  });
  return { preview, result };
}
