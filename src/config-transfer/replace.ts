/**
 * Reemplazo de la configuración del negocio por la de un documento (008, research R7).
 *
 * - Servicios y recursos se emparejan por nombre normalizado y las preguntas por pregunta
 *   normalizada (en orden entre repetidas): los emparejados conservan su UUID, los que no están
 *   en el documento se borran y los nuevos se insertan. `sort_order` = posición en el documento.
 * - Horario, cierres, enlaces, franjas, ausencias y medios de derivación se sustituyen enteros.
 * - Solo se escribe lo que cambia: reemplazar con la misma configuración no toca ningún
 *   `updated_at` (SC-002).
 * - El diseño del chat (011) se reemplaza entero y no toca la configuración del chat web.
 * - Nunca cambia `business.status` ni `web_chat_settings.enabled` (FR-017); `handoff_alerts`
 *   solo con `importAlerts` y destinos en el documento (FR-021).
 *
 * Se ejecuta dentro de la transacción recibida: la del ensayo (vista previa) o la de la
 * escritura protegida (confirmación).
 */
import { eq, inArray } from 'drizzle-orm';
import type { PgInsertValue } from 'drizzle-orm/pg-core';
import type { Tx } from '../db/client.js';
import {
  business,
  businessHours,
  chatDesign,
  closure,
  faq,
  handoffAlerts,
  handoffChannel,
  handoffContact,
  handoffHours,
  policies,
  resource,
  resourceAbsence,
  resourceHours,
  resourceService,
  service,
  tone,
  webChatSettings,
} from '../db/schema.js';
import { touch, touchBusiness } from '../db/timestamps.js';
import { readHandoffAlerts } from '../handoff/settings.js';
import { loadKnowledgeState } from '../knowledge/state.js';
import type { KnowledgeState, WeeklySlot } from '../knowledge/types.js';
import { SLOTS, type Slot } from '../webchat/design/defaults.js';
import { validateDesignImage } from '../webchat/design/images.js';
import type { ValidImageChange } from '../webchat/design/schemas.js';
import { saveChatDesign } from '../webchat/design/store.js';
import { readWebChatSettings } from '../webchat/settings.js';
import { normalizeKey, type ConfigDateBlock, type ConfigDocument } from './format.js';
import { readChatDesignDocument } from './read.js';

