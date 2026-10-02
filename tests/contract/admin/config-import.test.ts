/* eslint-disable @typescript-eslint/no-non-null-assertion, @typescript-eslint/no-unsafe-assignment -- JSON crudo del fichero de ejemplo, manipulado a propósito; los elementos existen por construcción del ejemplo; si no, el test debe fallar */
/**
 * Contrato de la importación desde el panel (008, contracts/admin-config-transfer.md):
 * subida, vista previa, confirmación, cancelación, resultado, configuración anterior, rechazos
 * y registros.
 */
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as parse from '../../../src/config-transfer/parse.js';
import { readPreImport } from '../../../src/config-transfer/service.js';
import { faq } from '../../../src/db/schema.js';
import { updateFaq } from '../../../src/knowledge/services/faqs.js';
import {
  buildTestApp,
  cookieHeader,
  encodeForm,
  get,
  loggedEvents,
  login,
  postForm,
  type Session,
} from '../../helpers/app.js';
import {
  configTablesFingerprint,
  fixtureJson,
  FULL_ALERTS,
  instanceEnv,
  loadFixture,
  multipartBody,
  seedFullBusiness,
} from '../../helpers/config-transfer.js';
import { seedChatDesign, seedChatDesignWithImages } from '../../helpers/chat-design.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';

vi.mock('../../../src/config-transfer/parse.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/config-transfer/parse.js')>();
  return { ...original, parseConfigFile: vi.fn(original.parseConfigFile) };
});

