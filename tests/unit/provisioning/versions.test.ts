/**
 * Informe de versiones del parque (009, contracts/instance-versions-command.md): clasificación de
 * cada fila con su prioridad, comparación con lo anotado, URL permitidas, tabla, JSON, código de
 * salida y plan de anotación. Sin red: las respuestas se dan ya leídas.
 */
import { describe, expect, it } from 'vitest';
import {
  allowedUrl,
  annotatedVersion,
  annotationPlan,
  applyAnnotations,
  classify,
  computeMatch,
  exitCode,
  renderJson,
  renderTable,
  type QueryOutcome,
  type VersionRow,
  type VersionsReport,
} from '../../../src/provisioning/versions.js';
import type { Instance } from '../../../src/provisioning/inventory.js';
import { productionEnv, sampleInventory, instanceFromEnv } from '../../helpers/provisioning.js';

const SECRET = '6c3f8a1d4b7e2095f1a3c5e7092b4d6f8a0c2e4f6183a5c7e9b1d3f5a7c9e0c8';

const instance = (overrides: Partial<Instance> = {}): Instance => ({
  ...instanceFromEnv(productionEnv('demo-01')),
  imageVersion: 'chatbot:1.4.0',
  ...overrides,
});

const full = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    status: 'ok',
    instanceId: 'demo-01',
    coreVersion: '1.4.0',
    schema: {
      applied: { index: 5, tag: '0005_config_transfer' },
      expected: { index: 5, tag: '0005_config_transfer' },
    },
    ...overrides,
  });

const response = (status: number, body: string | null, secretSent = true): QueryOutcome => ({
  kind: 'response',
  status,
  body,
  secretSent,
});

describe('annotatedVersion', () => {
  it('extrae la versión semántica de la anotación', () => {
    expect(annotatedVersion('chatbot:1.4.0')).toBe('1.4.0');
    expect(annotatedVersion('1.3.0')).toBe('1.3.0');
  });
  it('sin anotación o sin versión semántica → null', () => {
    expect(annotatedVersion(null)).toBeNull();
    expect(annotatedVersion('chatbot:latest')).toBeNull();
  });
});

describe('computeMatch', () => {
  it('igual → true; distinta → false', () => {
    expect(computeMatch('1.4.0', 'chatbot:1.4.0')).toBe(true);
    expect(computeMatch('1.3.0', 'chatbot:1.4.0')).toBe(false);
  });
  it('anotación sin versión semántica → false', () => {
    expect(computeMatch('1.4.0', 'chatbot:latest')).toBe(false);
  });
  it('sin observada o sin anotada → null', () => {
    expect(computeMatch(null, 'chatbot:1.4.0')).toBeNull();
    expect(computeMatch('1.4.0', null)).toBeNull();
  });
});

describe('allowedUrl', () => {
  it('https sí', () => {
    expect(allowedUrl('https://demo-01.ejemplo.com', false)).toEqual({
      url: 'https://demo-01.ejemplo.com/health',
    });
  });
  it('sin URL → no_url', () => {
    expect(allowedUrl(null, false)).toEqual({ reason: 'no_url' });
  });
  it('http solo con --allow-insecure y localhost, 127.0.0.1 o [::1]', () => {
    expect(allowedUrl('http://localhost:3000', false)).toEqual({ reason: 'not_https' });
    expect(allowedUrl('http://localhost:3000', true)).toEqual({
      url: 'http://localhost:3000/health',
    });
    expect(allowedUrl('http://127.0.0.1:4000', true)).toEqual({
      url: 'http://127.0.0.1:4000/health',
    });
    expect(allowedUrl('http://[::1]:4000', true)).toEqual({ url: 'http://[::1]:4000/health' });
    expect(allowedUrl('http://demo.ejemplo.com', true)).toEqual({ reason: 'not_https' });
  });
  it('credenciales en la URL o URL no válida → rechazada', () => {
    expect(allowedUrl('https://u:p@demo.ejemplo.com', false)).toEqual({ reason: 'not_https' });
    expect(allowedUrl('no es una url', false)).toEqual({ reason: 'not_https' });
    expect(allowedUrl('ftp://demo.ejemplo.com', true)).toEqual({ reason: 'not_https' });
  });
});

