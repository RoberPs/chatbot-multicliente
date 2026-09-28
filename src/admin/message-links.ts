/**
 * Enlaces pulsables en las respuestas del bot (004 FR-020a, research R15).
 *
 * La misma regla está en `src/channels/web/assets/links.js` para el chat web, que no puede
 * importar este módulo; `tests/unit/channels/message-links.test.ts` ejecuta la misma tabla de
 * casos contra las dos.
 */

/** Trozo de un mensaje: texto, o enlace si lleva `href`. */
export interface LinkPart {
  text: string;
  href?: string;
}

/** Candidato: se corta donde lo hace el verificador de cifras (`grounding.ts`). */
const CANDIDATE = /https:\/\/[^\s<>"')]+/gi;
/** Signos que cierran la frase y no forman parte del enlace. */
const TRAILING = /[.,;:!?\]}»]+$/;

/** Misma comprobación que el campo "Enlace a mapa" (003, R7). */
function isSafeHttpsUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === 'https:' && url.hostname.includes('.') && !url.username && !url.password;
}

/** Parte el texto en trozos de texto y enlaces `https://`. Los trozos unidos son el original. */
export function splitLinks(text: string): LinkPart[] {
  const parts: LinkPart[] = [];
  let last = 0;
  for (const match of text.matchAll(CANDIDATE)) {
    const url = match[0].replace(TRAILING, '');
    if (!isSafeHttpsUrl(url)) continue;
    if (match.index > last) parts.push({ text: text.slice(last, match.index) });
    parts.push({ text: url, href: url });
    last = match.index + url.length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}
