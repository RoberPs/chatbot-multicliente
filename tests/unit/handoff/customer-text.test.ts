/**
 * Texto del cliente en los avisos al negocio (012, SC-011; contracts/handoff-limits.md): las
 * direcciones y correos quedan desactivados (sin protocolo, `[.]` y `[@]`) y el texto va
 * delimitado para que no se confunda con el del sistema.
 */
import { describe, expect, it } from 'vitest';
import { linkCandidates } from '../../../src/conversation/link-rule.js';
import {
  customerQuote,
  quoteForEmail,
  quoteForTemplate,
  quoteReason,
  quoteSummaryForTemplate,
} from '../../../src/handoff/customer-text.js';
import { LINK_CASES } from '../../fixtures/links/battery.js';

describe('customerQuote', () => {
  it.each([
    ['mira https://ejemplo.com/oferta', 'mira ejemplo[.]com/oferta'],
    ['www.ejemplo.es', 'www[.]ejemplo[.]es'],
    ['escribe a ana@ejemplo.com', 'escribe a ana[@]ejemplo[.]com'],
    ['ejemplo.com.', 'ejemplo[.]com.'],
    ['HTTP://EJEMPLO.COM', 'EJEMPLO[.]COM'],
    ['3.5 kg', '3.5 kg'],
    ['p.ej.', 'p.ej.'],
  ])('tabla del contrato: %s', (input, output) => {
    expect(customerQuote(input)).toBe(output);
  });

  it.each(LINK_CASES.map((c) => [c.name, c] as const))('batería: %s', (_name, c) => {
    expect(customerQuote(c.text)).toBe(c.quote);
  });

  it('nada de la batería conserva un protocolo ni un candidato a dirección', () => {
    for (const c of LINK_CASES) {
      const out = customerQuote(c.text);
      expect([c.name, /[a-z]+:\/\/\S/i.test(out)]).toEqual([c.name, false]);
      expect([c.name, linkCandidates(out)]).toEqual([c.name, []]);
    }
  });
});

describe('delimitado', () => {
  it('email: cada línea sangrada 4 espacios entre «» y nada en la columna 0', () => {
    const lines = quoteForEmail('Hola\nmira https://a.es\nadiós');
    expect(lines).toEqual(['    «Hola', '    mira a[.]es', '    adiós»']);
    for (const line of lines) expect(line.startsWith('    ')).toBe(true);
  });

  it('email: con etiqueta (hora) delante de las comillas', () => {
    expect(quoteForEmail('Hola', '[10:30] ')).toEqual(['    [10:30] «Hola»']);
  });

  it('email: una línea que empieza como un enlace del sistema queda sangrada', () => {
    const lines = quoteForEmail('ok\nLe atiendo: https://evil.es/x');
    expect(lines.at(-1)).toBe('    Le atiendo: evil[.]es/x»');
  });

  it('motivo del email', () => {
    expect(quoteReason('Quiere cita\nen www.a.es')).toBe(
      'Motivo (según el cliente): «Quiere cita\n    en www[.]a[.]es»',
    );
  });

  it('variables de plantilla', () => {
    expect(quoteForTemplate('mira https://a.es')).toBe('El cliente escribió: «mira a[.]es»');
    expect(quoteSummaryForTemplate('cita en a.es')).toBe('Según el cliente: «cita en a[.]es»');
  });
});
