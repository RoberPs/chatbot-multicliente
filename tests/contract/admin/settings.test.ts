import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createKnowledgeReader } from '../../../src/knowledge/snapshot.js';
import {
  buildTestApp,
  fieldErrorsIn,
  get,
  login,
  postForm,
  type Session,
} from '../../helpers/app.js';
import { createTestDatabase, resetDb, type TestDatabase } from '../../helpers/db.js';

describe('políticas, tono y derivación', () => {
  let t: TestDatabase;
  let app: FastifyInstance;
  let session: Session;
  const snapshot = () => createKnowledgeReader(t.db).getSnapshot();

  beforeAll(async () => {
    t = await createTestDatabase();
    app = await buildTestApp(t.db);
    session = await login(app);
  });
  beforeEach(async () => {
    await resetDb(t.db);
  });
  afterAll(async () => {
    await app.close();
    await t.close();
  });

  it('/admin/policies guarda en minutos y muestra la mayor unidad exacta', async () => {
    const res = await postForm(app, session, '/admin/policies', {
      cancellation_text: 'Avisa con 24 h',
      cancellation_notice: '24',
      cancellation_notice_unit: 'hours',
      min_advance: '2',
      min_advance_unit: 'hours',
      max_advance: '30',
      max_advance_unit: 'days',
      payment_methods: ['Efectivo', 'Tarjeta', ''],
    });
    expect(res.statusCode).toBe(303);
    expect((await snapshot()).policies).toEqual({
      cancellationText: 'Avisa con 24 h',
      cancellationNoticeMinutes: 1440,
      minAdvanceMinutes: 120,
      maxAdvanceMinutes: 43200,
      paymentMethods: ['Efectivo', 'Tarjeta'],
    });
    const page = await get(app, session, '/admin/policies');
    expect(page.body).toMatch(/name="max_advance" value="30"/);
    expect(page.body).toMatch(/name="max_advance_unit">[\s\S]*?<option value="days" selected>/);
    expect(page.body).toContain('value="Efectivo"');
  });

  it('antelación mínima 3 días y máxima 2 días → 422 en min_advance', async () => {
    const res = await postForm(app, session, '/admin/policies', {
      min_advance: '3',
      min_advance_unit: 'days',
      max_advance: '2',
      max_advance_unit: 'days',
    });
    expect(res.statusCode).toBe(422);
    expect(fieldErrorsIn(res.body)).toEqual(['min_advance']);
    expect((await snapshot()).policies.minAdvanceMinutes).toBeNull();
  });

  it('/admin/tone', async () => {
    let res = await postForm(app, session, '/admin/tone', { style_description: 'Cercano' });
    expect(res.statusCode).toBe(422);
    expect(fieldErrorsIn(res.body)).toEqual(['address_form']);
    res = await postForm(app, session, '/admin/tone', {
      address_form: 'formal',
      style_description: 'Cercano',
    });
    expect(res.statusCode).toBe(303);
    expect((await snapshot()).tone).toEqual({ addressForm: 'formal', styleDescription: 'Cercano' });
  });

  it('/admin/handoff con medios y horario; sin medios elimina el contacto', async () => {
    let res = await postForm(app, session, '/admin/handoff', {
      'channels[0].type': 'whatsapp',
      'channels[0].value': '611 222 333',
      'channels[1].type': 'phone',
      'channels[1].value': '',
      'slots[0].weekday': '1',
      'slots[0].start': '10:00',
      'slots[0].end': '13:00',
    });
    expect(res.statusCode).toBe(303);
    expect((await snapshot()).handoff).toEqual({
      source: 'configured',
      channels: [{ type: 'whatsapp', value: '+34611222333' }],
      hours: [{ weekday: 1, start: '10:00', end: '13:00' }],
    });

    res = await postForm(app, session, '/admin/handoff', {
      'channels[0].type': 'email',
      'channels[0].value': 'foo@',
    });
    expect(res.statusCode).toBe(422);
    expect(fieldErrorsIn(res.body)).toEqual(['channels[0].value']);

    res = await postForm(app, session, '/admin/handoff', {
      'channels[0].type': 'phone',
      'channels[0].value': '',
    });
    expect(res.statusCode).toBe(303);
    expect((await snapshot()).handoff.source).toBe('none');
  });

  it('Políticas, Tono y Derivación explican que son registros únicos (003, FR-008)', async () => {
    expect((await get(app, session, '/admin/policies')).body).toContain(
      'Cada negocio tiene un único conjunto de políticas. Al guardar, lo que hay en este formulario sustituye a lo anterior.',
    );
    expect((await get(app, session, '/admin/tone')).body).toContain(
      'Cada negocio tiene una única configuración de tono. Al guardar, sustituye a la anterior.',
    );
    expect((await get(app, session, '/admin/handoff')).body).toContain(
      'Cada negocio tiene un único contacto de derivación, con uno o varios medios por orden de preferencia. Para añadir un medio, rellena la fila vacía o pulsa "Añadir medio". Para quitarlo, marca "Quitar" y guarda. Si quitas todos, el bot usará el teléfono del negocio.',
    );
  });
});
