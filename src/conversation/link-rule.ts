/**
 * Regla única de enlaces (012, FR-031, research R12; contracts/link-rule.md). Sustituye a las
 * dos expresiones que había (verificador y vista): lo que el chat web y «Probar el bot» pintan
 * como enlace (`displayLinks`) es siempre un candidato que el verificador ha comprobado
 * (`linkCandidates`), y el verificador ve además lo que WhatsApp y el correo convierten en enlace
 * sin protocolo. Dominio puro: sin HTTP.
 */
import { isKnownTld } from './tlds.js';

/** Un enlace dentro de un texto: `text.slice(start, end) === url`. */
export interface LinkMatch {
  start: number;
  end: number;
  url: string;
}

/** `https://` y lo que sigue hasta un espacio, `<`, `>`, comillas o `)`. Sin borde delante. */
const DISPLAY_CANDIDATE = /https:\/\/[^\s<>"')]+/gi;
/** Signos que cierran la frase y no forman parte del enlace. */
const TRAILING = /[.,;:!?\]}»]+$/;

/** Fuente de la expresión de `displayLinks`, para inyectarla en el `links.js` del chat web. */
export const DISPLAY_LINK_RULE = {
  candidate: DISPLAY_CANDIDATE.source,
  flags: DISPLAY_CANDIDATE.flags,
  trailing: TRAILING.source,
} as const;

/** Cualquier dirección con protocolo web, también con credenciales o sin punto en el host. */
const PROTOCOL_CANDIDATE = /(?:https?|ftp):\/\/[^\s<>"')]+/gi;

const LABEL = String.raw`[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?`;
/**
 * Dominio sin protocolo: `etiqueta(.etiqueta)+[:puerto][/ruta]`, sin pegarse a una palabra, a
 * una arroba ni a una ruta por delante, y sin seguir con una arroba (eso es un correo).
 */
const BARE_CANDIDATE = new RegExp(
  String.raw`(?<![\p{L}\p{N}_.@/:\-])(?:${LABEL}\.)+${LABEL}(?::\d{1,5})?` +
    String.raw`(?:[/?#][^\s<>"')]*|(?![@\p{L}\p{N}_\-]|\.[\p{L}\p{N}]))`,
  'gu',
);

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

function isWebUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return ['http:', 'https:', 'ftp:'].includes(url.protocol) && url.hostname !== '';
}

function scan(text: string, re: RegExp, valid: (url: string) => boolean): LinkMatch[] {
  const out: LinkMatch[] = [];
  for (const match of text.matchAll(re)) {
    const url = match[0].replace(TRAILING, '');
    if (url === '' || !valid(url)) continue;
    out.push({ start: match.index, end: match.index + url.length, url });
  }
  return out;
}

/** Host de un dominio sin protocolo (sin puerto ni ruta). */
const bareHost = (url: string): string => url.split(/[:/?#]/, 1)[0] ?? '';

/** Lo que el chat web y «Probar el bot» muestran como enlace. */
export function displayLinks(text: string): LinkMatch[] {
  return scan(text, DISPLAY_CANDIDATE, isSafeHttpsUrl);
}

/** Lo que el verificador trata como dirección web: `displayLinks` y algo más (nunca menos). */
export function linkCandidates(text: string): LinkMatch[] {
  const display = displayLinks(text);
  const withProtocol = scan(text, PROTOCOL_CANDIDATE, isWebUrl);
  const covered = [...display, ...withProtocol];
  const bare = scan(text, BARE_CANDIDATE, (url) => {
    const host = bareHost(url);
    const tld = host.slice(host.lastIndexOf('.') + 1);
    return /^www\./i.test(host) || isKnownTld(tld);
  }).filter((b) => !covered.some((c) => b.start < c.end && c.start < b.end));

  const seen = new Set<string>();
  return [...display, ...withProtocol, ...bare]
    .filter((m) => {
      const key = `${m.start}|${m.end}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.start - b.start || a.end - b.end);
}