describe('Importar desde el panel (/admin/config/import)', () => {
  let t: TestDatabase;
  let app: FastifyInstance;
  let session: Session;
  const lines: string[] = [];

  beforeAll(async () => {
    t = await createTestDatabase();
    app = await buildTestApp(t.db, 'postgres://no-usada', null, instanceEnv('produccion-01'), lines);
  });
  afterAll(async () => {
    await app.close();
    await t.close();
  });
  beforeEach(async () => {
    await seedFullBusiness(t.deps, { webChatEnabled: false });
    await t.db.execute(`delete from config_pre_import`);
    lines.length = 0;
    session = await login(app);
    vi.mocked(parse.parseConfigFile).mockClear();
  });

  const events = (name: string) => loggedEvents(lines, 'config').filter((e) => e.event === name);

  /** Sube un fichero como lo haría el formulario del panel. */
  function upload(
    file: Buffer | null,
    opts: { csrf?: boolean; filename?: string; type?: string } = {},
  ) {
    const { payload, contentType } = multipartBody([
      ...(opts.csrf === false ? [] : [{ name: '_csrf', value: session.csrf }]),
      ...(file === null
        ? [{ name: 'file', value: Buffer.alloc(0), filename: '' }]
        : [{ name: 'file', value: file, filename: opts.filename ?? 'configuracion.json', type: opts.type }]),
    ]);
    return app.inject({
      method: 'POST',
      url: '/admin/config/import',
      headers: { cookie: session.cookie, 'content-type': contentType },
      payload,
    });
  }

  /** Sube el fichero y devuelve la ruta de su vista previa. */
  async function uploaded(file: Buffer): Promise<string> {
    const res = await upload(file);
    expect(res.statusCode).toBe(303);
    const location = res.headers.location ?? '';
    expect(location).toMatch(/^\/admin\/config\/import\/[A-Za-z0-9_-]{22}$/);
    return location;
  }

  const hidden = (html: string, name: string) =>
    new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1] ?? '';

  async function apply(path: string, html: string, over: Record<string, string> = {}) {
    return postForm(app, session, `${path}/apply`, {
      base: hidden(html, 'base'),
      include_alerts: hidden(html, 'include_alerts'),
      ...over,
    });
  }

  const keepCookie = (res: LightMyRequestResponse) => {
    const cookie = cookieHeader(res);
    if (cookie) session = { ...session, cookie };
  };

  describe('subida y vista previa', () => {
    it('fichero válido con _csrf → 303 a la vista previa; sin CSRF → 403', async () => {
      await uploaded(loadFixture('valid-full.json'));
      const noCsrf = await upload(loadFixture('valid-full.json'), { csrf: false });
      expect(noCsrf.statusCode).toBe(403);
    });

    it('la vista previa muestra metadatos, cambios, avisos y "Se aplicará" sin cambiar la BD', async () => {
      const f = fixtureJson('valid-full.json') as Record<string, Record<string, unknown>>;
      f.business!.name = 'Negocio renombrado';
      const path = await uploaded(Buffer.from(JSON.stringify(f)));
      const fingerprint = await configTablesFingerprint(t.db);
      const res = await get(app, session, path);
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toContain('<code>demo-01</code>');
      expect(res.body).toContain('<code>0005_config_transfer</code>');
      expect(res.body).toContain('data-section="business"');
      expect(res.body).toContain('Nombre: Negocio de ejemplo → Negocio renombrado');
      expect(res.body).toContain('Avisos que tendría el negocio');
      expect(res.body).toContain('data-outcome="will_apply"');
      expect(res.body).toMatch(/<button type="submit">Confirmar la importación<\/button>/);
      expect(await configTablesFingerprint(t.db)).toBe(fingerprint);
    });

    it('fichero igual a la configuración actual: "La configuración del fichero es igual a la actual"', async () => {
      const path = await uploaded(loadFixture('valid-full.json'));
      const res = await get(app, session, path);
      expect(res.body).toContain('La configuración del fichero es igual a la actual.');
    });

    it('404 para un id inexistente o de otra sesión', async () => {
      const missing = await get(app, session, '/admin/config/import/AAAAAAAAAAAAAAAAAAAAAA');
      expect(missing.statusCode).toBe(404);
      expect(missing.body).toContain('La importación ha caducado; vuelve a subir el fichero');
      expect(missing.body).toContain('href="/admin/config"');

      const path = await uploaded(loadFixture('valid-full.json'));
      await postForm(app, session, '/admin/logout');
      session = await login(app);
      expect((await get(app, session, path)).statusCode).toBe(404);
    });

    it('con destinos: aviso, casilla desmarcada salvo ?alerts=1 y include_alerts oculto de la vista mostrada', async () => {
      const path = await uploaded(loadFixture('valid-full-with-alerts.json'));
      const off = await get(app, session, path);
      expect(off.body).toContain('La instancia enviará los avisos de derivación a estos destinos');
      expect(off.body).toContain(FULL_ALERTS.whatsapp);
      expect(off.body).toMatch(/<input id="include_alerts" name="alerts" type="checkbox" value="1">/);
      expect(off.body).toContain(`hx-get="${path}"`);
      expect(off.body).toContain('hx-trigger="change"');
      expect(off.body).toContain('Actualizar vista previa');
      expect(hidden(off.body, 'include_alerts')).toBe('0');
      expect(off.body).not.toContain('data-section="alertDestinations"');

      const on = await get(app, session, `${path}?alerts=1`);
      expect(on.body).toMatch(/<input id="include_alerts" name="alerts" type="checkbox" value="1" checked>/);
      expect(hidden(on.body, 'include_alerts')).toBe('1');
      expect(on.body).toContain('data-section="alertDestinations"');
    });

    it('registra config_import_previewed una sola vez por pendiente', async () => {
      const path = await uploaded(loadFixture('valid-full.json'));
      await get(app, session, path);
      await get(app, session, path);
      expect(events('config_import_previewed')).toEqual([
        expect.objectContaining({
          sourceInstance: 'demo-01',
          formatVersion: 2,
          sameInstance: false,
          outcome: 'will_apply',
          counts: expect.objectContaining({ services: 2 }),
        }),
      ]);
    });
  });

  describe('confirmar, resultado y configuración anterior', () => {
    it('confirmar → 303 al resultado, que muestra cambios, avisos y la configuración anterior', async () => {
      const f = fixtureJson('valid-full.json') as Record<string, unknown[]>;
      f.faqs!.push({ question: '¿Pregunta importada?', answer: 'Respuesta importada.' });
      const path = await uploaded(Buffer.from(JSON.stringify(f)));
      const page = await get(app, session, path);
      const res = await apply(path, page.body);
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe(`${path}/result`);

      const result = await get(app, session, `${path}/result`);
      expect(result.statusCode).toBe(200);
      expect(result.body).toContain('Añadido: <strong>¿Pregunta importada?</strong>');
      expect(result.body).toContain('Avisos vigentes');
      expect(result.body).toContain('href="/admin/config/pre-import"');
      expect(await readPreImport(t.db)).not.toBeNull();

      // Ya aplicada: no admite otra confirmación.
      expect((await apply(path, page.body)).statusCode).toBe(404);
      expect(events('config_import_applied')).toEqual([
        expect.objectContaining({
          sourceInstance: 'demo-01',
          formatVersion: 2,
          includesAlerts: false,
          criticalWarnings: 0,
          changes: expect.objectContaining({ faqs: { added: 1, modified: 0, removed: 0 } }),
        }),
      ]);
    });

    it('sin resultado → 404', async () => {
      const path = await uploaded(loadFixture('valid-full.json'));
      expect((await get(app, session, `${path}/result`)).statusCode).toBe(404);
    });

    it('cambio concurrente → 409 con vista previa nueva; después se puede confirmar', async () => {
      const f = fixtureJson('valid-full.json') as Record<string, unknown[]>;
      f.faqs!.push({ question: '¿Otra más?', answer: 'Sí.' });
      const path = await uploaded(Buffer.from(JSON.stringify(f)));
      const page = await get(app, session, path);
      const [first] = await t.db.select().from(faq).orderBy(faq.sortOrder);
      await updateFaq(t.deps, first?.id ?? '', { question: '¿Hay aparcamiento?', answer: 'Cambiada.' });

      const conflict = await apply(path, page.body);
      expect(conflict.statusCode).toBe(409);
      expect(conflict.body).toContain(
        'La configuración ha cambiado desde la vista previa; revisa los cambios y vuelve a confirmar',
      );
      expect(conflict.body).toContain('Respuesta: Cambiada. → Sí, en la calle de atrás.');
      expect(events('config_import_rejected')).toEqual([
        expect.objectContaining({ stage: 'confirm', reason: 'changed' }),
      ]);
      expect((await apply(path, conflict.body)).statusCode).toBe(303);
    });

    it('negocio activo con críticos: botón deshabilitado y 409 con el motivo', async () => {
      const f = fixtureJson('valid-full.json') as Record<string, Record<string, unknown> | null>;
      f.business!.phone = null;
      f.handoff = null;
      const path = await uploaded(Buffer.from(JSON.stringify(f)));
      const page = await get(app, session, path);
      expect(page.body).toContain('data-outcome="blocked_critical"');
      expect(page.body).toMatch(/<button type="submit" disabled>Confirmar la importación<\/button>/);
      const fingerprint = await configTablesFingerprint(t.db);
      const res = await apply(path, page.body);
      expect(res.statusCode).toBe(409);
      expect(res.body).toContain('avisos críticos');
      expect(await configTablesFingerprint(t.db)).toBe(fingerprint);
      expect(events('config_import_rejected')).toEqual([
        expect.objectContaining({ stage: 'confirm', reason: 'critical' }),
      ]);
    });

    it('cancelar → 303 a /admin/config con el aviso y la vista previa pasa a 404', async () => {
      const path = await uploaded(loadFixture('valid-full.json'));
      const res = await postForm(app, session, `${path}/cancel`);
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe('/admin/config');
      keepCookie(res);
      const index = await get(app, session, '/admin/config');
      expect(index.body).toContain('Importación cancelada; no se ha cambiado nada');
      expect((await get(app, session, path)).statusCode).toBe(404);
      // (Las subidas de otros casos que se desplazan al pasar de 5 salen como `expired`.)
      expect(events('config_import_cancelled').filter((e) => e.reason === 'operator')).toEqual([
        expect.objectContaining({ reason: 'operator', sourceInstance: 'demo-01' }),
      ]);
    });

    it('configuración anterior: 404 sin copia; 200 con el fichero guardado tal cual', async () => {
      expect((await get(app, session, '/admin/config/pre-import')).statusCode).toBe(404);
      const index = await get(app, session, '/admin/config');
      expect(index.body).toContain('Todavía no se ha aplicado ninguna importación');

      const empty = fixtureJson('valid-empty.json');
      empty.source = { instanceId: 'demo-01', schema: '0005_config_transfer' };
      const path = await uploaded(Buffer.from(JSON.stringify(empty)));
      await t.db.execute(`update business set status = 'draft'`);
      const page = await get(app, session, path);
      await apply(path, page.body);

      const copy = await readPreImport(t.db);
      const res = await get(app, session, '/admin/config/pre-import');
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
      expect(res.headers['content-disposition']).toMatch(
        /^attachment; filename="configuracion-anterior-\d{8}-\d{4}\.json"$/,
      );
      expect(res.body).toBe(copy?.content);

      const after = await get(app, session, '/admin/config');
      expect(after.body).toContain('Importación aplicada el');
      expect(after.body).toContain('<code>demo-01</code>');
      expect(after.body).toContain('Descargar la configuración anterior');
    });
  });

  describe('rechazos de la subida (US3)', () => {
    async function expectRejected(res: LightMyRequestResponse, status: number, reason: string) {
      expect(res.statusCode).toBe(status);
      expect(res.headers['content-type']).toContain('text/html');
      expect(events('config_import_rejected')).toEqual([
        expect.objectContaining({ stage: 'upload', reason }),
      ]);
    }

    it('sin fichero → 400 "Elige un fichero exportado desde el panel"', async () => {
      const res = await upload(null);
      await expectRejected(res, 400, 'no_file');
      expect(res.body).toContain('Elige un fichero exportado desde el panel');
    });

    it('5 MiB + 1 byte → 413 sin analizarlo', async () => {
      const fingerprint = await configTablesFingerprint(t.db);
      const res = await upload(Buffer.alloc(5 * 1024 * 1024 + 1, 0x20));
      await expectRejected(res, 413, 'too_large');
      expect(res.body).toContain('El fichero supera el tamaño máximo de 5 MB');
      expect(parse.parseConfigFile).not.toHaveBeenCalled();
      expect(await configTablesFingerprint(t.db)).toBe(fingerprint);
    });

    it.each([
      ['un .txt', Buffer.from('hola, esto no es una exportación'), 'unreadable', 'no es un JSON válido'],
      ['un JSON sin sobre', Buffer.from('{"business": {}}'), 'not_export', 'no es una exportación'],
      [
        'formatVersion 99',
        Buffer.from(JSON.stringify({ ...fixtureJson('valid-full.json'), formatVersion: 99 })),
        'future_version',
        'actualiza esta instancia a un núcleo con la migración',
      ],
    ])('%s → 422 con el motivo', async (_name, file, reason, text) => {
      const fingerprint = await configTablesFingerprint(t.db);
      const res = await upload(file);
      await expectRejected(res, 422, reason);
      expect(res.body).toContain(text);
      expect(await configTablesFingerprint(t.db)).toBe(fingerprint);
    });

    it('errores de validación → 422 con la lista completa agrupada por sección', async () => {
      const f = fixtureJson('valid-full.json') as Record<string, Array<Record<string, unknown>>>;
      f.services![0]!.priceCents = -1;
      f.resources![0]!.services = ['Servicio Z'];
      f.faqs![1]!.answer = '';
      const res = await upload(Buffer.from(JSON.stringify(f)));
      await expectRejected(res, 422, 'invalid');
      expect(events('config_import_rejected')[0]).toMatchObject({ issues: 3, sourceInstance: 'demo-01' });
      expect(res.body).toContain('El fichero no se puede importar: 3 errores');
      expect(res.body).toContain('<h3>Servicios</h3>');
      expect(res.body).toContain('<h3>Recursos</h3>');
      expect(res.body).toContain('<h3>Preguntas frecuentes</h3>');
      expect(res.body).toContain('<strong>«Servicio A»</strong>');
      expect(res.body).toContain('<code>priceCents</code>');
      expect(res.body).toContain('El servicio «Servicio Z» no está en el fichero');
    });

    it('el resto del panel sigue rechazando multipart y cuerpos urlencoded de más de 256 KiB', async () => {
      const { payload, contentType } = multipartBody([
        { name: '_csrf', value: session.csrf },
        { name: 'question', value: '¿Multipart?' },
        { name: 'answer', value: 'No.' },
      ]);
      const res = await app.inject({
        method: 'POST',
        url: '/admin/faqs',
        headers: { cookie: session.cookie, 'content-type': contentType },
        payload,
      });
      expect(res.statusCode).toBe(415);

      const big = await app.inject({
        method: 'POST',
        url: '/admin/faqs',
        headers: { cookie: session.cookie, 'content-type': 'application/x-www-form-urlencoded' },
        payload: encodeForm({ _csrf: session.csrf, question: 'x'.repeat(300 * 1024), answer: 'y' }),
      });
      expect(big.statusCode).toBe(413);
    });
  });
});