describe('classify (prioridad del contrato)', () => {
  const row = (outcome: QueryOutcome, overrides: Partial<Instance> = {}) =>
    classify(instance(overrides), outcome);

  it('not_queried con su motivo', () => {
    expect(row({ kind: 'not_queried', reason: 'no_url' })).toMatchObject({
      result: 'not_queried',
      reason: 'no_url',
      review: true,
    });
    expect(row({ kind: 'not_queried', reason: 'not_https' }).reason).toBe('not_https');
  });

  it('error de red o tiempo → unreachable', () => {
    expect(row({ kind: 'error' })).toMatchObject({ result: 'unreachable', coreVersion: null });
  });

  it.each([
    [404, 'no_health'],
    [401, 'auth_failed'],
    [429, 'rate_limited'],
    [301, 'invalid_response'],
    [302, 'invalid_response'],
    [500, 'invalid_response'],
    [502, 'unreachable'],
    [504, 'unreachable'],
  ])('código %i → %s', (status, result) => {
    expect(row(response(status, '{}')).result).toBe(result);
  });

  it('respuesta no JSON, de más de 4 KiB o sin el contrato → invalid_response', () => {
    expect(row(response(200, '<html>')).result).toBe('invalid_response');
    expect(row(response(200, null)).result).toBe('invalid_response');
    expect(row(response(200, full({ coreVersion: 'latest' }))).result).toBe('invalid_response');
    expect(row(response(200, full({ extra: 1 }))).result).toBe('invalid_response');
    // Código y estado incoherentes.
    expect(row(response(200, full({ status: 'degraded' }))).result).toBe('invalid_response');
    expect(row(response(503, full())).result).toBe('invalid_response');
  });

  it('sin secreto en el equipo del operador → status_only con no_secret', () => {
    expect(row(response(200, '{"status":"ok"}', false))).toMatchObject({
      result: 'status_only',
      reason: 'no_secret',
      status: 'ok',
      coreVersion: null,
      review: true,
    });
    expect(row(response(503, '{"status":"degraded"}', false)).status).toBe('degraded');
  });

  it('instanceId distinto → identity_mismatch sin versión ni id recibido', () => {
    const r = row(response(200, full({ instanceId: 'otro-cliente' })));
    expect(r).toMatchObject({
      result: 'identity_mismatch',
      status: null,
      coreVersion: null,
      schema: null,
      matches: null,
      review: true,
    });
    expect(JSON.stringify(r)).not.toContain('otro-cliente');
    expect(row(response(200, full({ instanceId: null }))).result).toBe('identity_mismatch');
  });

  it('ok con la versión anotada → no exige revisión', () => {
    expect(row(response(200, full()))).toEqual({
      id: 'demo-01',
      client: 'Cliente demo-01',
      result: 'ok',
      reason: null,
      status: 'ok',
      coreVersion: '1.4.0',
      schema: { applied: '0005_config_transfer', expected: '0005_config_transfer' },
      annotated: 'chatbot:1.4.0',
      matches: true,
      review: false,
      spendCap: null,
    });
  });

  it('ok con otra versión anotada o sin anotar → revisión', () => {
    expect(row(response(200, full()), { imageVersion: '1.3.0' })).toMatchObject({
      matches: false,
      review: true,
    });
    expect(row(response(200, full()), { imageVersion: null })).toMatchObject({
      matches: null,
      review: true,
    });
  });

  it('degraded y not_ready con versiones', () => {
    const degraded = row(
      response(
        503,
        full({
          status: 'degraded',
          schema: {
            applied: { index: 6, tag: null },
            expected: { index: 5, tag: '0005_config_transfer' },
          },
        }),
      ),
    );
    expect(degraded).toMatchObject({
      result: 'degraded',
      schema: { applied: 'desconocida (#6)', expected: '0005_config_transfer' },
      review: true,
    });
    const notReady = row(
      response(
        503,
        full({
          status: 'not_ready',
          schema: { applied: null, expected: { index: 5, tag: '0005_config_transfer' } },
        }),
      ),
    );
    expect(notReady).toMatchObject({ result: 'not_ready', schema: { applied: null } });
  });
});

