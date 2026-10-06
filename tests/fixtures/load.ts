/** Carga un negocio de ejemplo usando solo los casos de uso del dominio (el mismo modelo para todos). */
import {
  createClosure,
  saveBusiness,
  saveBusinessHours,
} from '../../src/knowledge/services/business-info.js';
import { createService } from '../../src/knowledge/services/catalog.js';
import type { KnowledgeDeps } from '../../src/knowledge/services/deps.js';
import { createFaq } from '../../src/knowledge/services/faqs.js';
import {
  createAbsence,
  createResource,
  saveResourceHours,
} from '../../src/knowledge/services/resources.js';
import { saveHandoff, savePolicies, saveTone } from '../../src/knowledge/services/settings.js';
import { clinic } from './clinic.js';
import { hairSalon } from './hair-salon.js';
import type { BusinessFixture } from './types.js';
import { workshop } from './workshop.js';

export const allFixtures: BusinessFixture[] = [clinic, hairSalon, workshop];

const toSlots = (slots: Array<[number, string, string]>) =>
  slots.map(([weekday, start, end]) => ({ weekday: String(weekday), start, end }));

export async function loadFixture(deps: KnowledgeDeps, fixture: BusinessFixture): Promise<void> {
  await saveBusiness(deps, fixture.business);
  await saveBusinessHours(deps, { slots: toSlots(fixture.hours) });
  for (const closure of fixture.closures) await createClosure(deps, closure);

  const serviceIds = new Map<string, string>();
  for (const service of fixture.services) {
    serviceIds.set(String(service.name), await createService(deps, service));
  }
  for (const r of fixture.resources) {
    const id = await createResource(deps, {
      name: r.name,
      service_ids: r.services.map((name) => serviceIds.get(name) ?? ''),
      active: r.active === false ? '' : 'on',
    });
    await saveResourceHours(deps, id, { slots: toSlots(r.hours) });
    for (const absence of r.absences ?? []) await createAbsence(deps, id, absence);
  }
  for (const faq of fixture.faqs) await createFaq(deps, faq);
  await savePolicies(deps, fixture.policies);
  await saveTone(deps, fixture.tone);
  await saveHandoff(deps, {
    channels: fixture.handoff.channels,
    slots: toSlots(fixture.handoff.slots),
  });
}
