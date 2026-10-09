import { describe, expect, it, vi } from 'vitest';
import type { SchemaVersion } from '../../../src/backup/schema-version.js';
import { createLifecycle, type Lifecycle } from '../../../src/health/lifecycle.js';
import {
  buildHealthReport,
  fullView,
  publicView,
  type ProbeResult,
} from '../../../src/health/report.js';

const EXPECTED: SchemaVersion = { index: 5, tag: '0005_config_transfer', hash: 'h5' };

const ready = (): Lifecycle => {
  const lifecycle = createLifecycle();
  lifecycle.markReady();
  return lifecycle;
};

const probeOf = (result: ProbeResult | Error | 'hang') => ({
  read: vi.fn(() => {
    if (result === 'hang') return new Promise<ProbeResult>(() => undefined);
    if (result instanceof Error) return Promise.reject(result);
    return Promise.resolve(result);
  }),
});

const build = (result: ProbeResult | Error | 'hang', lifecycle = ready(), timeoutMs = 2000) =>
  buildHealthReport({
    lifecycle,
    probe: probeOf(result),
    coreVersion: '1.4.0',
    expected: EXPECTED,
    timeoutMs,
  });

describe('buildHealthReport (009, R3)', () => {
  it('not_ready sin consultar la BD mientras arranca o se para', async () => {
    for (const lifecycle of [
      createLifecycle(),
      (() => {
        const l = ready();
        l.markStopping();
        return l;
      })(),
    ]) {
      const probe = probeOf({ kind: 'known', schema: EXPECTED });
      const report = await buildHealthReport({
        lifecycle,
        probe,
        coreVersion: '1.4.0',
        expected: EXPECTED,
      });
      expect(report).toEqual({
        status: 'not_ready',
        coreVersion: '1.4.0',
        schema: { applied: null, expected: { index: 5, tag: '0005_config_transfer' } },
        spendCap: null,
      });
      expect(probe.read).not.toHaveBeenCalled();
    }
  });

  it('ok si el esquema aplicado es el esperado en índice, etiqueta y hash', async () => {
    expect(await build({ kind: 'known', schema: EXPECTED, spendCap: 'none' })).toEqual({
      status: 'ok',
      coreVersion: '1.4.0',
      schema: {
        applied: { index: 5, tag: '0005_config_transfer' },
        expected: { index: 5, tag: '0005_config_transfer' },
      },
      spendCap: 'none',
    });
  });

  it.each([
    ['índice anterior', { index: 4, tag: '0004_handoff', hash: 'h4' }],
    ['hash distinto (migración editada)', { ...EXPECTED, hash: 'otro' }],
    ['etiqueta distinta', { ...EXPECTED, tag: '0005_otra' }],
  ])('degraded con esquema distinto: %s', async (_name, schema) => {
    const report = await build({ kind: 'known', schema });
    expect(report.status).toBe('degraded');
    expect(report.schema.applied).toEqual({ index: schema.index, tag: schema.tag });
  });

  it('degraded con migración desconocida: índice adelantado y etiqueta null', async () => {
    const report = await build({ kind: 'unknown', index: 6 });
    expect(report.status).toBe('degraded');
    expect(report.schema.applied).toEqual({ index: 6, tag: null });
  });

  it('degraded con la BD vacía', async () => {
    const report = await build({ kind: 'empty' });
    expect(report).toMatchObject({ status: 'degraded', schema: { applied: null } });
  });

  /**
   * 016 (T011, FR-003): la BD que **no contesta** dejó de ser `degraded` y pasó a
   * `db_unavailable`, que viaja con HTTP 200. `degraded` queda para lo que necesita al operador:
   * la BD contesta pero su esquema no es el que debe. La diferencia importa porque `degraded`
   * (503) es, para la sonda del contenedor, un motivo de reinicio, y reiniciar durante un corte
   * de la base de datos es justamente el bucle que esta corrección elimina.
   */
  it('db_unavailable si la BD no responde, sin el mensaje del error', async () => {
    const error = new Error('connect ECONNREFUSED 10.0.0.7:5432 password=s3creta');
    const report = await build(error);
    expect(report).toMatchObject({ status: 'db_unavailable', coreVersion: '1.4.0' });
    expect(report.schema.applied).toBeNull();
    expect(JSON.stringify(report)).not.toMatch(/ECONNREFUSED|10\.0\.0\.7|s3creta/);
  });

  it('db_unavailable si la BD tarda más que el tope', async () => {
    const started = Date.now();
    const report = await build('hang', ready(), 50);
    expect(report.status).toBe('db_unavailable');
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('db_unavailable deja applied y spendCap en null, y conserva lo que no sale de la BD', async () => {
    const report = await build(new Error('ECONNREFUSED'));
    expect(report.schema.applied).toBeNull();
    expect(report.spendCap).toBeNull();
    // Se leen del núcleo, no de la base de datos: siguen valiendo durante el corte.
    expect(report.coreVersion).toBe('1.4.0');
    expect(report.schema.expected).toEqual({ index: 5, tag: '0005_config_transfer' });
  });

  it('el estado nuevo no lleva nada de la dirección de la base de datos (FR-012)', async () => {
    const url = 'postgres://operador:secreta@/chatbot?host=/var/run/postgresql';
    const report = await build(Object.assign(new Error(`no such file ${url}`), { code: 'ENOENT' }));
    const dump = JSON.stringify([report, publicView(report), fullView(report, 'inst-1')]);
    for (const secret of ['operador', 'secreta', 'chatbot', '/var/run/postgresql']) {
      expect(dump).not.toContain(secret);
    }
  });

  const answers: Array<[string, ProbeResult]> = [
    ['BD vacía', { kind: 'empty' }],
    ['migración desconocida', { kind: 'unknown', index: 9 }],
    ['esquema distinto', { kind: 'known', schema: { index: 4, tag: '0004_handoff', hash: 'h4' } }],
  ];

  it.each(answers)('sigue en degraded cuando la BD sí contesta: %s', async (_name, result) => {
    const report = await build(result);
    expect(report.status).toBe('degraded');
  });

  it('las dos vistas publican el estado nuevo tal cual', async () => {
    const report = await build(new Error('ECONNREFUSED'));
    expect(publicView(report)).toEqual({ status: 'db_unavailable' });
    expect(fullView(report, 'inst-1')).toMatchObject({
      status: 'db_unavailable',
      instanceId: 'inst-1',
      schema: { applied: null },
      spendCap: null,
    });
  });

  it('no escribe nada en la consola', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    await build(new Error('fallo de la BD'));
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
  });
});

describe('vistas del informe', () => {
  it('publicView solo devuelve el estado', async () => {
    const report = await build({ kind: 'known', schema: EXPECTED });
    expect(publicView(report)).toEqual({ status: 'ok' });
  });

  it('fullView devuelve solo los campos del contrato', async () => {
    const report = await build({ kind: 'unknown', index: 6 });
    const view = fullView(report, 'demo-01');
    expect(view).toEqual({
      status: 'degraded',
      instanceId: 'demo-01',
      coreVersion: '1.4.0',
      schema: {
        applied: { index: 6, tag: null },
        expected: { index: 5, tag: '0005_config_transfer' },
      },
      spendCap: null,
    });
    expect(Object.keys(view)).toEqual([
      'status',
      'instanceId',
      'coreVersion',
      'schema',
      'spendCap',
    ]);
    expect(fullView(report, null).instanceId).toBeNull();
  });
});

describe('estado del tope de gasto en el informe (010, FR-023a)', () => {
  it.each(['none', 'normal', 'warning', 'reached'] as const)(
    'con el esquema esperado lleva %s y el estado sigue ok',
    async (level) => {
      const report = await build({ kind: 'known', schema: EXPECTED, spendCap: level });
      expect(report).toMatchObject({ status: 'ok', spendCap: level });
    },
  );

  it('null si el sondeo no lo pudo leer', async () => {
    expect((await build({ kind: 'known', schema: EXPECTED, spendCap: null })).spendCap).toBeNull();
  });

  it('null si el esquema no es el esperado, aunque el sondeo traiga un valor', async () => {
    const report = await build({
      kind: 'known',
      schema: { ...EXPECTED, hash: 'otro' },
      spendCap: 'reached',
    });
    expect(report).toMatchObject({ status: 'degraded', spendCap: null });
  });

  it('null si la BD no responde o está vacía', async () => {
    expect((await build(new Error('caída'))).spendCap).toBeNull();
    expect((await build({ kind: 'empty' })).spendCap).toBeNull();
  });

  it('solo la vista completa lo muestra, sin importes ni moneda', async () => {
    const report = await build({ kind: 'known', schema: EXPECTED, spendCap: 'warning' });
    expect(publicView(report)).toEqual({ status: 'ok' });
    const view = fullView(report, 'demo-01');
    expect(view.spendCap).toBe('warning');
    expect(JSON.stringify(view)).not.toMatch(/currency|cents|pico|percent|price/i);
  });
});