describe('Diseño del chat en exportar e importar (011, US5)', () => {
  let t: TestDatabase;
  let app: FastifyInstance;
  let session: Session;

  beforeAll(async () => {
    t = await createTestDatabase();
    app = await buildTestApp(t.db, 'postgres://no-usada', null, instanceEnv('produccion-01'));
  });
  afterAll(async () => {
    await app.close();
    await t.close();
  });
  beforeEach(async () => {
    await seedFullBusiness(t.deps, { webChatEnabled: false });
    session = await login(app);
  });

  function upload(file: Buffer) {
    const { payload, contentType } = multipartBody([
      { name: '_csrf', value: session.csrf },
      { name: 'file', value: file, filename: 'configuracion.json' },
    ]);
    return app.inject({
      method: 'POST',
      url: '/admin/config/import',
      headers: { cookie: session.cookie, 'content-type': contentType },
      payload,
    });
  }

  async function preview(file: Buffer) {
    const res = await upload(file);
    expect(res.statusCode).toBe(303);
    return get(app, session, res.headers.location ?? '');
  }

  it('la exportación trae formatVersion 2 y chatDesign (null sin diseño)', async () => {
    const empty = await postForm(app, session, '/admin/config/export');
    const file = JSON.parse(empty.body) as Record<string, unknown>;
    expect(file.formatVersion).toBe(2);
    expect(file).toHaveProperty('chatDesign', null);
    expect(Object.keys(file).indexOf('chatDesign')).toBe(Object.keys(file).indexOf('webChat') + 1);

    await seedChatDesignWithImages(t.db, { logo: 'valid.png' }, { shape: 'soft', chatName: 'Recepción' });
    const withDesign = JSON.parse((await postForm(app, session, '/admin/config/export')).body) as {
      chatDesign: Record<string, unknown> & { images: Record<string, unknown> };
    };
    expect(withDesign.chatDesign).toMatchObject({ shape: 'soft', chatName: 'Recepción' });
    expect(Object.keys(withDesign.chatDesign.images)).toEqual(['logo', 'avatar', 'icon']);
    expect(withDesign.chatDesign.images.logo).toMatchObject({ type: 'image/png' });
  });

  it('importar un fichero v1 en un destino con diseño anuncia que vuelve al aspecto original', async () => {
    await seedChatDesign(t.db, { shape: 'square' });
    const res = await preview(loadFixture('v1-full.json'));
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('data-section="chatDesign"');
    expect(res.body).toContain('Diseño del chat (vuelve al aspecto original)');
  });

  it('importar un fichero v2 muestra la sección "Diseño del chat" en la vista previa', async () => {
    const res = await preview(loadFixture('v2-chat-design.json'));
    expect(res.body).toContain('data-section="chatDesign"');
    expect(res.body).toMatch(/Color principal: #1f5fbf → #0b6e4f/);
    expect(res.body).toContain('Logo: — → Imagen (PNG, 64 × 64)');
  });

  it('un fichero con un diseño no válido se rechaza entero con errores por campo', async () => {
    const f = fixtureJson('v2-chat-design.json') as { chatDesign: Record<string, unknown> };
    f.chatDesign.size = 'huge';
    f.chatDesign.textColor = '#aaaaaa';
    const fingerprint = await configTablesFingerprint(t.db);
    const res = await upload(Buffer.from(JSON.stringify(f)));
    expect(res.statusCode).toBe(422);
    expect(res.body).toContain('Diseño del chat');
    expect(res.body).toContain('Valor no válido; se admite: &quot;small&quot;, &quot;medium&quot;, &quot;large&quot;');
    expect(res.body).toContain('tiene un contraste de');
    expect(await configTablesFingerprint(t.db)).toBe(fingerprint);
  });
});
