/** Unidades del consumo en enteros exactos (010, research R4; FR-010, SC-002). */
import { describe, expect, it } from 'vitest';
import {
  capLevel,
  capPercent,
  costPico,
  formatCents,
  formatMicros,
  formatPico,
  parseCapCents,
  parseMicrosPerMtok,
} from '../../../src/usage/money.js';
import type { ModelPrice } from '../../../src/usage/types.js';

const price: ModelPrice = {
  model: 'modelo-x',
  inputMicros: 3_000_000n, // 3 por MTok
  outputMicros: 15_000_000n, // 15 por MTok
  cacheWriteMicros: 3_750_000n, // 3,75 por MTok
  cacheReadMicros: 300_000n, // 0,30 por MTok
};

describe('costPico', () => {
  it('suma los cuatro tipos de token: tokens × millonésimas por MTok = billonésimas', () => {
    const tokens = { input: 1200, output: 350, cacheWrite: 2000, cacheRead: 10_000 };
    expect(costPico(tokens, price)).toBe(
      1200n * 3_000_000n + 350n * 15_000_000n + 2000n * 3_750_000n + 10_000n * 300_000n,
    );
    // 0,0036 + 0,00525 + 0,0075 + 0,003 = 0,01935 de la moneda.
    expect(costPico(tokens, price)).toBe(19_350_000_000n);
  });

  it('cero tokens o precio cero cuestan cero', () => {
    expect(costPico({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }, price)).toBe(0n);
    const free = {
      ...price,
      inputMicros: 0n,
      outputMicros: 0n,
      cacheWriteMicros: 0n,
      cacheReadMicros: 0n,
    };
    expect(costPico({ input: 5, output: 5, cacheWrite: 5, cacheRead: 5 }, free)).toBe(0n);
  });

  it('es exacto con números grandes (sin coma flotante)', () => {
    const big = { ...price, outputMicros: 100_000_000n };
    expect(costPico({ input: 0, output: 200_000, cacheWrite: 0, cacheRead: 0 }, big)).toBe(
      20_000_000_000_000n,
    );
  });
});

describe('parseMicrosPerMtok', () => {
  it.each([
    ['3,75', 3_750_000n],
    ['3.75', 3_750_000n],
    ['0', 0n],
    ['0,000001', 1n],
    ['15', 15_000_000n],
    [' 1000000 ', 1_000_000_000_000n],
    ['0,300000', 300_000n],
  ])('%s → %s', (text, micros) => {
    expect(parseMicrosPerMtok(text)).toBe(micros);
  });

  it.each(['0,0000001', '-1', '1000000,01', '', 'abc', '1,2,3', '1e3', '+3', '3,'])(
    'rechaza %j',
    (text) => {
      expect(parseMicrosPerMtok(text)).toBeNull();
    },
  );
});

describe('parseCapCents', () => {
  it.each([
    ['50', 5000],
    ['50,5', 5050],
    ['0,01', 1],
    ['10000000', 1_000_000_000],
    ['12.34', 1234],
  ])('%s → %s', (text, cents) => {
    expect(parseCapCents(text)).toBe(cents);
  });

  it.each(['0', '0,00', '0,001', '-5', '10000000,01', '', 'x'])('rechaza %j', (text) => {
    expect(parseCapCents(text)).toBeNull();
  });
});

describe('formatPico', () => {
  it.each([
    [0n, '0,0000'],
    [1n, '< 0,0001'],
    [49_999_999n, '< 0,0001'],
    [50_000_000n, '0,0001'], // la mitad redondea hacia arriba (FR-010)
    [100_000_000n, '0,0001'],
    [149_999_999n, '0,0001'],
    [150_000_000n, '0,0002'],
    [19_350_000_000n, '0,0194'],
    [1_000_000_000_000n, '1,0000'],
    [12_345_678_900_000_000n, '12.345,6789'],
  ])('%s → %s', (pico, text) => {
    expect(formatPico(pico)).toBe(text);
  });

  it('acepta otro número de decimales', () => {
    expect(formatPico(19_350_000_000n, 2)).toBe('0,02');
  });
});

describe('formatMicros y formatCents', () => {
  it('formatMicros vuelve a la forma que se escribe en el panel', () => {
    expect(formatMicros(3_750_000n)).toBe('3,75');
    expect(formatMicros(15_000_000n)).toBe('15');
    expect(formatMicros(1n)).toBe('0,000001');
    expect(formatMicros(0n)).toBe('0');
    expect(parseMicrosPerMtok(formatMicros(300_000n))).toBe(300_000n);
  });

  it('formatCents con dos decimales', () => {
    expect(formatCents(5000)).toBe('50,00');
    expect(formatCents(1)).toBe('0,01');
    expect(formatCents(1_000_000_000)).toBe('10.000.000,00');
  });
});

describe('nivel y porcentaje del tope', () => {
  const cap = 5000; // 50,00 → 5·10¹³ billonésimas
  const pico = (units: number) => BigInt(Math.round(units * 100)) * 10_000_000_000n;

  it('sin tope activo es none', () => {
    expect(capLevel(pico(999), cap, false)).toBe('none');
    expect(capLevel(0n, null, false)).toBe('none');
  });

  it.each([
    [0, 'normal'],
    [39.99, 'normal'],
    [40, 'warning'], // 80 % exacto
    [49.99, 'warning'],
    [50, 'reached'], // 100 % exacto
    [80, 'reached'],
  ] as const)('gasto %s de 50 → %s', (spent, level) => {
    expect(capLevel(pico(spent), cap, true)).toBe(level);
  });

  it('una billonésima por debajo de los bordes no los cruza', () => {
    expect(capLevel(pico(40) - 1n, cap, true)).toBe('normal');
    expect(capLevel(pico(50) - 1n, cap, true)).toBe('warning');
  });

  it('porcentaje redondeado hacia abajo, también por encima de 100', () => {
    expect(capPercent(0n, cap)).toBe(0);
    expect(capPercent(pico(40) - 1n, cap)).toBe(79);
    expect(capPercent(pico(40), cap)).toBe(80);
    expect(capPercent(pico(50) - 1n, cap)).toBe(99);
    expect(capPercent(pico(50), cap)).toBe(100);
    expect(capPercent(pico(80), cap)).toBe(160);
  });
});
