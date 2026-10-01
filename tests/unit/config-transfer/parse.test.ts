/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- JSON crudo del fichero de ejemplo, manipulado a propósito */
/** Lectura de un fichero subido (008, research R3 y R4): BOM, JSON, sobre, versiones y errores. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfigFile, type ParseOptions } from '../../../src/config-transfer/parse.js';

const FIXTURES = join(import.meta.dirname, '..', '..', 'fixtures', 'config');
const bytes = (name: string) => readFileSync(join(FIXTURES, name));
const OPTIONS: ParseOptions = { phoneRegion: 'ES' };

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const encode = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8');

function variant(change: (file: Json) => void): Buffer {
  const file = JSON.parse(bytes('valid-full.json').toString('utf8')) as Json;
  change(file);
  return encode(file);
}

describe('parseConfigFile', () => {
  it('acepta el BOM y lo descarta', () => {
    const withBom = parseConfigFile(bytes('valid-bom.json'), OPTIONS);
    const plain = parseConfigFile(bytes('valid-full.json'), OPTIONS);
    expect(withBom.ok).toBe(true);
    expect(withBom).toEqual(plain);
  });

  it('bytes que no son JSON → un único error unreadable', () => {
    for (const input of [Buffer.from('esto no es json'), Buffer.from([0xff, 0xfe, 0x00])]) {
      const result = parseConfigFile(input, OPTIONS);
      expect(result).toMatchObject({ ok: false, reason: 'unreadable' });
      if (result.ok) return;
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0]).toMatchObject({
        section: 'file',
        sectionLabel: 'Fichero',
        item: null,
        field: null,
        code: 'unreadable',
      });
    }
  });

  it('JSON sin sobre o con otro format → not_export', () => {
    for (const value of [{ hola: 1 }, [1, 2], 'texto', { format: 'otra-cosa', formatVersion: 1 }]) {
      const result = parseConfigFile(encode(value), OPTIONS);
      expect(result).toMatchObject({ ok: false, reason: 'not_export' });
      if (!result.ok) expect(result.issues[0]?.code).toBe('not_export');
    }
  });

  it('formatVersion 99 → future_version con el esquema de origen en el mensaje', () => {
    const result = parseConfigFile(
      variant((f) => {
        f.formatVersion = 99;
        f.source.schema = '0042_futura';
      }),
      OPTIONS,
    );
    expect(result).toMatchObject({ ok: false, reason: 'future_version', sourceInstance: 'demo-01' });
    if (result.ok) return;
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.message).toContain(
      'actualiza esta instancia a un núcleo con la migración «0042_futura» o posterior',
    );
  });

  it('formatVersion 0 o no entero → unsupported_version', () => {
    for (const version of [0, 1.5, '1', null]) {
      const result = parseConfigFile(variant((f) => (f.formatVersion = version)), OPTIONS);
      expect(result).toMatchObject({ ok: false, reason: 'unsupported_version' });
    }
  });

  it('con una cadena de actualizadores v0 → v1, un fichero v0 se actualiza y se valida', () => {
    // Versión 0 inventada: la moneda iba en `money` en lugar de `business.currency`.
    const v0 = variant((f) => {
      f.formatVersion = 0;
      f.money = f.business.currency;
      delete f.business.currency;
    });
    const updaters = {
      0: (raw: unknown) => {
        const { money, ...rest } = raw as Json;
        return { ...rest, formatVersion: 1, business: { ...rest.business, currency: money } };
      },
    };
    const result = parseConfigFile(v0, { ...OPTIONS, updaters });
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.fileVersion).toBe(0);
    expect(result.envelope.formatVersion).toBe(0);
    expect(result.document.business.currency).toBe('EUR');

    // Sin su actualizador, la misma versión no se admite.
    expect(parseConfigFile(v0, OPTIONS)).toMatchObject({ reason: 'unsupported_version' });
    // Y lo que devuelve el actualizador pasa por el esquema actual.
    const broken = parseConfigFile(v0, { ...OPTIONS, updaters: { 0: (raw) => raw } });
    expect(broken).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('devuelve todos los errores a la vez, en el orden del fichero', () => {
    const result = parseConfigFile(
      variant((f) => {
        f.webChat.dailyCap = 0;
        f.services[0].priceCents = -1;
        f.resources[0].services = ['Servicio Z'];
        f.business.email = 'x';
        f.faqs[1].question = '';
      }),
      OPTIONS,
    );
    expect(result).toMatchObject({ ok: false, reason: 'invalid', sourceInstance: 'demo-01' });
    if (result.ok) return;
    expect(result.issues.map((i) => [i.section, i.sectionLabel, i.item, i.field])).toEqual([
      ['business', 'Datos del negocio', null, 'email'],
      ['services', 'Servicios', '«Servicio A»', 'priceCents'],
      ['resources', 'Recursos', '«Recurso 1»', 'services[0]'],
      ['faqs', 'Preguntas frecuentes', 'n.º 2', 'question'],
      ['webChat', 'Chat web', null, 'dailyCap'],
    ]);
    for (const issue of result.issues) expect(issue.message).toMatch(/^[A-ZÁÉÍÓÚ]/);
  });

  it('errores en secciones distintas con elemento, campo y sección (US3)', () => {
    const result = parseConfigFile(
      variant((f) => {
        f.services[0].priceCents = -1;
        f.resources[0].services = ['Servicio inexistente'];
        f.closures[0].endTime = '08:00';
      }),
      OPTIONS,
    );
    if (result.ok) throw new Error('debería fallar');
    expect(result.issues).toEqual([
      {
        section: 'closures',
        sectionLabel: 'Cierres',
        item: 'n.º 1',
        field: 'endTime',
        message: 'La hora de fin debe ser posterior a la de inicio',
      },
      {
        section: 'services',
        sectionLabel: 'Servicios',
        item: '«Servicio A»',
        field: 'priceCents',
        message: 'El importe debe ser un número entero de céntimos, 0 o más',
      },
      {
        section: 'resources',
        sectionLabel: 'Recursos',
        item: '«Recurso 1»',
        field: 'services[0]',
        message: 'El servicio «Servicio inexistente» no está en el fichero',
      },
    ]);
  });

  it('un elemento sin nombre se identifica por su posición', () => {
    const result = parseConfigFile(
      variant((f) => {
        f.services[1].name = '';
        f.resources.push({ name: 5, active: true, services: [], hours: [], absences: [] });
      }),
      OPTIONS,
    );
    if (result.ok) throw new Error('debería fallar');
    expect(result.issues.map((i) => [i.item, i.field])).toEqual([
      ['n.º 2', 'name'],
      ['n.º 2', 'name'],
    ]);
    expect(result.issues.map((i) => i.section)).toEqual(['services', 'resources']);
  });

  it('un sourceInstance que no cumple el patrón no llega al resultado', () => {
    const result = parseConfigFile(
      variant((f) => {
        f.source.instanceId = 'Otro Texto <script>';
        f.formatVersion = 99;
      }),
      OPTIONS,
    );
    expect(result).toMatchObject({ ok: false, sourceInstance: null });
  });
});
