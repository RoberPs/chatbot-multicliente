/**
 * Regla única de enlaces (012, FR-031, research R12; contracts/link-rule.md): lo que se pinta
 * como enlace (`displayLinks`) lo ve siempre el verificador (`linkCandidates`).
 */
import { describe, expect, it } from 'vitest';
import {
  DISPLAY_LINK_RULE,
  displayLinks,
  linkCandidates,
} from '../../../src/conversation/link-rule.js';
import { TLD_COUNT, isKnownTld } from '../../../src/conversation/tlds.js';
import { LINK_CASES } from '../../fixtures/links/battery.js';

describe('displayLinks y linkCandidates con la batería (SC-008)', () => {
  it.each(LINK_CASES.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(displayLinks(c.text)).toEqual(c.display);
    expect(linkCandidates(c.text)).toEqual(c.candidates);
  });

  it.each(LINK_CASES.map((c) => [c.name, c.text] as const))(
    '%s: displayLinks ⊆ linkCandidates',
    (_name, text) => {
      const candidates = linkCandidates(text).map((m) => `${m.start}|${m.end}|${m.url}`);
      for (const m of displayLinks(text)) {
        expect(candidates).toContain(`${m.start}|${m.end}|${m.url}`);
      }
    },
  );

  it('xhttps://otra.web es candidato; 3.5 kg, p.ej. y v1.2.3 no lo son', () => {
    expect(linkCandidates('xhttps://otra.web').map((m) => m.url)).toEqual(['https://otra.web']);
    for (const text of ['3.5 kg', 'p.ej.', 'v1.2.3']) expect(linkCandidates(text)).toEqual([]);
  });

  it('cada enlace es el trozo exacto del texto', () => {
    for (const c of LINK_CASES) {
      for (const m of linkCandidates(c.text)) expect(c.text.slice(m.start, m.end)).toBe(m.url);
    }
  });
});

describe('DISPLAY_LINK_RULE', () => {
  it('reproduce displayLinks con una expresión del navegador', () => {
    const candidate = new RegExp(DISPLAY_LINK_RULE.candidate, DISPLAY_LINK_RULE.flags);
    const trailing = new RegExp(DISPLAY_LINK_RULE.trailing);
    const text = 'Mapa: https://a.example.com/x. Y https://b.es)';
    const found = [...text.matchAll(candidate)].map((m) => m[0].replace(trailing, ''));
    expect(found).toEqual(displayLinks(text).map((m) => m.url));
  });
});

describe('lista de dominios de primer nivel', () => {
  it('tiene la lista completa de IANA y no distingue mayúsculas', () => {
    expect(TLD_COUNT).toBeGreaterThan(1400);
    expect(isKnownTld('es')).toBe(true);
    expect(isKnownTld('COM')).toBe(true);
    expect(isKnownTld('xn--p1ai')).toBe(true);
    expect(isKnownTld('invalido')).toBe(false);
    expect(isKnownTld('ej')).toBe(false);
  });
});
