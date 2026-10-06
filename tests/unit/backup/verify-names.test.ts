import { describe, expect, it } from 'vitest';
import {
  parseVerifyName,
  selectOrphans,
  VERIFY_MAX_AGE_HOURS,
  verifyDatabaseName,
} from '../../../src/backup/verify-names.js';

const HEX = '0123456789abcdef';
const NOW = new Date('2026-10-06T09:30:00.000Z');

describe('verifyDatabaseName (013, R5)', () => {
  it('verify_<yyyymmddhhmmss UTC>_<16 hex>', () => {
    expect(verifyDatabaseName(NOW, Buffer.from(HEX, 'hex'))).toBe(`verify_20261006093000_${HEX}`);
  });

  it('la marca va en UTC aunque el reloj del proceso tenga otra zona', () => {
    // 23:59:59 en UTC−1 del día 5 es el día 6 en UTC.
    const name = verifyDatabaseName(new Date('2026-10-05T23:59:59-01:00'), Buffer.alloc(8));
    expect(name).toBe('verify_20261006005959_0000000000000000');
  });
});

describe('parseVerifyName', () => {
  it('reconoce el formato nuevo con su fecha y hora reales', () => {
    expect(parseVerifyName(`verify_20261006093000_${HEX}`)).toEqual({
      format: 'current',
      createdAt: new Date('2026-10-06T09:30:00.000Z'),
    });
  });

  it('reconoce el formato anterior (núcleo previo a la 013)', () => {
    expect(parseVerifyName(`verify_${HEX}`)).toEqual({ format: 'legacy' });
  });

  it.each([
    'verify_abc',
    'verify_otra_cosa',
    `verify_${HEX}_x`,
    `verify_20261340000000_${HEX}`,
    `verify_20260230120000_${HEX}`,
    `verify_20261006246000_${HEX}`,
    `verify_20261006093000_${HEX.toUpperCase()}`,
    `verify_${HEX.toUpperCase()}`,
    `verify_20261006093000_${HEX}_x`,
    `xverify_${HEX}`,
    'chatbot_a',
    'postgres',
  ])('rechaza %s', (name) => {
    expect(parseVerifyName(name)).toBeNull();
  });
});

describe('selectOrphans', () => {
  const at = (iso: string) => `verify_${iso.replace(/\D/g, '').slice(0, 14)}_${HEX}`;

  it('el plazo es de 6 horas', () => {
    expect(VERIFY_MAX_AGE_HOURS).toBe(6);
  });

  it('solo sin conexiones y con marca de hace más de 6 h o formato anterior', () => {
    const rows = [
      { name: at('2026-10-06T02:00:00'), connections: 0 }, // hace 7 h 30 → sí
      { name: at('2026-10-06T03:29:59'), connections: 0 }, // hace 6 h y 1 s → sí
      { name: at('2026-10-06T03:30:00'), connections: 0 }, // exactamente 6 h → no
      { name: at('2026-10-06T08:30:00'), connections: 0 }, // hace 1 h → no
      { name: at('2026-10-06T12:00:00'), connections: 0 }, // en el futuro → no
      { name: at('2026-10-05T01:00:00'), connections: 1 }, // antigua pero en uso → no
      { name: `verify_${HEX}`, connections: 0 }, // formato anterior → sí
      { name: 'verify_fedcba9876543210', connections: 2 }, // anterior en uso → no
      { name: 'verify_otra_cosa', connections: 0 }, // fuera del patrón → no
      { name: 'chatbot_a', connections: 0 },
    ];
    expect(selectOrphans(rows, NOW)).toEqual([
      at('2026-10-06T02:00:00'),
      at('2026-10-06T03:29:59'),
      `verify_${HEX}`,
    ]);
  });
});
