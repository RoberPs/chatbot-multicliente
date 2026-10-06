/**
 * Enlaces pulsables en las respuestas del bot (004 FR-020a, research R15).
 *
 * Desde la 012 (FR-031) es la regla única de `src/conversation/link-rule.ts` (`displayLinks`): lo
 * que se pinta como enlace lo ha comprobado antes el verificador. El chat web usa la misma
 * expresión, inyectada en `links.js` al servirlo.
 */
import { displayLinks } from '../conversation/link-rule.js';

/** Trozo de un mensaje: texto, o enlace si lleva `href`. */
export interface LinkPart {
  text: string;
  href?: string;
}

/** Parte el texto en trozos de texto y enlaces `https://`. Los trozos unidos son el original. */
export function splitLinks(text: string): LinkPart[] {
  const parts: LinkPart[] = [];
  let last = 0;
  for (const link of displayLinks(text)) {
    if (link.start > last) parts.push({ text: text.slice(last, link.start) });
    parts.push({ text: link.url, href: link.url });
    last = link.end;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}
