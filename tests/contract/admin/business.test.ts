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

const valid = {
  name: 'Mi negocio',
  address: 'Calle Mayor 1',
  directions: 'Junto a la plaza',
  phone: '600 123 456',
  email: 'info@ejemplo.es',
  timezone: 'Europe/Madrid',
  currency: 'EUR',
};

describe('POST /admin/business', () => {
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

  it('válido → 303 a la página con "Guardado"', async () => {
    const res = await postForm(app, session, '/admin/business', valid);
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('/admin/business');
    const snapshot = await createKnowledgeReader(t.db).getSnapshot();
    expect(snapshot.business).toMatchObject({ name: 'Mi negocio', phone: '+34600123456' });
  });

  it('con htmx → 200 y HX-Location', async () => {
    const res = await postForm(app, session, '/admin/business', valid, { 'hx-request': 'true' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['hx-location']).toBe('/admin/business');
  });

  it('email foo@ → 422 con error en email, valores conservados y nada guardado', async () => {
    const res = await postForm(app, session, '/admin/business', { ...valid, email: 'foo@' });
    expect(res.statusCode).toBe(422);
    expect(fieldErrorsIn(res.body)).toEqual(['email']);
    expect(res.body).toContain('value="foo@"');
    expect(res.body).toContain('value="Calle Mayor 1"');
    expect((await createKnowledgeReader(t.db).getSnapshot()).business.name).toBe('');
  });

  it('teléfono inválido → 422 con error en phone', async () => {
    const res = await postForm(app, session, '/admin/business', { ...valid, phone: '12' });
    expect(res.statusCode).toBe(422);
    expect(fieldErrorsIn(res.body)).toEqual(['phone']);
  });

  it('GET muestra los datos guardados y el aviso "Guardado" una sola vez', async () => {
    const saved = await postForm(app, session, '/admin/business', valid);
    const next = { ...session, cookie: cookieHeader(saved) ?? session.cookie };
    const res = await get(app, next, '/admin/business');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('value="+34600123456"');
    expect(res.body).toContain('class="flash" role="status">Guardado');
    const again = await get(
      app,
      { ...next, cookie: cookieHeader(res) ?? next.cookie },
      '/admin/business',
    );
    expect(again.body).not.toContain('class="flash"');
  });
});

/** Flash que muestra la página siguiente a un guardado. */
async function flashAfter(
  app: FastifyInstance,
  session: Session,
  res: Awaited<ReturnType<typeof postForm>>,
  url: string,
): Promise<string | undefined> {
  const page = await get(app, { ...session, cookie: cookieHeader(res) ?? session.cookie }, url);
  return /class="flash" role="status">([^<]*)</.exec(page.body)?.[1];
}

describe('/admin/business: contacto que usa el bot (003, US2)', () => {
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

  const configure = () =>
    postForm(app, session, '/admin/handoff', {
      'channels[0].type': 'whatsapp',
      'channels[0].value': '611 222 333',
    });

  it('GET muestra el recuadro con los tres orígenes', async () => {
    let page = await get(app, session, '/admin/business');
    expect(page.body).toContain(
      '<strong>El bot no tiene a quién pasar las conversaciones.</strong>',
    );
    expect(page.body).toContain('Registra un contacto de derivación o el teléfono del negocio.');

    await postForm(app, session, '/admin/business', valid);
    page = await get(app, session, '/admin/business');
    expect(page.body).toContain('<strong>El bot pasa las conversaciones a:</strong> +34600123456.');
    expect(page.body).toContain(
      'Origen: teléfono del negocio, porque no hay contacto de derivación configurado.',
    );

    await configure();
    page = await get(app, session, '/admin/business');
    expect(page.body).toContain(
      '<strong>El bot pasa las conversaciones a:</strong> WhatsApp +34611222333.',
    );
    expect(page.body).toContain('Origen: contacto de derivación configurado.');
  });

  for (const htmx of [false, true]) {
    const headers: Record<string, string> = htmx ? { 'hx-request': 'true' } : {};
    const expectSaved = (res: Awaited<ReturnType<typeof postForm>>) => {
      if (htmx) {
        expect(res.statusCode).toBe(200);
        expect(res.headers['hx-location']).toBe('/admin/business');
      } else {
        expect(res.statusCode).toBe(303);
      }
    };

    describe(htmx ? 'con htmx' : 'sin JavaScript', () => {
      it('borrar el teléfono con contacto configurado → caso (b)', async () => {
        await postForm(app, session, '/admin/business', valid);
        await configure();
        const res = await postForm(
          app,
          session,
          '/admin/business',
          { ...valid, phone: '' },
          headers,
        );
        expectSaved(res);
        expect(await flashAfter(app, session, res, '/admin/business')).toBe(
          'Guardado. El teléfono del negocio no se usa para pasar conversaciones porque hay un contacto de derivación configurado; el bot sigue pasándolas a: WhatsApp +34611222333.',
        );
      });

      it('cambiar el teléfono sin contacto configurado → caso (a) con el número nuevo', async () => {
        await postForm(app, session, '/admin/business', valid);
        const res = await postForm(
          app,
          session,
          '/admin/business',
          { ...valid, phone: '600 999 888' },
          headers,
        );
        expectSaved(res);
        expect(await flashAfter(app, session, res, '/admin/business')).toBe(
          'Guardado. No hay contacto de derivación configurado, así que el bot pasa las conversaciones al teléfono del negocio: +34600999888.',
        );
      });

      it('cambiar solo el nombre → Guardado', async () => {
        await postForm(app, session, '/admin/business', valid);
        const res = await postForm(
          app,
          session,
          '/admin/business',
          { ...valid, name: 'Otro nombre' },
          headers,
        );
        expectSaved(res);
        expect(await flashAfter(app, session, res, '/admin/business')).toBe('Guardado');
      });
    });
  }
});

describe('/admin/business: enlace a mapa (003, US4)', () => {
  let t: TestDatabase;
  let app: FastifyInstance;
  let session: Session;
  const MAP = 'https://maps.example.com/@40.41,-3.70,17z?q=Plaza+Mayor&hl=es';
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

  it('inválido → 422 junto al campo, nada guardado y el resto conserva lo escrito', async () => {
    const res = await postForm(app, session, '/admin/business', {
      ...valid,
      map_url: 'http://maps.example.com/abc',
    });
    expect(res.statusCode).toBe(422);
    expect(fieldErrorsIn(res.body)).toEqual(['map_url']);
    expect(res.body).toContain('Usa el enlace seguro, que empieza por https://');
    expect(res.body).toContain('value="Calle Mayor 1"');
    expect(res.body).toContain('value="http://maps.example.com/abc"');
    expect((await snapshot()).business.name).toBe('');
  });

  it('válido → 303 y se guarda; el GET ofrece abrirlo en una pestaña nueva', async () => {
    const res = await postForm(app, session, '/admin/business', { ...valid, map_url: MAP });
    expect(res.statusCode).toBe(303);
    expect((await snapshot()).business.mapUrl).toBe(MAP);
    const page = await get(app, session, '/admin/business');
    const escaped = MAP.replaceAll('&', '&amp;');
    expect(page.body).toContain(
      `<a href="${escaped}" target="_blank" rel="noopener noreferrer">Abrir en una pestaña nueva</a>`,
    );
  });

  it('sin enlace guardado no hay "Abrir en una pestaña nueva"', async () => {
    await postForm(app, session, '/admin/business', valid);
    expect((await get(app, session, '/admin/business')).body).not.toContain(
      'Abrir en una pestaña nueva',
    );
  });

  it('tras un 422 el href sigue siendo el enlace guardado, no el enviado (R8)', async () => {
    await postForm(app, session, '/admin/business', { ...valid, map_url: MAP });
    const res = await postForm(app, session, '/admin/business', {
      ...valid,
      map_url: 'javascript:alert(1)',
    });
    expect(res.statusCode).toBe(422);
    expect(res.body).toContain(`href="${MAP.replaceAll('&', '&amp;')}"`);
    expect(res.body).not.toContain('href="javascript:');
  });

  it('"Cómo llegar" y "Enlace a mapa" muestran su ayuda', async () => {
    const page = (await get(app, session, '/admin/business')).body;
    expect(page).toContain(
      'El bot envía este texto tal cual cuando un cliente pregunta dónde estáis o cómo llegar.',
    );
    expect(page).toContain('Hay aparcamiento público a 100 m.');
    expect(page).toContain(
      'Opcional. Pega el enlace de "Compartir" de cualquier servicio de mapas',
    );
  });
});
