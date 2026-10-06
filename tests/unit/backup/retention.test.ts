import { describe, expect, it } from 'vitest';
import { selectExpired, type RetentionCandidate } from '../../../src/backup/retention.js';

const DAY = 24 * 60 * 60 * 1000;
const now = new Date('2026-09-29T10:00:00.000Z');

function backup(ageDays: number, extra: Partial<RetentionCandidate> = {}): RetentionCandidate {
  return {
    name: `copia-${String(ageDays)}`,
    createdAt: new Date(now.getTime() - ageDays * DAY),
    own: true,
    valid: true,
    ...extra,
  };
}

const names = (list: RetentionCandidate[]) => list.map((b) => b.name).sort();

describe('selectExpired', () => {
  it('borra las de edad mayor que la retención y conserva la del límite exacto', () => {
    const list = [backup(1), backup(5), backup(7), backup(8), backup(20)];
    expect(names(selectExpired(list, now, 7))).toEqual(['copia-20', 'copia-8']);
  });

  it('si todas caducan conserva la más reciente válida', () => {
    const list = [backup(10), backup(20), backup(30)];
    expect(names(selectExpired(list, now, 7))).toEqual(['copia-20', 'copia-30']);
  });

  it('una más reciente no válida no cuenta: se conserva la válida anterior', () => {
    const list = [backup(9, { valid: false }), backup(12), backup(20)];
    expect(names(selectExpired(list, now, 7))).toEqual(['copia-20', 'copia-9']);
  });

  it('las previas a migración y las diarias siguen la misma regla', () => {
    const list = [
      backup(2, { name: 'diaria' }),
      backup(9, { name: 'previa' }),
      backup(10, { name: 'manual' }),
    ];
    expect(names(selectExpired(list, now, 7))).toEqual(['manual', 'previa']);
  });

  it('las de otra instancia nunca se devuelven', () => {
    const list = [backup(1), backup(40, { own: false, name: 'ajena' })];
    expect(selectExpired(list, now, 7)).toEqual([]);
  });

  it('la edad sale de createdAt (de la cabecera), no del nombre', () => {
    const list = [
      backup(1),
      { ...backup(20), name: 'x__0004_handoff__20990101T000000Z__manual.cbak' },
    ];
    expect(names(selectExpired(list, now, 7))).toEqual([
      'x__0004_handoff__20990101T000000Z__manual.cbak',
    ]);
  });

  it('sin copias válidas no conserva ninguna caducada', () => {
    const list = [backup(10, { valid: false }), backup(20, { valid: false })];
    expect(names(selectExpired(list, now, 7))).toEqual(['copia-10', 'copia-20']);
  });
});
