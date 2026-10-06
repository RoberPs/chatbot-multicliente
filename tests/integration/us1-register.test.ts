/** Flujo completo de US1 por el panel, verificado con lo que recibe el bot (quickstart §2). */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createKnowledgeReader } from '../../src/knowledge/snapshot.js';
import { isOpenAt } from '../../src/knowledge/time/intervals.js';
import {
  buildTestApp,
  login,
  postForm,
  slotFields,
  TYPICAL_WEEK,
  type Session,
} from '../helpers/app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';

describe('US1: registrar datos, horario, cierres y servicios', () => {
  let t: TestDatabase;
  let app: FastifyInstance;
  let session: Session;

  beforeAll(async () => {
    t = await createTestDatabase();
    app = await buildTestApp(t.db);
    session = await login(app);
  });
  afterAll(async () => {
    await app.close();
    await t.close();
  });

  it('el bot recibe todo lo registrado sin tocar código', async () => {
    const ok = async (url: string, fields: Parameters<typeof postForm>[3]) => {
      const res = await postForm(app, session, url, fields);
      expect(res.statusCode, `${url}: ${res.body.slice(0, 200)}`).toBe(303);
    };

    await ok('/admin/business', {
      name: 'Negocio de ejemplo',
      address: 'Calle Mayor 1',
      directions: 'Frente a la parada de autobús',
      phone: '600 123 456',
      email: 'hola@ejemplo.es',
      timezone: 'Europe/Madrid',
      currency: 'EUR',
    });
    await ok('/admin/hours', slotFields(TYPICAL_WEEK));
    await ok('/admin/closures', {
      start_date: '2026-12-25',
      end_date: '2026-12-25',
      reason: 'Navidad',
    });
    await ok('/admin/closures', {
      start_date: '2026-12-24',
      end_date: '2026-12-24',
      start_time: '14:00',
      end_time: '20:00',
    });
    await ok('/admin/services', {
      name: 'A',
      price_type: 'fixed',
      price: '20',
      duration: '30',
      bookable: true,
      active: true,
    });
    await ok('/admin/services', {
      name: 'B',
      price_type: 'from',
      price: '40',
      duration: '60',
      bookable: true,
      active: true,
    });
    await ok('/admin/services', { name: 'C', price_type: 'on_request', active: true });

    const snap = await createKnowledgeReader(t.db).getSnapshot();
    expect(snap.business).toEqual({
      name: 'Negocio de ejemplo',
      address: 'Calle Mayor 1',
      directions: 'Frente a la parada de autobús',
      mapUrl: null,
      phone: '+34600123456',
      email: 'hola@ejemplo.es',
      timezone: 'Europe/Madrid',
      currency: 'EUR',
    });
    expect(snap.handoff.source).toBe('business_phone');
    expect(snap.openingHours.filter((s) => s.weekday === 7)).toEqual([]);
    expect(snap.openingHours.filter((s) => s.weekday === 1)).toHaveLength(2);
    expect(isOpenAt(snap.openingHours, snap.closures, '2026-12-24', '17:00')).toBe(false);
    expect(isOpenAt(snap.openingHours, snap.closures, '2026-12-24', '10:00')).toBe(true);
    expect(isOpenAt(snap.openingHours, snap.closures, '2026-12-25', '10:00')).toBe(false);

    const [a, b, c] = snap.services;
    expect(a).toMatchObject({
      name: 'A',
      price: { type: 'fixed', amountCents: 2000 },
      durationMinutes: 30,
      bookable: true,
    });
    expect(b).toMatchObject({
      name: 'B',
      price: { type: 'from', amountCents: 4000 },
      durationMinutes: 60,
      bookable: true,
    });
    expect(c).toMatchObject({ name: 'C', price: { type: 'on_request' }, bookable: false });
    expect(snap.scheduling).toEqual({ mode: 'single_agenda' });
  });
});
