/**
 * Coste y duración de una transcripción (012, research R6): precio por minuto en millonésimas →
 * billonésimas por milisegundo, en enteros; duración del proveedor, del Ogg/Opus o el máximo.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  oggOpusDurationMs,
  resolveAudioMs,
  transcriptionCostPico,
} from '../../../src/usage/transcription-cost.js';

const audio = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../../fixtures/audio/${name}`, import.meta.url)));

describe('transcriptionCostPico', () => {
  it.each([
    // 1 minuto a 0,006 por minuto (6 000 millonésimas) = 0,006 = 6·10⁹ billonésimas.
    [60_000, 6_000n, 6_000_000_000n],
    // 1 ms a 1 millonésima por minuto = 50/3 billonésimas → 17 (siempre hacia arriba).
    [1, 1n, 17n],
    [3, 1n, 50n],
    [0, 6_000n, 0n],
    [60_000, 0n, 0n],
    // Enteros grandes: 2 h a 1 000 000 por minuto (el máximo del formulario).
    [7_200_000, 1_000_000_000_000n, 120_000_000_000_000_000_000n],
  ])('%i ms a %i millonésimas/min = %i', (ms, micros, pico) => {
    expect(transcriptionCostPico(ms, micros)).toBe(pico);
  });

  it('sin precio, nulo', () => {
    expect(transcriptionCostPico(60_000, null)).toBeNull();
  });
});

describe('oggOpusDurationMs', () => {
  it.each([
    ['voice-3s.ogg', 3_000],
    ['voice-119s.ogg', 119_000],
    ['no-granule.ogg', null],
    ['truncated.ogg', null],
    ['not-ogg.bin', null],
  ])('%s → %s', (file, ms) => {
    expect(oggOpusDurationMs(audio(file))).toBe(ms);
  });

  it('un búfer vacío no tiene duración', () => {
    expect(oggOpusDurationMs(Buffer.alloc(0))).toBeNull();
  });
});

describe('resolveAudioMs: nunca infraestima', () => {
  const ogg = audio('voice-3s.ogg');

  it('prefiere la duración del proveedor', () => {
    expect(resolveAudioMs(4.2, ogg, 120)).toBe(4_200);
    expect(resolveAudioMs(0, ogg, 120)).toBe(0);
  });

  it('sin la del proveedor, la del Ogg/Opus', () => {
    expect(resolveAudioMs(null, ogg, 120)).toBe(3_000);
  });

  it('sin ninguna de las dos, el máximo permitido', () => {
    expect(resolveAudioMs(null, audio('not-ogg.bin'), 120)).toBe(120_000);
    expect(resolveAudioMs(undefined, null, 120)).toBe(120_000);
    expect(resolveAudioMs(Number.NaN, null, 120)).toBe(120_000);
  });
});
