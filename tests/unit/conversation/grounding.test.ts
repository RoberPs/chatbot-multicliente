import { describe, expect, it } from 'vitest';
import { extractFacts, groundingGuard } from '../../../src/conversation/grounding.js';
import { buildAllowedFacts } from '../../../src/conversation/facts.js';
import type { AllowedFacts } from '../../../src/conversation/types.js';
import { activeSnapshot, emptyDerived } from '../../helpers/snapshot.js';
import { LINK_CASES } from '../../fixtures/links/battery.js';

const allowed = (partial: Partial<Record<keyof AllowedFacts, Iterable<string | number>>> = {}) =>
  ({
    times: new Set(partial.times ?? ['09:00', '14:00', '16:00', '20:00', '10:00', '17:00']),
    dates: new Set(partial.dates ?? ['12-25', '09-24']),
    phones: new Set(partial.phones ?? ['34910000000', '910000000']),
    emails: new Set(partial.emails ?? ['hola@example.com']),
    urls: new Set(partial.urls ?? ['example.com/info']),
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
      // 012: la clave de una dirección es el host (sin www.) y la ruta, sin protocolo.
      ['url', 'example.com/info'],
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

describe('importes (US2)', () => {
  const prices = () => allowed({ amountsCents: [2500, 4000, 125_050], numbers: ['25', '40'] });

  it.each([
    ['25 €', 2500],
    ['25,00 €', 2500],
    ['25\u00a0€', 2500],
    ['25 euros', 2500],
    ['1 euro', 100],
    ['€25', 2500],
    ['25 EUR', 2500],
    ['35,50 €', 3550],
    ['35.5 €', 3550],
    ['1.250,50 €', 125_050],
    ['1250,50 €', 125_050],
    ['20.00 €', 2000],
  ])('importe en "%s"', (text, cents) => {
    expect(extractFacts(text).map((f) => [f.category, f.value])).toEqual([
      ['amount', String(cents)],
    ]);
  });

  it('un importe sin símbolo cuenta como número', () => {
    expect(extractFacts('cuesta 25.00').map((f) => [f.category, f.value])).toEqual([
      ['number', '25'],
    ]);
  });

  it.each([
    'El corte cuesta 25 €.',
    'El corte cuesta 25,00 €.',
    'El corte cuesta 25 euros.',
    'El corte cuesta 25.00.',
    'El completo, desde 40,00 €.',
    'El grande sale por 1.250,50 €.',
  ])('acepta los registrados: "%s"', (body) => {
    expect(groundingGuard(body, prices())).toEqual({ ok: true });
  });

  it.each([
    ['un importe inventado', 'El corte cuesta 30 €.', ['30 €']],
    ['un importe inventado sin decimales exactos', 'Son 25,50 €.', ['25,50 €']],
    ['un máximo para un precio "desde"', 'Entre 40 € y 60 €.', ['60 €']],
    ['un importe pequeño', 'Un suplemento de 5 €.', ['5 €']],
  ])('rechaza %s', (_name, body, offending) => {
    expect(groundingGuard(body, prices())).toEqual({ ok: false, offending });
  });
});

describe('enlace a mapa (003, Principio IV)', () => {
  const MAP = 'https://maps.example.com/@40.41,-3.70,17z?q=Plaza+Mayor&z=1!2';
  const base = activeSnapshot();
  const snapshot = { ...base, business: { ...base.business, mapUrl: MAP } };
  const facts = () => buildAllowedFacts(snapshot, emptyDerived());

  it('una respuesta que copia el enlace guardado pasa el verificador', () => {
    const body = `Estamos en Calle Mayor 12, 28013 Madrid. Mapa: ${MAP}. ¡Te esperamos!`;
    expect(groundingGuard(body, facts())).toEqual({ ok: true });
    expect(groundingGuard(`Aquí tienes el mapa (${MAP})`, facts())).toEqual({ ok: true });
  });

  it('otro enlace de mapas se rechaza', () => {
    const body = 'Mapa: https://maps.example.com/@40.42,-3.70,17z?q=Plaza+Mayor';
    expect(groundingGuard(body, facts())).toMatchObject({ ok: false });
  });

  it('sin enlace guardado, cualquier enlace de mapas se rechaza', () => {
    expect(
      groundingGuard(`Mapa: ${MAP}`, buildAllowedFacts(activeSnapshot(), emptyDerived())),
    ).toMatchObject({ ok: false });
  });
});

describe('direcciones con la regla común de enlaces (012, US7, FR-031)', () => {
  const SITE = 'https://www.peluqueria-tijeras.es/reservas';
  const base = activeSnapshot();
  // Cualquier texto del negocio vale como dirección registrada (aquí, el enlace a mapa).
  const snapshot = { ...base, business: { ...base.business, mapUrl: SITE } };
  const facts = () => buildAllowedFacts(snapshot, emptyDerived());

  it.each([
    ['con protocolo', 'Reserva en ' + SITE],
    ['sin protocolo', 'Reserva en peluqueria-tijeras.es/reservas'],
    ['con www.', 'Reserva en www.peluqueria-tijeras.es/reservas.'],
    ['en mayúsculas', 'Reserva en HTTPS://WWW.PELUQUERIA-TIJERAS.ES/reservas'],
  ])('la registrada vale %s', (_name, body) => {
    expect(groundingGuard(body, facts())).toEqual({ ok: true });
  });

  it.each(LINK_CASES.filter((c) => c.candidates.length > 0).map((c) => [c.name, c.text] as const))(
    'una no registrada se rechaza: %s',
    (_name, text) => {
      const result = groundingGuard('Mira esto: ' + text, facts());
      expect(result).toMatchObject({ ok: false });
    },
  );
});
