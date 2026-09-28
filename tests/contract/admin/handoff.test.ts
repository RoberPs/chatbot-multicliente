/** 003: pantalla de Derivación (quitar medios, recuadro y mensajes del contacto que usa el bot). */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createKnowledgeReader } from '../../../src/knowledge/snapshot.js';
import {
  buildTestApp,
  cookieHeader,
  fieldErrorsIn,
  get,
  login,
  postForm,
  type Session,
} from '../../helpers/app.js';
import { createTestDatabase, resetDb, type TestDatabase } from '../../helpers/db.js';

const removeBox = (i: number) => `name="channels[${i}].remove"`;

describe('/admin/handoff: quitar medios (US1)', () => {
  let t: TestDatabase;
  let app: FastifyInstance;
  let session: Session;
  const snapshot = () => createKnowledgeReader(t.db).getSnapshot();

  const saveTwo = () =>
    postForm(app, session, '/admin/handoff', {
      'channels[0].type': 'whatsapp',
      'channels[0].value': '611 222 333',
      'channels[1].type': 'email',
      'channels[1].value': 'ayuda@ejemplo.es',
    });

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

  it('GET pinta "Quitar" solo en las filas guardadas, no en la fila de reserva', async () => {
    await saveTwo();
    const page = await get(app, session, '/admin/handoff');
    expect(page.body).toContain(removeBox(0));
    expect(page.body).toContain(removeBox(1));
    expect(page.body).not.toContain(removeBox(2));
    expect(page.body).toContain('name="channels[2].value"');
    expect(page.body).toMatch(/<label class="checkbox remove">[\s\S]*?Quitar<\/label>/);
  });

  it('la fila que añade "Añadir medio" no lleva "Quitar"', async () => {
    const res = await get(app, session, '/admin/partials/channel-row');
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('.remove"');
    expect(res.body).not.toContain('Quitar');
  });

  it('POST con una fila marcada → 303 y el medio desaparece', async () => {
    await saveTwo();
    const res = await postForm(app, session, '/admin/handoff', {
      'channels[0].type': 'whatsapp',
      'channels[0].value': '+34611222333',
      'channels[0].remove': 'on',
      'channels[1].type': 'email',
      'channels[1].value': 'ayuda@ejemplo.es',
    });
    expect(res.statusCode).toBe(303);
    expect((await snapshot()).handoff.channels).toEqual([
      { type: 'email', value: 'ayuda@ejemplo.es' },
    ]);
  });

  it('422 en otra fila → se vuelven a pintar los valores y la casilla marcada', async () => {
    await saveTwo();
    const res = await postForm(app, session, '/admin/handoff', {
      'channels[0].type': 'whatsapp',
      'channels[0].value': '+34611222333',
      'channels[0].remove': 'on',
      'channels[1].type': 'email',
      'channels[1].value': 'foo@',
    });
    expect(res.statusCode).toBe(422);
    expect(fieldErrorsIn(res.body)).toEqual(['channels[1].value']);
    expect(res.body).toContain(`${removeBox(0)} checked`);
    expect(res.body).toContain('value="foo@"');
    expect((await snapshot()).handoff.channels).toHaveLength(2);
  });

  it('409 (FR-032) → medios guardados, sin marcas, error general y aviso (FR-003)', async () => {
    await postForm(app, session, '/admin/handoff', {
      'channels[0].type': 'email',
      'channels[0].value': 'a@b.es',
    });
    expect((await postForm(app, session, '/admin/status/activate')).statusCode).toBe(303);
    const res = await postForm(app, session, '/admin/handoff', {
      'channels[0].type': 'email',
      'channels[0].value': 'a@b.es',
      'channels[0].remove': 'on',
    });
    expect(res.statusCode).toBe(409);
    expect(res.body).toContain('se quedaría sin salida a una persona');
    expect(res.body).toContain('data-code="HANDOFF_UNREACHABLE"');
    expect(res.body).toContain('value="a@b.es"');
    expect(res.body).toContain(removeBox(0));
    expect(res.body).not.toContain(`${removeBox(0)} checked`);
    expect((await snapshot()).handoff.channels).toEqual([{ type: 'email', value: 'a@b.es' }]);
  });
});

describe('/admin/handoff: contacto que usa el bot (003, US2)', () => {
  let t: TestDatabase;
  let app: FastifyInstance;
  let session: Session;

  const flashAfter = async (res: Awaited<ReturnType<typeof postForm>>) => {
    const page = await get(
      app,
      { ...session, cookie: cookieHeader(res) ?? session.cookie },
      '/admin/handoff',
    );
    return /class="flash" role="status">([^<]*)</.exec(page.body)?.[1];
  };
  const withPhone = () =>
    postForm(app, session, '/admin/business', {
      name: 'Negocio',
      phone: '600 123 456',
      timezone: 'Europe/Madrid',
      currency: 'EUR',
    });
  const channels = {
    'channels[0].type': 'whatsapp',
    'channels[0].value': '611 222 333',
    'channels[1].type': 'email',
    'channels[1].value': 'ayuda@ejemplo.es',
  };

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

  it('GET muestra el recuadro', async () => {
    await postForm(app, session, '/admin/handoff', channels);
    const page = await get(app, session, '/admin/handoff');
    expect(page.body).toContain(
      '<strong>El bot pasa las conversaciones a:</strong> WhatsApp +34611222333, Email ayuda@ejemplo.es.',
    );
    expect(page.body).toContain('Origen: contacto de derivación configurado.');
  });

  it('añadir medios → caso (a) configured', async () => {
    const res = await postForm(app, session, '/admin/handoff', channels);
    expect(await flashAfter(res)).toBe(
      'Guardado. A partir de ahora el bot pasa las conversaciones al contacto de derivación configurado: WhatsApp +34611222333, Email ayuda@ejemplo.es.',
    );
  });

  it('vaciar todos con teléfono del negocio → caso (a) business_phone', async () => {
    await withPhone();
    await postForm(app, session, '/admin/handoff', channels);
    const res = await postForm(app, session, '/admin/handoff', {
      ...channels,
      'channels[0].remove': 'on',
      'channels[1].remove': 'on',
    });
    expect(res.statusCode).toBe(303);
    expect(await flashAfter(res)).toBe(
      'Guardado. No hay contacto de derivación configurado, así que el bot pasa las conversaciones al teléfono del negocio: +34600123456.',
    );
  });

  it('vaciar todos en preparación y sin teléfono → caso (a) none (FR-007)', async () => {
    await postForm(app, session, '/admin/handoff', channels);
    const res = await postForm(app, session, '/admin/handoff', {});
    expect(res.statusCode).toBe(303);
    expect(await flashAfter(res)).toBe(
      'Guardado. El negocio se ha quedado sin salida a una persona: el bot no tiene a quién pasar las conversaciones. No se podrá activar hasta que registres un contacto de derivación o el teléfono del negocio.',
    );
  });

  it('guardar sin medios cuando no había contacto → Guardado (R5)', async () => {
    const res = await postForm(app, session, '/admin/handoff', {});
    expect(await flashAfter(res)).toBe('Guardado');
  });

  it('cambiar solo el horario → Guardado', async () => {
    await postForm(app, session, '/admin/handoff', channels);
    const res = await postForm(app, session, '/admin/handoff', {
      ...channels,
      'slots[0].weekday': '1',
      'slots[0].start': '10:00',
      'slots[0].end': '13:00',
    });
    expect(res.statusCode).toBe(303);
    expect(await flashAfter(res)).toBe('Guardado');
  });
});