const report = (rows: VersionRow[]): VersionsReport => ({
  checkedAt: '2026-10-01T10:00:00.000Z',
  ok: rows.every((r) => !r.review),
  instances: rows,
});

describe('salida', () => {
  const ok = classify(instance(), response(200, full()));
  const other = classify(
    instance({ id: 'demo-02', client: 'Cliente B', imageVersion: '1.4.0' }),
    response(200, full({ instanceId: 'demo-02', coreVersion: '1.3.0' })),
  );
  const down = classify(instance({ id: 'demo-03', client: 'Cliente C' }), { kind: 'error' });
  const crossed = classify(
    instance({ id: 'demo-04', client: 'Cliente D' }),
    response(200, full({ instanceId: 'demo-01' })),
  );
  const noHealth = classify(instance({ id: 'demo-05' }), response(404, 'Not Found'));

  it('tabla con las columnas y textos del contrato y el recuento', () => {
    const text = renderTable(report([ok, other, down, crossed, noHealth]));
    const lines = text.split('\n');
    expect(lines[0]).toMatch(
      /^Instancia\s+Cliente\s+Estado\s+Núcleo\s+Esquema\s+Anotada\s+Coincide\s+Tope$/,
    );
    expect(text).toMatch(
      /demo-01\s+Cliente demo-01\s+Correcto\s+1\.4\.0\s+0005_config_transfer\s+chatbot:1\.4\.0\s+sí/,
    );
    expect(text).toMatch(/demo-02\s+Cliente B\s+Correcto\s+1\.3\.0\s+.*NO/);
    expect(text).toMatch(/demo-03\s+Cliente C\s+No responde\s+—\s+—/);
    expect(text).toMatch(/demo-04\s+Cliente D\s+Identidad distinta\s+—/);
    expect(text).toContain('Sin información de versión');
    expect(text).toContain('4 de 5 instancias requieren revisión.');
  });

  it('textos del resto de resultados', () => {
    const rows = [
      classify(instance(), response(401, '')),
      classify(instance(), response(429, '')),
      classify(instance(), response(200, 'x')),
      classify(instance(), response(200, '{"status":"ok"}', false)),
      classify(instance(), { kind: 'not_queried', reason: 'not_https' }),
      classify(instance(), response(503, full({ status: 'degraded' }))),
      classify(instance(), response(503, full({ status: 'not_ready' }))),
      classify(instance({ imageVersion: null }), response(200, full())),
    ];
    const text = renderTable(report(rows));
    for (const label of [
      'Secreto rechazado',
      'Límite de peticiones',
      'Respuesta no válida',
      'Solo estado',
      'No consultada',
      'Degradado',
      'No lista',
      'sin anotar',
    ]) {
      expect(text).toContain(label);
    }
  });

  it('todo correcto → recuento sin revisión; sin instancias → mensaje', () => {
    expect(renderTable(report([ok]))).toContain(
      'Todas las instancias están correctas y coinciden con lo anotado.',
    );
    expect(renderTable(report([]))).toBe('No hay instancias activas en el inventario.');
  });

  it('JSON con la forma exacta', () => {
    const parsed = JSON.parse(renderJson(report([ok, down]))) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(['checkedAt', 'ok', 'instances']);
    expect(parsed.ok).toBe(false);
    expect((parsed.instances as unknown[])[0]).toEqual({
      id: 'demo-01',
      client: 'Cliente demo-01',
      result: 'ok',
      reason: null,
      status: 'ok',
      coreVersion: '1.4.0',
      schema: { applied: '0005_config_transfer', expected: '0005_config_transfer' },
      annotated: 'chatbot:1.4.0',
      matches: true,
      review: false,
      spendCap: null,
    });
  });

  it('código de salida: 0 sin nada que revisar, 1 si hay algo', () => {
    expect(exitCode(report([ok]))).toBe(0);
    expect(exitCode(report([]))).toBe(0);
    expect(exitCode(report([ok, down]))).toBe(1);
  });

  it('ningún secreto en tabla ni JSON', () => {
    const r = report([ok, other, down, crossed, noHealth]);
    expect(renderTable(r)).not.toContain(SECRET);
    expect(renderJson(r)).not.toContain(SECRET);
  });
});

