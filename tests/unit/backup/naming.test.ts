import { describe, expect, it } from 'vitest';
import {
  backupFileName,
  BACKUP_NAME_PATTERN,
  isBackupName,
  isOwnPartial,
  parseBackupName,
  partialName,
} from '../../../src/backup/naming.js';

const createdAt = new Date('2026-09-29T10:15:00.123Z');

describe('nombre de las copias', () => {
  it('instancia, esquema, fecha UTC y motivo', () => {
    expect(
      backupFileName({
        instanceId: 'demo-01',
        schema: { tag: '0004_handoff' },
        createdAt,
        reason: 'manual',
      }),
    ).toBe('demo-01__0004_handoff__20260929T101500Z__manual.cbak');
  });

  it('la fecha no depende de la zona horaria del proceso: siempre UTC', () => {
    const name = backupFileName({
      instanceId: 'a',
      schema: { tag: '0000_initial' },
      createdAt: new Date('2026-12-31T23:59:59Z'),
      reason: 'daily',
    });
    expect(name).toBe('a__0000_initial__20261231T235959Z__daily.cbak');
  });

  it.each(['manual', 'premigration', 'daily'])('el patrón acepta el motivo %s', (reason) => {
    expect(isBackupName(`demo-01__0004_handoff__20260929T101500Z__${reason}.cbak`)).toBe(true);
  });

  it.each([
    ['parcial', '.demo-01__0004_handoff__20260929T101500Z__manual.cbak.partial'],
    ['otro sufijo', 'demo-01__0004_handoff__20260929T101500Z__manual.cbak.bak'],
    ['motivo desconocido', 'demo-01__0004_handoff__20260929T101500Z__weekly.cbak'],
    ['mayúsculas', 'Demo-01__0004_handoff__20260929T101500Z__manual.cbak'],
    ['sin esquema', 'demo-01__x.cbak'],
    ['fecha sin Z', 'demo-01__0004_handoff__20260929T101500__manual.cbak'],
    ['otra extensión', 'demo-01__0004_handoff__20260929T101500Z__manual.sql'],
  ])('el patrón rechaza %s', (_name, file) => {
    expect(isBackupName(file)).toBe(false);
    expect(BACKUP_NAME_PATTERN.test(file)).toBe(false);
  });

  it('parseBackupName devuelve las partes', () => {
    expect(parseBackupName('demo-01__0004_handoff__20260929T101500Z__premigration.cbak')).toEqual({
      instanceId: 'demo-01',
      schema: '0004_handoff',
      stamp: '20260929T101500Z',
      reason: 'premigration',
    });
    expect(parseBackupName('nada.cbak')).toBeNull();
  });

  it('el parcial empieza por punto, termina en .partial y es de su instancia', () => {
    const name = 'demo-01__0004_handoff__20260929T101500Z__manual.cbak';
    const partial = partialName(name);
    expect(partial.startsWith('.')).toBe(true);
    expect(partial.endsWith('.partial')).toBe(true);
    expect(isBackupName(partial)).toBe(false);
    expect(isOwnPartial(partial, 'demo-01')).toBe(true);
    expect(isOwnPartial(partial, 'demo')).toBe(false);
    expect(isOwnPartial(partial, 'demo-01x')).toBe(false);
    expect(isOwnPartial(name, 'demo-01')).toBe(false);
  });
});
