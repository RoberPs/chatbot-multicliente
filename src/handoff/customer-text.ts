/**
 * Texto del cliente en los avisos al negocio (012, FR-017, research R8;
 * contracts/handoff-limits.md). Lo que escribe el cliente (mensajes reenviados, resumen y nombre)
 * llega al negocio por email y por plantillas de WhatsApp: sus direcciones y correos se desactivan
 * para que no sean pulsables (sin protocolo, `[.]` y `[@]`) y el texto va delimitado, de modo que
 * no se pueda hacer pasar por el del sistema. Dominio puro: sin HTTP.
 */
import { linkCandidates } from '../conversation/link-rule.js';

const LABEL = String.raw`[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?`;
/** Correo: parte local y dominio con al menos un punto. */
const EMAIL = new RegExp(
  String.raw`[\p{L}\p{N}._%+\-]+@((?:${LABEL}[.．。｡])+${LABEL})`,
  'gu',
);
/** Esquemas (`https://`, `HTTP://`, `ftp://`…) dentro de una dirección. */
const SCHEME = /[a-z][a-z0-9+.-]*:\/\//gi;
/** Puntos, también los de ancho completo e ideográficos que algunos clientes convierten. */
const DOTS = /[.．。｡]/g;

interface Span {
  start: number;
  end: number;
  replacement: string;
}

/** Dirección sin protocolo y con todos sus puntos y arrobas desactivados. */
const defuseAddress = (url: string): string =>
  url.replace(SCHEME, '').replace(DOTS, '[.]').replaceAll('@', '[@]');

/** Une los tramos que se solapan (p. ej. un `https://` dentro de la ruta de un `http://`). */
function merge(matches: Array<{ start: number; end: number }>) {
  const sorted = [...matches].sort((a, b) => a.start - b.start || b.end - a.end);
  const out: Array<{ start: number; end: number }> = [];
  for (const m of sorted) {
    const last = out.at(-1);
    if (last && m.start < last.end) last.end = Math.max(last.end, m.end);
    else out.push({ ...m });
  }
  return out;
}

/** Texto del cliente con las direcciones web y los correos desactivados. */
export function customerQuote(text: string): string {
  const spans: Span[] = merge(linkCandidates(text)).map((m) => ({
    ...m,
    replacement: defuseAddress(text.slice(m.start, m.end)),
  }));
  for (const match of text.matchAll(EMAIL)) {
    const start = match.index;
    const end = start + match[0].length;
    if (spans.some((s) => start < s.end && s.start < end)) continue;
    const at = match[0].indexOf('@');
    spans.push({
      start,
      end,
      replacement: `${match[0].slice(0, at)}[@]${match[0].slice(at + 1).replace(DOTS, '[.]')}`,
    });
  }
  spans.sort((a, b) => a.start - b.start);
  let out = '';
  let cursor = 0;
  for (const span of spans) {
    out += text.slice(cursor, span.start) + span.replacement;
    cursor = span.end;
  }
  return out + text.slice(cursor);
}

const INDENT = '    ';

/**
 * Texto del cliente para un email en texto plano: entre `«` y `»` y con cada línea sangrada, así
 * nada del cliente empieza en la columna 0 (donde están los enlaces «Le atiendo» y «Terminado»).
 * `label` va delante de las comillas (la hora de un mensaje reenviado).
 */
export function quoteForEmail(text: string, label = ''): string[] {
  const lines = customerQuote(text).split(/\r?\n/);
  return lines.map((line, i) => {
    const open = i === 0 ? `${label}«` : '';
    const close = i === lines.length - 1 ? '»' : '';
    return `${INDENT}${open}${line}${close}`;
  });
}

/** Motivo de la derivación en el email: una línea con las de continuación sangradas. */
export function quoteReason(text: string): string {
  const quoted = customerQuote(text).split(/\r?\n/).join(`\n${INDENT}`);
  return `Motivo (según el cliente): «${quoted}»`;
}

/** Variable de plantilla con lo que escribió el cliente. */
export const quoteForTemplate = (text: string): string =>
  `El cliente escribió: «${customerQuote(text)}»`;

/** Variable de plantilla con el resumen del motivo. */
export const quoteSummaryForTemplate = (text: string): string =>
  `Según el cliente: «${customerQuote(text)}»`;