describe('anotación (R6)', () => {
  const { inventory } = sampleInventory(2);
  const [first, second] = inventory.instances as [Instance, Instance];
  const rows = [
    classify({ ...first, imageVersion: '1.3.0' }, response(200, full({ instanceId: first.id }))),
    classify({ ...second, imageVersion: '1.4.0' }, response(200, full({ instanceId: second.id }))),
  ];
  const withAnnotations = {
    ...inventory,
    instances: [
      { ...first, imageVersion: '1.3.0' },
      { ...second, imageVersion: '1.4.0' },
    ],
  };

  it('solo filas ok de identidad correcta con versión distinta', () => {
    const down = classify(first, { kind: 'error' });
    const crossed = classify(first, response(200, full({ instanceId: 'otra' })));
    const degraded = classify(
      { ...first, imageVersion: '1.0.0' },
      response(503, full({ instanceId: first.id, status: 'degraded' })),
    );
    expect(annotationPlan(report([...rows, down, crossed, degraded]))).toEqual([
      { id: first.id, from: '1.3.0', to: '1.4.0' },
    ]);
  });

  it('escribe solo imageVersion y no pisa una anotación que cambió', () => {
    const plan = [
      { id: first.id, from: '1.3.0', to: '1.4.0' },
      { id: second.id, from: '1.2.0', to: '1.4.0' },
    ];
    const result = applyAnnotations(withAnnotations, plan);
    expect(result.applied).toEqual([first.id]);
    expect(result.skipped).toEqual([second.id]);
    const updated = result.inventory.instances.find((i) => i.id === first.id);
    expect(updated).toEqual({ ...first, imageVersion: '1.4.0' });
    expect(result.inventory.instances.find((i) => i.id === second.id)?.imageVersion).toBe('1.4.0');
  });
});

describe('estado del tope de gasto (010, contracts/health-spend-cap.md)', () => {
  const withCap = (spendCap: unknown, id = 'demo-01') =>
    classify(
      instance({ id }),
      response(200, full({ instanceId: id, ...(spendCap === undefined ? {} : { spendCap }) })),
    );

  it('lee spendCap del informe; ausente, nulo o desconocido → null sin invalidar la fila', () => {
    for (const level of ['none', 'normal', 'warning', 'reached'] as const) {
      expect(withCap(level)).toMatchObject({ result: 'ok', spendCap: level });
    }
    for (const value of [undefined, null, 'otro', 42]) {
      expect(withCap(value)).toMatchObject({ result: 'ok', spendCap: null });
    }
  });

  it('columna Tope al final con el texto del contrato', () => {
    const rows = [
      withCap('none', 'demo-01'),
      withCap('normal', 'demo-02'),
      withCap('warning', 'demo-03'),
      withCap('reached', 'demo-04'),
      withCap(undefined, 'demo-05'),
      classify(instance({ id: 'demo-06' }), { kind: 'error' }),
    ];
    const lines = renderTable(report(rows)).split('\n');
    const tope = (id: string) =>
      lines
        .find((l) => l.startsWith(id))
        ?.trim()
        .split(/\s{2,}/)
        .at(-1);
    expect(tope('demo-01')).toBe('sin tope');
    expect(tope('demo-02')).toBe('normal');
    expect(tope('demo-03')).toBe('≥80 %');
    expect(tope('demo-04')).toBe('alcanzado');
    expect(tope('demo-05')).toBe('—');
    expect(tope('demo-06')).toBe('—');
  });

  it('spendCap en --json, al final de cada fila', () => {
    const parsed = JSON.parse(renderJson(report([withCap('warning')]))) as {
      instances: Array<Record<string, unknown>>;
    };
    expect(parsed.instances[0]?.spendCap).toBe('warning');
    expect(Object.keys(parsed.instances[0] ?? {}).at(-1)).toBe('spendCap');
  });

  it('no cambia la clasificación, el código de salida ni la anotación', () => {
    const reached = withCap('reached');
    const none = withCap('none');
    expect(reached).toMatchObject({ result: 'ok', review: false });
    expect({ ...reached, spendCap: null }).toEqual({ ...none, spendCap: null });
    expect(exitCode(report([reached]))).toBe(0);
    expect(annotationPlan(report([reached]))).toEqual(annotationPlan(report([none])));
  });
});