export interface ReplaceOptions {
  /** El operador eligió importar los destinos de los avisos (FR-021). */
  importAlerts: boolean;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

const sortSlots = (slots: WeeklySlot[]): WeeklySlot[] =>
  [...slots]
    .map((s) => ({ weekday: s.weekday, start: s.start, end: s.end }))
    .sort((a, b) => a.weekday - b.weekday || a.start.localeCompare(b.start));

/** Orden de la BD para los bloques de fechas: fecha y hora de inicio (sin hora, al final). */
const blockKey = (b: ConfigDateBlock) => `${b.startDate}|${b.startTime ?? '~'}|${b.endDate}|${b.endTime ?? '~'}`;
const sortBlocks = <T extends ConfigDateBlock>(blocks: T[]): T[] =>
  [...blocks].sort((a, b) => blockKey(a).localeCompare(blockKey(b)));

const slotRows = (slots: WeeklySlot[]) =>
  slots.map((s) => ({ weekday: s.weekday, startTime: s.start, endTime: s.end, ...touch() }));

/** Empareja por clave, en orden entre repetidas: posición del documento → id existente. */
function matchByKey<T>(
  existing: Array<{ id: string; key: string }>,
  wanted: T[],
  keyOf: (item: T) => string,
): Array<string | undefined> {
  const queues = new Map<string, string[]>();
  for (const e of existing) {
    const queue = queues.get(e.key) ?? [];
    queue.push(e.id);
    queues.set(e.key, queue);
  }
  return wanted.map((item) => queues.get(keyOf(item))?.shift());
}

/** Borra las filas con esos ids; devuelve si borró alguna. */
async function deleteIds(
  tx: Tx,
  table: typeof service | typeof resource | typeof faq,
  ids: string[],
): Promise<boolean> {
  if (ids.length === 0) return false;
  await tx.delete(table).where(inArray(table.id, ids));
  return true;
}

async function replaceBusiness(tx: Tx, state: KnowledgeState, doc: ConfigDocument): Promise<void> {
  const current = {
    name: state.business.name,
    address: state.business.address,
    directions: state.business.directions,
    mapUrl: state.business.mapUrl,
    phone: state.business.phone,
    email: state.business.email,
    timezone: state.business.timezone,
    currency: state.business.currency,
  };
  const next = { ...doc.business };
  if (same(current, next)) return;
  // `status` no se toca nunca (FR-017).
  await tx.update(business).set({ ...next, ...touch() }).where(eq(business.id, 1));
}

async function replaceOpeningHours(
  tx: Tx,
  state: KnowledgeState,
  doc: ConfigDocument,
): Promise<boolean> {
  if (same(sortSlots(state.businessHours), sortSlots(doc.openingHours))) return false;
  await tx.delete(businessHours);
  if (doc.openingHours.length > 0) await tx.insert(businessHours).values(slotRows(doc.openingHours));
  return true;
}

async function replaceClosures(tx: Tx, state: KnowledgeState, doc: ConfigDocument): Promise<boolean> {
  const current = sortBlocks(
    state.closures.map((c) => ({
      startDate: c.startDate,
      endDate: c.endDate,
      startTime: c.startTime,
      endTime: c.endTime,
      reason: c.reason,
    })),
  );
  const next = sortBlocks(doc.closures.map((c) => ({ ...c })));
  if (same(current, next)) return false;
  await tx.delete(closure);
  if (next.length > 0) await tx.insert(closure).values(next.map((c) => ({ ...c, ...touch() })));
  return true;
}

/** Servicios; devuelve el id de cada servicio del documento por nombre normalizado. */
async function replaceServices(
  tx: Tx,
  state: KnowledgeState,
  doc: ConfigDocument,
): Promise<{ ids: Map<string, string>; deleted: boolean }> {
  const matched = matchByKey(
    state.services.map((s) => ({ id: s.id, key: normalizeKey(s.name) })),
    doc.services,
    (s) => normalizeKey(s.name),
  );
  const keep = new Set(matched.filter((id): id is string => id !== undefined));
  // Primero los borrados: así un nombre que se libera no choca con el índice único.
  const deleted = await deleteIds(
    tx,
    service,
    state.services.filter((s) => !keep.has(s.id)).map((s) => s.id),
  );

  const ids = new Map<string, string>();
  const inserts: Array<PgInsertValue<typeof service>> = [];
  const byId = new Map(state.services.map((s) => [s.id, s]));
  for (const [sortOrder, s] of doc.services.entries()) {
    const values = {
      name: s.name,
      description: s.description,
      priceType: s.priceType,
      priceCents: s.priceCents,
      durationMinutes: s.durationMinutes,
      bookable: s.bookable,
      active: s.active,
      sortOrder,
    };
    const id = matched[sortOrder];
    const current = id ? byId.get(id) : undefined;
    if (id && current) {
      ids.set(normalizeKey(s.name), id);
      const now = {
        name: current.name,
        description: current.description,
        priceType: current.priceType,
        priceCents: current.priceCents,
        durationMinutes: current.durationMinutes,
        bookable: current.bookable,
        active: current.active,
        sortOrder: current.sortOrder,
      };
      if (!same(now, values)) {
        await tx.update(service).set({ ...values, ...touch() }).where(eq(service.id, id));
      }
    } else {
      inserts.push({ ...values, ...touch() });
    }
  }
  if (inserts.length > 0) {
    const rows = await tx.insert(service).values(inserts).returning({ id: service.id, name: service.name });
    for (const row of rows) ids.set(normalizeKey(row.name), row.id);
  }
  return { ids, deleted };
}

async function replaceResources(
  tx: Tx,
  state: KnowledgeState,
  doc: ConfigDocument,
  serviceIds: Map<string, string>,
): Promise<boolean> {
  const matched = matchByKey(
    state.resources.map((r) => ({ id: r.id, key: normalizeKey(r.name) })),
    doc.resources,
    (r) => normalizeKey(r.name),
  );
  const keep = new Set(matched.filter((id): id is string => id !== undefined));
  const deleted = await deleteIds(
    tx,
    resource,
    state.resources.filter((r) => !keep.has(r.id)).map((r) => r.id),
  );

  const byId = new Map(state.resources.map((r) => [r.id, r]));
  const links: Array<PgInsertValue<typeof resourceService>> = [];
  const hours: Array<PgInsertValue<typeof resourceHours>> = [];
  const absences: Array<PgInsertValue<typeof resourceAbsence>> = [];
  const replaced = { links: [] as string[], hours: [] as string[], absences: [] as string[] };

  for (const [sortOrder, r] of doc.resources.entries()) {
    const wantedServices = r.services
      .map((name) => serviceIds.get(normalizeKey(name)))
      .filter((id): id is string => id !== undefined);
    const wantedHours = sortSlots(r.hours);
    const wantedAbsences = sortBlocks(r.absences.map((a) => ({ ...a })));

    let id = matched[sortOrder];
    const current = id ? byId.get(id) : undefined;
    let changed = false;
    if (id && current) {
      if (current.name !== r.name || current.active !== r.active || current.sortOrder !== sortOrder) {
        changed = true;
      }
      if (!same([...current.serviceIds].sort(), [...wantedServices].sort())) {
        replaced.links.push(id);
        changed = true;
      }
      if (!same(sortSlots(current.hours), wantedHours)) {
        replaced.hours.push(id);
        changed = true;
      }
      const currentAbsences = sortBlocks(
        current.absences.map((a) => ({
          startDate: a.startDate,
          endDate: a.endDate,
          startTime: a.startTime,
          endTime: a.endTime,
        })),
      );
      if (!same(currentAbsences, wantedAbsences)) {
        replaced.absences.push(id);
        changed = true;
      }
      if (changed) {
        await tx
          .update(resource)
          .set({ name: r.name, active: r.active, sortOrder, ...touch() })
          .where(eq(resource.id, id));
      }
    } else {
      const [row] = await tx
        .insert(resource)
        .values({ name: r.name, active: r.active, sortOrder, ...touch() })
        .returning({ id: resource.id });
      if (!row) throw new Error('No se pudo crear el recurso');
      id = row.id;
      replaced.links.push(id);
      replaced.hours.push(id);
      replaced.absences.push(id);
    }
    const resourceId = id;
    if (replaced.links.includes(resourceId)) {
      links.push(...wantedServices.map((serviceId) => ({ resourceId, serviceId, ...touch() })));
    }
    if (replaced.hours.includes(resourceId)) {
      hours.push(...slotRows(wantedHours).map((h) => ({ ...h, resourceId })));
    }
    if (replaced.absences.includes(resourceId)) {
      absences.push(...wantedAbsences.map((a) => ({ ...a, resourceId, ...touch() })));
    }
  }

  if (replaced.links.length > 0) {
    await tx.delete(resourceService).where(inArray(resourceService.resourceId, replaced.links));
  }
  if (replaced.hours.length > 0) {
    await tx.delete(resourceHours).where(inArray(resourceHours.resourceId, replaced.hours));
  }
  if (replaced.absences.length > 0) {
    await tx.delete(resourceAbsence).where(inArray(resourceAbsence.resourceId, replaced.absences));
  }
  if (links.length > 0) await tx.insert(resourceService).values(links);
  if (hours.length > 0) await tx.insert(resourceHours).values(hours);
  if (absences.length > 0) await tx.insert(resourceAbsence).values(absences);
  return deleted;
}

async function replaceFaqs(tx: Tx, state: KnowledgeState, doc: ConfigDocument): Promise<boolean> {
  const matched = matchByKey(
    state.faqs.map((f) => ({ id: f.id, key: normalizeKey(f.question) })),
    doc.faqs,
    (f) => normalizeKey(f.question),
  );
  const keep = new Set(matched.filter((id): id is string => id !== undefined));
  const deleted = await deleteIds(
    tx,
    faq,
    state.faqs.filter((f) => !keep.has(f.id)).map((f) => f.id),
  );
  const byId = new Map(state.faqs.map((f) => [f.id, f]));
  const inserts: Array<PgInsertValue<typeof faq>> = [];
  for (const [sortOrder, f] of doc.faqs.entries()) {
    const id = matched[sortOrder];
    const current = id ? byId.get(id) : undefined;
    const values = { question: f.question, answer: f.answer, sortOrder };
    if (id && current) {
      const now = { question: current.question, answer: current.answer, sortOrder: current.sortOrder };
      if (!same(now, values)) await tx.update(faq).set({ ...values, ...touch() }).where(eq(faq.id, id));
    } else {
      inserts.push({ ...values, ...touch() });
    }
  }
  if (inserts.length > 0) await tx.insert(faq).values(inserts);
  return deleted;
}

async function replacePolicies(tx: Tx, state: KnowledgeState, doc: ConfigDocument): Promise<boolean> {
  if (doc.policies === null) {
    if (state.policies === null) return false;
    await tx.delete(policies);
    return true;
  }
  const next = { ...doc.policies, paymentMethods: [...doc.policies.paymentMethods] };
  if (state.policies) {
    const { updatedAt: _ignored, ...current } = state.policies;
    if (same(current, next)) return false;
  }
  await tx
    .insert(policies)
    .values({ id: 1, ...next, ...touch() })
    .onConflictDoUpdate({ target: policies.id, set: { ...next, ...touch() } });
  return false;
}

async function replaceTone(tx: Tx, state: KnowledgeState, doc: ConfigDocument): Promise<boolean> {
  if (doc.tone === null) {
    if (state.tone === null) return false;
    await tx.delete(tone);
    return true;
  }
  const next = { addressForm: doc.tone.addressForm, styleDescription: doc.tone.styleDescription };
  if (state.tone && same({ addressForm: state.tone.addressForm, styleDescription: state.tone.styleDescription }, next)) {
    return false;
  }
  await tx
    .insert(tone)
    .values({ id: 1, ...next, ...touch() })
    .onConflictDoUpdate({ target: tone.id, set: { ...next, ...touch() } });
  return false;
}

/** Contacto de derivación, como `saveHandoff` del panel: sin medios no hay contacto. */
async function replaceHandoff(tx: Tx, state: KnowledgeState, doc: ConfigDocument): Promise<boolean> {
  const wanted = doc.handoff;
  if (wanted === null || wanted.channels.length === 0) {
    if (state.handoff === null) return false;
    await tx.delete(handoffChannel);
    await tx.delete(handoffHours);
    await tx.delete(handoffContact);
    return true;
  }
  if (state.handoff) {
    const channels = [...state.handoff.channels]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((c) => ({ type: c.type, value: c.value }));
    if (same(channels, wanted.channels) && same(sortSlots(state.handoff.hours), sortSlots(wanted.hours))) {
      return false;
    }
  }
  await tx.delete(handoffChannel);
  await tx.delete(handoffHours);
  await tx
    .insert(handoffContact)
    .values({ id: 1, ...touch() })
    .onConflictDoUpdate({ target: handoffContact.id, set: touch() });
  await tx
    .insert(handoffChannel)
    .values(wanted.channels.map((c, sortOrder) => ({ type: c.type, value: c.value, sortOrder, ...touch() })));
  if (wanted.hours.length > 0) await tx.insert(handoffHours).values(slotRows(sortSlots(wanted.hours)));
  return false;
}

async function replaceWebChat(tx: Tx, doc: ConfigDocument): Promise<void> {
  const current = await readWebChatSettings(tx);
  const next = {
    allowedOrigins: [...doc.webChat.allowedOrigins],
    privacyUrl: doc.webChat.privacyUrl,
    dailyCap: doc.webChat.dailyCap,
    monthlyCap: doc.webChat.monthlyCap,
  };
  const now = {
    allowedOrigins: current.allowedOrigins,
    privacyUrl: current.privacyUrl,
    dailyCap: current.dailyCap,
    monthlyCap: current.monthlyCap,
  };
  if (same(now, next)) return;
  // `enabled` no se toca nunca (FR-017).
  await tx.update(webChatSettings).set({ ...next, ...touch() }).where(eq(webChatSettings.id, 1));
}

/**
 * Diseño del chat (011, FR-037): reemplazo completo; `null` borra la fila y, en cascada, sus
 * imágenes. Si las opciones y las imágenes no cambian no se escribe nada. Nunca toca
 * `web_chat_settings`.
 */
async function replaceChatDesign(tx: Tx, doc: ConfigDocument): Promise<void> {
  const wanted = doc.chatDesign ?? null;
  const current = await readChatDesignDocument(tx);
  if (same(current, wanted)) return;
  if (!wanted) {
    await tx.delete(chatDesign);
    return;
  }
  const { images, ...options } = wanted;
  const changes: Partial<Record<Slot, ValidImageChange>> = {};
  for (const slot of SLOTS) {
    const next = images[slot];
    if (!next) {
      changes[slot] = { kind: 'remove' };
    } else if (current?.images[slot]?.data === next.data) {
      changes[slot] = { kind: 'keep' };
    } else {
      // Ya validada al leer el fichero; aquí solo se obtienen sus metadatos.
      const result = validateDesignImage({ bytes: Buffer.from(next.data, 'base64'), truncated: false });
      if (!result.ok) throw new Error('Imagen del diseño sin validar');
      changes[slot] = { kind: 'replace', image: result.image };
    }
  }
  await saveChatDesign(tx, options, changes);
}

async function replaceAlerts(tx: Tx, doc: ConfigDocument): Promise<void> {
  const wanted = doc.alertDestinations;
  if (!wanted) return;
  const current = await readHandoffAlerts(tx);
  if (current.whatsapp === wanted.whatsapp && current.email === wanted.email) return;
  await tx
    .update(handoffAlerts)
    .set({ whatsappPhone: wanted.whatsapp, email: wanted.email, ...touch() })
    .where(eq(handoffAlerts.id, 1));
}

/** Reemplaza toda la configuración del negocio por la del documento (FR-016). */
export async function replaceConfig(
  tx: Tx,
  doc: ConfigDocument,
  opts: ReplaceOptions,
): Promise<void> {
  const state = await loadKnowledgeState(tx);
  let removed = false;
  await replaceBusiness(tx, state, doc);
  removed = ((await replaceOpeningHours(tx, state, doc)) && doc.openingHours.length === 0) || removed;
  removed = ((await replaceClosures(tx, state, doc)) && doc.closures.length === 0) || removed;
  const services = await replaceServices(tx, state, doc);
  removed = services.deleted || removed;
  removed = (await replaceResources(tx, state, doc, services.ids)) || removed;
  removed = (await replaceFaqs(tx, state, doc)) || removed;
  removed = (await replacePolicies(tx, state, doc)) || removed;
  removed = (await replaceTone(tx, state, doc)) || removed;
  removed = (await replaceHandoff(tx, state, doc)) || removed;
  await replaceWebChat(tx, doc);
  await replaceChatDesign(tx, doc);
  if (opts.importAlerts) await replaceAlerts(tx, doc);
  // Un borrado no deja ninguna fila modificada: se marca el cambio en el negocio, como el panel.
  if (removed) await touchBusiness(tx);
}
