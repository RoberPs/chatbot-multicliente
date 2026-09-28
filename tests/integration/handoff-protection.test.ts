/** Protección de la salida a una persona (quickstart §6, FR-029 – FR-032, Principio V). */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readState } from '../../src/admin/render.js';
import { CriticalWarningError } from '../../src/knowledge/errors.js';
import { effectiveHandoff } from '../../src/knowledge/handoff.js';
import { saveBusiness } from '../../src/knowledge/services/business-info.js';
import { activateBusiness } from '../../src/knowledge/services/business-status.js';
import { saveHandoff } from '../../src/knowledge/services/settings.js';
import { createKnowledgeReader } from '../../src/knowledge/snapshot.js';
import { buildTestApp, get, login, postForm, type Session } from '../helpers/app.js';
import { createTestDatabase, resetDb, type TestDatabase } from '../helpers/db.js';

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

describe('003 US1: quitar medios con la casilla "Quitar" sigue protegido por FR-032', () => {
  let t: TestDatabase;

  beforeAll(async () => {
    t = await createTestDatabase();
  });
  beforeEach(async () => {
    await resetDb(t.db);
  });
  afterAll(async () => {
    await t.close();
  });

  const removeOnly = { channels: [{ type: 'email', value: 'a@b.es', remove: 'on' }] };

  it('negocio activo sin teléfono y un único medio → CriticalWarningError y el medio sigue', async () => {
    await saveHandoff(t.deps, { channels: [{ type: 'email', value: 'a@b.es' }] });
    await activateBusiness(t.db);
    const error = await saveHandoff(t.deps, removeOnly).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CriticalWarningError);
    const state = await readState(t.db);
    expect(state.handoff?.channels.map((c) => c.value)).toEqual(['a@b.es']);
  });

  it('con teléfono del negocio → se guarda y el bot usa el teléfono del negocio', async () => {
    await saveBusiness(t.deps, business('600123456'));
    await saveHandoff(t.deps, { channels: [{ type: 'email', value: 'a@b.es' }] });
    await activateBusiness(t.db);
    await saveHandoff(t.deps, removeOnly);
    expect(effectiveHandoff(await readState(t.db)).source).toBe('business_phone');
  });
});
