/** Ficheros pendientes de confirmar (008, research R10). */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfigFile } from '../../../src/config-transfer/parse.js';
import { PendingImports, type PendingData } from '../../../src/config-transfer/pending.js';

const parsed = parseConfigFile(
  readFileSync(join(import.meta.dirname, '..', '..', 'fixtures', 'config', 'valid-full.json')),
  { phoneRegion: 'ES' },
);
if (!parsed.ok) throw new Error('fixture no válido');
const data: PendingData<string> = {
  document: parsed.document,
  envelope: parsed.envelope,
  sourceInstance: 'demo-01',
};

function store() {
  let clock = 1_000_000;
  const expired: Array<{ id: string; reason: string }> = [];
  const pending = new PendingImports<string>({
    now: () => clock,
    onExpire: (entry, reason) => expired.push({ id: entry.id, reason }),
  });
  return { pending, expired, advance: (ms: number) => (clock += ms) };
}

describe('PendingImports', () => {
  it('identificadores de 128 bits en base64url', () => {
    const { pending } = store();
    const ids = new Set(Array.from({ length: 5 }, () => pending.add('e1', data).id));
    expect(ids.size).toBe(5);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it('get solo con la misma época y antes de 30 minutos', () => {
    const { pending, expired, advance } = store();
    const entry = pending.add('e1', data);
    expect(pending.get(entry.id, 'e1')?.document).toBe(data.document);
    expect(pending.get(entry.id, 'otra')).toBeUndefined();
    advance(30 * 60 * 1000 - 1);
    expect(pending.get(entry.id, 'e1')).toBeDefined();
    advance(1);
    expect(pending.get(entry.id, 'e1')).toBeUndefined();
    expect(expired).toEqual([{ id: entry.id, reason: 'expired' }]);
  });

  it('la sexta entrada desplaza a la más antigua y la da por caducada', () => {
    const { pending, expired, advance } = store();
    const first = pending.add('e1', data);
    for (let i = 0; i < 4; i++) {
      advance(1000);
      pending.add('e1', data);
    }
    advance(1000);
    const sixth = pending.add('e1', data);
    expect(pending.size).toBe(5);
    expect(pending.get(first.id, 'e1')).toBeUndefined();
    expect(pending.get(sixth.id, 'e1')).toBeDefined();
    expect(expired).toEqual([{ id: first.id, reason: 'expired' }]);
  });

  it('remove la elimina sin avisar de caducidad', () => {
    const { pending, expired } = store();
    const entry = pending.add('e1', data);
    expect(pending.remove(entry.id)?.id).toBe(entry.id);
    expect(pending.get(entry.id, 'e1')).toBeUndefined();
    expect(expired).toEqual([]);
  });

  it('markApplied guarda el resultado y ya no admite otra confirmación', () => {
    const { pending, expired, advance } = store();
    const entry = pending.add('e1', data);
    expect(pending.canApply(entry.id, 'e1')).toBe(true);
    pending.markApplied(entry.id, 'resultado');
    expect(pending.canApply(entry.id, 'e1')).toBe(false);
    expect(pending.getResult(entry.id, 'e1')).toBe('resultado');
    // Una entrada aplicada que caduca no se registra como cancelada.
    advance(31 * 60 * 1000);
    expect(pending.getResult(entry.id, 'e1')).toBeUndefined();
    expect(expired).toEqual([]);
  });

  it('markPreviewed es verdadero solo la primera vez', () => {
    const { pending } = store();
    const entry = pending.add('e1', data);
    expect(pending.markPreviewed(entry.id)).toBe(true);
    expect(pending.markPreviewed(entry.id)).toBe(false);
    expect(pending.markPreviewed('no-existe')).toBe(false);
  });
});
