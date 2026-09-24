/** Protección de la salida a una persona (quickstart §6, FR-029 – FR-032, Principio V). */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createKnowledgeReader } from '../../src/knowledge/snapshot.js';
import { buildTestApp, get, login, postForm, type Session } from '../helpers/app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';

const business = (phone: string) => ({
  name: 'Negocio',
  phone,
  timezone: 'Europe/Madrid',
  currency: 'EUR',
});

describe('US4: el negocio activo nunca se queda sin salida a una persona', () => {
  let t: TestDatabase;
  let app: FastifyInstance;
  let session: Session;
  const snapshot = () => createKnowledgeReader(t.db).getSnapshot();

  beforeAll(async () => {
    t = await createTestDatabase();
    app = await buildTestApp(t.db);
    session = await login(app);
  });
  afterAll(async () => {
    await app.close();
    await t.close();
  });

  it('recorre el escenario completo', async () => {
    expect(
      (await postForm(app, session, '/admin/business', business('600123456'))).statusCode,
    ).toBe(303);
    expect(
      (
        await postForm(app, session, '/admin/handoff', {
          'channels[0].type': 'whatsapp',
          'channels[0].value': '611222333',
        })
      ).statusCode,
    ).toBe(303);
    expect((await postForm(app, session, '/admin/status/activate')).statusCode).toBe(303);
    expect((await snapshot()).handoff.source).toBe('configured');

    // Borrar el último medio con teléfono presente → se guarda y aparece HANDOFF_CONTACT_MISSING.
    let res = await postForm(app, session, '/admin/handoff', {});
    expect(res.statusCode).toBe(303);
    expect((await get(app, session, '/admin')).body).toContain(
      'data-code="HANDOFF_CONTACT_MISSING"',
    );
    expect((await snapshot()).handoff.source).toBe('business_phone');

    // Borrar el teléfono → 409, el teléfono sigue guardado y se explica el motivo.
    res = await postForm(app, session, '/admin/business', business(''));
    expect(res.statusCode).toBe(409);
    expect(res.body).toContain('se quedaría sin salida a una persona');
    expect(res.body).toContain('data-code="HANDOFF_UNREACHABLE"');
    let s = await snapshot();
    expect(s.business.phone).toBe('+34600123456');
    expect(s.status).toBe('active');
    expect(s.handoff.source).not.toBe('none');

    // Desactivar y repetir → se guarda y aparece HANDOFF_UNREACHABLE.
    expect((await postForm(app, session, '/admin/status/deactivate')).statusCode).toBe(303);
    res = await postForm(app, session, '/admin/business', business(''));
    expect(res.statusCode).toBe(303);
    s = await snapshot();
    expect(s.business.phone).toBeNull();
    expect(s.handoff.source).toBe('none');
    expect((await get(app, session, '/admin')).body).toContain('data-code="HANDOFF_UNREACHABLE"');
  });

  it('con el negocio activo, quitar la derivación sin teléfono → 409 y la derivación se conserva', async () => {
    await postForm(app, session, '/admin/handoff', {
      'channels[0].type': 'email',
      'channels[0].value': 'a@b.es',
    });
    expect((await postForm(app, session, '/admin/status/activate')).statusCode).toBe(303);
    const res = await postForm(app, session, '/admin/handoff', {});
    expect(res.statusCode).toBe(409);
    const s = await snapshot();
    expect(s.status).toBe('active');
    expect(s.handoff).toMatchObject({
      source: 'configured',
      channels: [{ type: 'email', value: 'a@b.es' }],
    });
  });
});
