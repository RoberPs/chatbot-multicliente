import { describe, expect, it } from 'vitest';
import { extractFacts, groundingGuard } from '../../../src/conversation/grounding.js';
import type { AllowedFacts } from '../../../src/conversation/types.js';

const allowed = (partial: Partial<Record<keyof AllowedFacts, Iterable<string | number>>> = {}) =>
  ({
    times: new Set(partial.times ?? ['09:00', '14:00', '16:00', '20:00', '10:00', '17:00']),
    dates: new Set(partial.dates ?? ['12-25', '09-24']),
    phones: new Set(partial.phones ?? ['34910000000', '910000000']),
    emails: new Set(partial.emails ?? ['hola@example.com']),
    urls: new Set(partial.urls ?? ['https://example.com/info']),
    amountsCents: new Set(partial.amountsCents ?? []),
    numbers: new Set(partial.numbers ?? ['12', '28013', '30']),
  }) as AllowedFacts;

describe('extracción de cifras', () => {
  it.each([
    ['a las 9:00', '09:00'],
    ['a las 09:00', '09:00'],
    ['abrimos a las 9h', '09:00'],
    ['desde las 9 h', '09:00'],
    ['a las 9 de la mañana', '09:00'],
    ['hasta las 5 de la tarde', '17:00'],
    ['cerramos a las 20.00', '20:00'],
  ])('hora en "%s"', (text, value) => {
    expect(
      extractFacts(text)
        .filter((f) => f.category === 'time')
        .map((f) => f.value),
    ).toEqual([value]);
  });

  it.each([
    ['el 25 de diciembre', '12-25'],
    ['el 25/12', '12-25'],
    ['el 25/12/2026', '12-25'],
    ['el 2026-12-25', '12-25'],
  ])('fecha en "%s"', (text, value) => {
    expect(
      extractFacts(text)
        .filter((f) => f.category === 'date')
        .map((f) => f.value),
    ).toEqual([value]);
  });

  it('teléfonos, correos, URLs y números sueltos', () => {
    const facts = extractFacts(
      'Llama al +34 910 00 00 00 o al 910-000-000, escribe a Hola@Example.com, ' +
        'mira https://example.com/info/. Estamos en el número 12.',
    );
    expect(facts.map((f) => [f.category, f.value])).toEqual([
      ['url', 'https://example.com/info'],
      ['email', 'hola@example.com'],
      ['phone', '34910000000'],
      ['phone', '910000000'],
      ['number', '12'],
    ]);
  });

  it('normaliza decimales', () => {
    expect(extractFacts('1,5 horas').map((f) => f.value)).toEqual(['1.5']);
  });
});

describe('groundingGuard', () => {
  it('acepta lo que está en los datos', () => {
    expect(
      groundingGuard(
        'Abrimos de 9:00 a 14:00 y de 16 a 20 h. Cerramos el 25 de diciembre. ' +
          'Estamos en Calle Mayor 12, 28013. Llama al 910 000 000 o escribe a hola@example.com.',
        allowed(),
      ),
    ).toEqual({ ok: true });
  });

  it('acepta enumeraciones del 1 al 10 sueltas', () => {
    expect(groundingGuard('Tenemos 3 opciones: 1) básica, 2) completa.', allowed())).toEqual({
      ok: true,
    });
  });

  it('un texto sin cifras siempre pasa', () => {
    expect(groundingGuard('No dispongo de esa información.', allowed())).toEqual({ ok: true });
  });

  it.each([
    ['una hora inventada', 'Abrimos a las 8:30.', ['8:30']],
    ['una fecha inventada', 'Cerramos el 6 de enero.', ['6 de enero']],
    ['un teléfono inventado', 'Llama al 600 123 456.', ['600 123 456']],
    ['un correo inventado', 'Escribe a otro@example.com.', ['otro@example.com']],
    ['un número inventado', 'Tenemos 45 plazas.', ['45']],
    ['una enumeración pegada a una hora', 'Abrimos a las 7 de la tarde.', ['7 de la tarde']],
  ])('rechaza %s', (_name, body, offending) => {
    expect(groundingGuard(body, allowed())).toEqual({ ok: false, offending });
  });
});
