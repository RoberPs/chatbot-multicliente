/**
 * Configuración de la BD de la instancia → documento del formato (008, data-model §1). Se lee
 * dentro de la transacción recibida, con la misma consulta que usan el bot y los avisos.
 */
import type { Tx } from '../db/client.js';
import { readHandoffAlerts } from '../handoff/settings.js';
import { loadKnowledgeState } from '../knowledge/state.js';
import type { KnowledgeState } from '../knowledge/types.js';
import { readWebChatSettings } from '../webchat/settings.js';
import type { Slot } from '../webchat/design/defaults.js';
import { readChatDesign, readDesignImageBytes } from '../webchat/design/store.js';
import type { ConfigChatDesign, ConfigChatImage, ConfigDocument, ConfigInfo } from './format.js';

/** Secciones del documento a partir del estado ya cargado (sin destinos de avisos). */
export function documentFromState(
  state: KnowledgeState,
  webChat: ConfigDocument['webChat'],
  chatDesign: ConfigDocument['chatDesign'],
): ConfigDocument {
  const serviceNames = new Map(state.services.map((s) => [s.id, s.name]));
  return {
    business: {
      name: state.business.name,
      address: state.business.address,
      directions: state.business.directions,
      mapUrl: state.business.mapUrl,
      phone: state.business.phone,
      email: state.business.email,
      timezone: state.business.timezone,
      currency: state.business.currency,
    },
    openingHours: state.businessHours,
    closures: state.closures.map((c) => ({
      startDate: c.startDate,
      endDate: c.endDate,
      startTime: c.startTime,
      endTime: c.endTime,
      reason: c.reason,
    })),
    services: state.services.map((s) => ({
      name: s.name,
      description: s.description,
      priceType: s.priceType,
      priceCents: s.priceCents,
      durationMinutes: s.durationMinutes,
      bookable: s.bookable,
      active: s.active,
    })),
    resources: state.resources.map((r) => ({
      name: r.name,
      active: r.active,
      services: r.serviceIds
        .map((id) => serviceNames.get(id))
        .filter((name): name is string => name !== undefined),
      hours: r.hours,
      absences: r.absences.map((a) => ({
        startDate: a.startDate,
        endDate: a.endDate,
        startTime: a.startTime,
        endTime: a.endTime,
      })),
    })),
    faqs: state.faqs.map((f) => ({ question: f.question, answer: f.answer })),
    policies: state.policies && {
      cancellationText: state.policies.cancellationText,
      cancellationNoticeMinutes: state.policies.cancellationNoticeMinutes,
      minAdvanceMinutes: state.policies.minAdvanceMinutes,
      maxAdvanceMinutes: state.policies.maxAdvanceMinutes,
      paymentMethods: state.policies.paymentMethods,
    },
    tone: state.tone && {
      addressForm: state.tone.addressForm,
      styleDescription: state.tone.styleDescription,
    },
    handoff: state.handoff && {
      channels: [...state.handoff.channels]
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((c) => ({ type: c.type, value: c.value })),
      hours: state.handoff.hours,
    },
    webChat,
    chatDesign,
  };
}

/**
 * Diseño del chat en la forma del fichero (011): las opciones que se aplican y las imágenes tal
 * como están guardadas (ya normalizadas), con las claves en el orden del contrato. `null` sin
 * diseño.
 */
export async function readChatDesignDocument(tx: Tx): Promise<ConfigChatDesign | null> {
  const design = await readChatDesign(tx);
  if (!design.saved) return null;
  const image = async (slot: Slot): Promise<ConfigChatImage | null> => {
    if (!design.images[slot]) return null;
    const stored = await readDesignImageBytes(tx, slot);
    return stored ? { type: stored.mimeType, data: stored.bytes.toString('base64') } : null;
  };
  const o = design.options;
  return {
    primaryColor: o.primaryColor,
    onPrimaryColor: o.onPrimaryColor,
    backgroundColor: o.backgroundColor,
    textColor: o.textColor,
    botBubbleColor: o.botBubbleColor,
    shape: o.shape,
    position: o.position,
    size: o.size,
    chatName: o.chatName,
    welcomeText: o.welcomeText,
    placeholder: o.placeholder,
    sendLabel: o.sendLabel,
    images: { logo: await image('logo'), avatar: await image('avatar'), icon: await image('icon') },
  };
}

export interface ReadOptions {
  /** Añade `alertDestinations` (FR-005). */
  includeAlerts: boolean;
}

/** Documento de la configuración actual. */
export async function readConfigDocument(tx: Tx, opts: ReadOptions): Promise<ConfigDocument> {
  const state = await loadKnowledgeState(tx);
  const settings = await readWebChatSettings(tx);
  const doc = documentFromState(
    state,
    {
      allowedOrigins: settings.allowedOrigins,
      privacyUrl: settings.privacyUrl,
      dailyCap: settings.dailyCap,
      monthlyCap: settings.monthlyCap,
    },
    await readChatDesignDocument(tx),
  );
  if (!opts.includeAlerts) return doc;
  const alerts = await readHandoffAlerts(tx);
  return { ...doc, alertDestinations: { whatsapp: alerts.whatsapp, email: alerts.email } };
}

/** Estado del negocio y activación del chat web: informativos, nunca se importan (FR-004). */
export async function readConfigInfo(tx: Tx): Promise<ConfigInfo> {
  const state = await loadKnowledgeState(tx);
  const settings = await readWebChatSettings(tx);
  return { businessStatus: state.business.status, webChatEnabled: settings.enabled };
}

/** Documento con destinos e información en una sola lectura del estado (vista previa, huella). */
export async function readConfigWithInfo(
  tx: Tx,
): Promise<{ document: ConfigDocument; info: ConfigInfo }> {
  const state = await loadKnowledgeState(tx);
  const settings = await readWebChatSettings(tx);
  const alerts = await readHandoffAlerts(tx);
  const document = {
    ...documentFromState(
      state,
      {
        allowedOrigins: settings.allowedOrigins,
        privacyUrl: settings.privacyUrl,
        dailyCap: settings.dailyCap,
        monthlyCap: settings.monthlyCap,
      },
      await readChatDesignDocument(tx),
    ),
    alertDestinations: { whatsapp: alerts.whatsapp, email: alerts.email },
  };
  return {
    document,
    info: { businessStatus: state.business.status, webChatEnabled: settings.enabled },
  };
}
