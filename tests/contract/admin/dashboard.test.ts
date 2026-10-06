/** 003, FR-009 y SC-004: resúmenes de Políticas, Tono y Derivación en la portada. */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, get, login, postForm, type Session } from '../../helpers/app.js';
import { createTestDatabase, resetDb, type TestDatabase } from '../../helpers/db.js';

const summary = (html: string, key: string) =>
  new RegExp(`data-summary="${key}">([^<]*)<`).exec(html)?.[1];

describe('GET /admin: resúmenes de sección', () => {
  let t: TestDatabase;
  let app: FastifyInstance;
  let session: Session;

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

  it('sin configurar y tras guardar Políticas, Tono y Derivación', async () => {
    let page = (await get(app, session, '/admin')).body;
    expect(summary(page, 'policies')).toBe('Sin configurar');
    expect(summary(page, 'tone')).toBe('Sin configurar');
    expect(summary(page, 'handoff')).toBe('Sin configurar');

    await postForm(app, session, '/admin/policies', {
      payment_methods: ['Efectivo', 'Tarjeta', 'Transferencia'],
    });
    await postForm(app, session, '/admin/tone', { address_form: 'formal' });
    await postForm(app, session, '/admin/handoff', {
      'channels[0].type': 'whatsapp',
      'channels[0].value': '611 222 333',
    });

    page = (await get(app, session, '/admin')).body;
    expect(summary(page, 'policies')).toBe('3 formas de pago · sin política de cancelación');
    expect(summary(page, 'tone')).toBe('trato de usted');
    expect(summary(page, 'handoff')).toBe('1 medio');
  });
});
