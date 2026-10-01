/** Serialización canónica, nombres de fichero y huella (008, research R1 y R9). */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  configFileName,
  configFingerprint,
  preImportFileName,
  serializeConfigFile,
} from '../../../src/config-transfer/canonical.js';
import type { ConfigDocument, ConfigFileEnvelope } from '../../../src/config-transfer/format.js';

const FIXTURES = join(import.meta.dirname, '..', '..', 'fixtures', 'config');
const fixture = (name: string) =>
  JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as Record<string, unknown>;

/** Separa el sobre y el documento de un fichero de ejemplo. */
function split(name: string): { envelope: ConfigFileEnvelope; doc: ConfigDocument } {
  const {
    format,
    formatVersion,
    exportedAt,
    source,
    includesAlertDestinations,
    info,
    ...doc
  } = fixture(name);
  return {
    envelope: {
      format,
      formatVersion,
      exportedAt,
      source,
      includesAlertDestinations,
      info,
    } as ConfigFileEnvelope,
    doc: doc as unknown as ConfigDocument,
  };
}

/** Invierte el orden de las claves de un objeto a todos los niveles. */
function shuffleKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shuffleKeys);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([k, v]) => [k, shuffleKeys(v)]),
  );
}

describe('serializeConfigFile', () => {
  it('reproduce byte a byte el fichero de ejemplo, aunque las claves lleguen desordenadas', () => {
    const { envelope, doc } = split('valid-full.json');
    const text = serializeConfigFile(
      shuffleKeys(envelope) as ConfigFileEnvelope,
      shuffleKeys(doc) as ConfigDocument,
    );
    expect(text).toBe(readFileSync(join(FIXTURES, 'valid-full.json'), 'utf8'));
  });

  it('sangría de 2, salto de línea final y sin BOM', () => {
    const { envelope, doc } = split('valid-empty.json');
    const text = serializeConfigFile(envelope, doc);
    expect(text.startsWith('{\n  "format": "business-config",')).toBe(true);
    expect(text.endsWith('}\n')).toBe(true);
    expect(text.charCodeAt(0)).not.toBe(0xfeff);
    expect(text).toBe(readFileSync(join(FIXTURES, 'valid-empty.json'), 'utf8'));
  });

  it('alertDestinations va al final y solo con includesAlertDestinations', () => {
    const { envelope, doc } = split('valid-full-with-alerts.json');
    const text = serializeConfigFile(envelope, doc);
    expect(text).toBe(readFileSync(join(FIXTURES, 'valid-full-with-alerts.json'), 'utf8'));
    const keys = Object.keys(JSON.parse(text) as object);
    expect(keys.at(-1)).toBe('alertDestinations');

    const without = serializeConfigFile({ ...envelope, includesAlertDestinations: false }, doc);
    expect(without).not.toContain('alertDestinations');
  });

  it('dos exportaciones del mismo documento solo difieren en exportedAt', () => {
    const { envelope, doc } = split('valid-full.json');
    const a = serializeConfigFile(envelope, doc);
    const b = serializeConfigFile({ ...envelope, exportedAt: '2027-01-01T00:00:00.000Z' }, doc);
    expect(a.replace(envelope.exportedAt, 'X')).toBe(b.replace('2027-01-01T00:00:00.000Z', 'X'));
    expect(a).not.toBe(b);
  });
});

describe('nombres de fichero', () => {
  const date = new Date('2026-09-30T08:05:59.000Z');

  it('configuracion-<id>-<AAAAMMDD-HHMM>.json en UTC', () => {
    expect(configFileName('demo-01', date)).toBe('configuracion-demo-01-20260930-0805.json');
    expect(configFileName(null, date)).toBe('configuracion-instancia-20260930-0805.json');
  });

  it('configuracion-anterior-<AAAAMMDD-HHMM>.json', () => {
    expect(preImportFileName(date)).toBe('configuracion-anterior-20260930-0805.json');
  });
});

describe('configFingerprint (R9)', () => {
  const { doc } = split('valid-full-with-alerts.json');
  const base = { document: doc, businessStatus: 'active' as const, webChatEnabled: true };
  const fp = configFingerprint(base);

  it('es SHA-256 hex y determinista, sin depender del orden de las claves', () => {
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    expect(configFingerprint(base)).toBe(fp);
    expect(
      configFingerprint({ ...base, document: shuffleKeys(doc) as ConfigDocument }),
    ).toBe(fp);
  });

  it('cambia con cualquier cambio de la configuración o de los estados', () => {
    const changed = (document: ConfigDocument) => configFingerprint({ ...base, document });
    expect(changed({ ...doc, business: { ...doc.business, name: 'Otro nombre' } })).not.toBe(fp);
    expect(changed({ ...doc, faqs: doc.faqs.slice(1) })).not.toBe(fp);
    expect(changed({ ...doc, faqs: [...doc.faqs].reverse() })).not.toBe(fp);
    expect(
      changed({ ...doc, alertDestinations: { whatsapp: null, email: 'otro@example.com' } }),
    ).not.toBe(fp);
    expect(configFingerprint({ ...base, businessStatus: 'draft' })).not.toBe(fp);
    expect(configFingerprint({ ...base, webChatEnabled: false })).not.toBe(fp);
  });
});
