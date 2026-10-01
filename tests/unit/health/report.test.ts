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
      });
      expect(probe.read).not.toHaveBeenCalled();
    }
  });

  it('ok si el esquema aplicado es el esperado en índice, etiqueta y hash', async () => {
    expect(await build({ kind: 'known', schema: EXPECTED })).toEqual({
      status: 'ok',
      coreVersion: '1.4.0',
      schema: {
        applied: { index: 5, tag: '0005_config_transfer' },
        expected: { index: 5, tag: '0005_config_transfer' },
      },
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

  it('degraded si la BD no responde, sin el mensaje del error', async () => {
    const error = new Error('connect ECONNREFUSED 10.0.0.7:5432 password=s3creta');
    const report = await build(error);
    expect(report).toMatchObject({ status: 'degraded', coreVersion: '1.4.0' });
    expect(report.schema.applied).toBeNull();
    expect(JSON.stringify(report)).not.toMatch(/ECONNREFUSED|10\.0\.0\.7|s3creta/);
  });

  it('degraded si la BD tarda más que el tope', async () => {
    const started = Date.now();
    const report = await build('hang', ready(), 50);
    expect(report.status).toBe('degraded');
    expect(Date.now() - started).toBeLessThan(1000);
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
    });
    expect(Object.keys(view).sort()).toEqual(['coreVersion', 'instanceId', 'schema', 'status']);
    expect(fullView(report, null).instanceId).toBeNull();
  });
});
