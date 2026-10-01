/* eslint-disable @typescript-eslint/no-non-null-assertion -- los elementos existen por construcción del ejemplo; si no, el test debe fallar */
/**
 * FR-024 (contracts/transfer-log.md): los registros de exportar e importar solo llevan los
 * campos del catálogo, nunca valores de la configuración ni el nombre del fichero.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, get, loggedEvents, login, postForm, type Session } from '../../helpers/app.js';
import {
  FULL_ALERTS,
  fixtureJson,
  instanceEnv,
  loadFixture,
  multipartBody,
  seedFullBusiness,
} from '../../helpers/config-transfer.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';

const CATALOG: Record<string, string[]> = {
  config_exported: ['includesAlerts', 'counts'],
  config_import_previewed: ['sourceInstance', 'formatVersion', 'sameInstance', 'counts', 'changes', 'outcome'],
  config_import_applied: ['sourceInstance', 'formatVersion', 'includesAlerts', 'changes', 'criticalWarnings', 'warnings'],
  config_import_rejected: ['stage', 'reason', 'issues', 'sourceInstance'],
  config_import_cancelled: ['reason', 'sourceInstance'],
};

/** Campos que pone el propio logger en cada línea. */
const LOGGER_FIELDS = ['level', 'time', 'pid', 'hostname', 'reqId', 'msg', 'channel', 'event'];

/** Valores de la configuración de prueba que nunca pueden salir en un registro. */
const SENSITIVE = [
  'Negocio de ejemplo',
  'Calle Mayor',
  'maps.example.com',
  '+34910123456',
  '910123456',
  'hola@example.com',
  'Servicio A',
  'Servicio B',
  'Descripción del servicio',
  'Recurso 1',
  'aparcamiento',
  'calle de atrás',
  'tarjeta',
  'Avisa con un día',
  'Efectivo',
  'atencion@example.com',
  'www.example.com',
  'privacidad',
  FULL_ALERTS.whatsapp,
  FULL_ALERTS.email,
  'Navidad',
  'Formación',
  'mi-configuracion-secreta.json',
];

describe('registros de exportar e importar sin datos (FR-024)', () => {
  let t: TestDatabase;
  let app: FastifyInstance;
  let session: Session;
  const lines: string[] = [];

  beforeAll(async () => {
    t = await createTestDatabase();
    app = await buildTestApp(t.db, 'postgres://no-usada', null, instanceEnv('produccion-01'), lines);
    await seedFullBusiness(t.deps, { alerts: FULL_ALERTS, webChatEnabled: false });
    session = await login(app);
  });
  afterAll(async () => {
    await app.close();
    await t.close();
  });

  const upload = (file: Buffer) => {
    const { payload, contentType } = multipartBody([
      { name: '_csrf', value: session.csrf },
      { name: 'file', value: file, filename: 'mi-configuracion-secreta.json' },
    ]);
    return app.inject({
      method: 'POST',
      url: '/admin/config/import',
      headers: { cookie: session.cookie, 'content-type': contentType },
      payload,
    });
  };

  it('ningún evento config_* lleva valores de la configuración, solo campos del catálogo', async () => {
    // Exportar con y sin destinos.
    await postForm(app, session, '/admin/config/export');
    await postForm(app, session, '/admin/config/export', { include_alerts: 'on' });

    // Subida inválida (con los textos en los errores) y versión futura.
    const invalid = fixtureJson('valid-full-with-alerts.json') as Record<string, Array<Record<string, unknown>>>;
    invalid.services![0]!.priceCents = -1;
    invalid.resources![0]!.services = ['Servicio A inexistente'];
    await upload(Buffer.from(JSON.stringify(invalid)));
    await upload(Buffer.from(JSON.stringify({ ...fixtureJson('valid-full.json'), formatVersion: 9 })));
    await upload(Buffer.from('no es json: Negocio de ejemplo +34910123456'));

    // Vista previa con destinos, cambio concurrente rechazado, aplicación y cancelación.
    const changed = fixtureJson('valid-full-with-alerts.json') as Record<string, Array<Record<string, unknown>>>;
    changed.faqs!.push({ question: '¿Pregunta con +34910123456?', answer: 'Escribe a hola@example.com' });
    const path = (await upload(Buffer.from(JSON.stringify(changed)))).headers.location ?? '';
    const page = await get(app, session, `${path}?alerts=1`);
    const base = /name="base" value="([^"]+)"/.exec(page.body)?.[1] ?? '';
    await postForm(app, session, `${path}/apply`, { base: 'huella-antigua', include_alerts: '1' });
    await postForm(app, session, `${path}/apply`, { base, include_alerts: '1' });

    const other = (await upload(loadFixture('valid-full.json'))).headers.location ?? '';
    await get(app, session, other);
    await postForm(app, session, `${other}/cancel`);

    const events = loggedEvents(lines, 'config');
    expect(new Set(events.map((e) => e.event))).toEqual(new Set(Object.keys(CATALOG)));
    for (const event of events) {
      const allowed = [...LOGGER_FIELDS, ...(CATALOG[String(event.event)] ?? [])];
      expect(Object.keys(event).filter((k) => !allowed.includes(k)), String(event.event)).toEqual([]);
      const text = JSON.stringify(event);
      for (const value of SENSITIVE) expect(text, `${String(event.event)}: ${value}`).not.toContain(value);
    }
  });
});
