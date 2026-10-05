/**
 * Serialización canónica del fichero de configuración (008, research R1): JSON con sangría de
 * 2 espacios, claves en el orden del contrato y salto de línea final. Dos exportaciones de la
 * misma configuración solo difieren en `exportedAt`. La huella (R9) sale del mismo orden.
 */
import { createHash } from 'node:crypto';
import type { BusinessStatus, WeeklySlot } from '../knowledge/types.js';
import type {
  ConfigChatDesign,
  ConfigChatImage,
  ConfigDateBlock,
  ConfigDocument,
  ConfigFileEnvelope,
  ConfigResource,
  ConfigService,
} from './format.js';

const slot = (s: WeeklySlot) => ({ weekday: s.weekday, start: s.start, end: s.end });

const block = (b: ConfigDateBlock) => ({
  startDate: b.startDate,
  endDate: b.endDate,
  startTime: b.startTime,
  endTime: b.endTime,
});

const service = (s: ConfigService) => ({
  name: s.name,
  description: s.description,
  priceType: s.priceType,
  priceCents: s.priceCents,
  durationMinutes: s.durationMinutes,
  bookable: s.bookable,
  active: s.active,
});

const image = (i: ConfigChatImage | null) => i && { type: i.type, data: i.data };

/** Diseño del chat en el orden del contrato (011). */
const chatDesign = (d: ConfigChatDesign) => ({
  primaryColor: d.primaryColor,
  onPrimaryColor: d.onPrimaryColor,
  backgroundColor: d.backgroundColor,
  textColor: d.textColor,
  botBubbleColor: d.botBubbleColor,
  shape: d.shape,
  position: d.position,
  size: d.size,
  chatName: d.chatName,
  welcomeText: d.welcomeText,
  placeholder: d.placeholder,
  sendLabel: d.sendLabel,
  images: { logo: image(d.images.logo), avatar: image(d.images.avatar), icon: image(d.images.icon) },
});

const resource = (r: ConfigResource) => ({
  name: r.name,
  active: r.active,
  services: [...r.services],
  hours: r.hours.map(slot),
  absences: r.absences.map(block),
});

/** Secciones del documento en el orden del contrato; `alertDestinations` solo si se pide. */
function canonicalDocument(doc: ConfigDocument, includeAlerts: boolean) {
  const { business, policies, tone, handoff, webChat } = doc;
  return {
    business: {
      name: business.name,
      address: business.address,
      directions: business.directions,
      mapUrl: business.mapUrl,
      phone: business.phone,
      email: business.email,
      timezone: business.timezone,
      currency: business.currency,
    },
    openingHours: doc.openingHours.map(slot),
    closures: doc.closures.map((c) => ({ ...block(c), reason: c.reason })),
    services: doc.services.map(service),
    resources: doc.resources.map(resource),
    faqs: doc.faqs.map((f) => ({ question: f.question, answer: f.answer })),
    policies: policies && {
      cancellationText: policies.cancellationText,
      cancellationNoticeMinutes: policies.cancellationNoticeMinutes,
      minAdvanceMinutes: policies.minAdvanceMinutes,
      maxAdvanceMinutes: policies.maxAdvanceMinutes,
      paymentMethods: [...policies.paymentMethods],
    },
    tone: tone && { addressForm: tone.addressForm, styleDescription: tone.styleDescription },
    handoff: handoff && {
      channels: handoff.channels.map((c) => ({ type: c.type, value: c.value })),
      hours: handoff.hours.map(slot),
    },
    webChat: {
      allowedOrigins: [...webChat.allowedOrigins],
      privacyUrl: webChat.privacyUrl,
      dailyCap: webChat.dailyCap,
      monthlyCap: webChat.monthlyCap,
    },
    // Un documento de la versión 1 (sin la sección) se reproduce tal cual.
    ...((doc as Partial<ConfigDocument>).chatDesign === undefined
      ? {}
      : { chatDesign: doc.chatDesign && chatDesign(doc.chatDesign) }),
    ...(includeAlerts && doc.alertDestinations
      ? {
          alertDestinations: {
            whatsapp: doc.alertDestinations.whatsapp,
            email: doc.alertDestinations.email,
          },
        }
      : {}),
  };
}

/** Fichero completo: sobre y secciones. `alertDestinations` solo con `includesAlertDestinations`. */
export function serializeConfigFile(envelope: ConfigFileEnvelope, doc: ConfigDocument): string {
  const file = {
    format: envelope.format,
    formatVersion: envelope.formatVersion,
    exportedAt: envelope.exportedAt,
    source: { instanceId: envelope.source.instanceId, schema: envelope.source.schema },
    includesAlertDestinations: envelope.includesAlertDestinations,
    info: {
      businessStatus: envelope.info.businessStatus,
      webChatEnabled: envelope.info.webChatEnabled,
    },
    ...canonicalDocument(doc, envelope.includesAlertDestinations),
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** `AAAAMMDD-HHMM` en UTC. */
const stamp = (date: Date): string => {
  const iso = date.toISOString();
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}`;
};

/** `configuracion-<INSTANCE_ID o "instancia">-<AAAAMMDD-HHMM>.json` (R1). */
export const configFileName = (instanceId: string | null, date: Date): string =>
  `configuracion-${instanceId ?? 'instancia'}-${stamp(date)}.json`;

/** `configuracion-anterior-<AAAAMMDD-HHMM>.json` (FR-022). */
export const preImportFileName = (date: Date): string =>
  `configuracion-anterior-${stamp(date)}.json`;

export interface FingerprintInput {
  /** Configuración actual **con** destinos de avisos. */
  document: ConfigDocument;
  businessStatus: BusinessStatus;
  webChatEnabled: boolean;
}

/**
 * Huella de todo lo que puede cambiar el resultado de una importación (R9): SHA-256 hex del
 * documento canónico con destinos, el estado del negocio y la activación del chat web.
 */
export function configFingerprint(input: FingerprintInput): string {
  const canonical = JSON.stringify({
    document: canonicalDocument(input.document, true),
    businessStatus: input.businessStatus,
    webChatEnabled: input.webChatEnabled,
  });
  return createHash('sha256').update(canonical).digest('hex');
}
