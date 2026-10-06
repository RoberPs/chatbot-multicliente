/**
 * Clave de los límites por dirección (012, FR-020, research R9): la usan todas las rutas con
 * límite (login, salud, chat web y enlaces de derivación). Una IPv6 cuenta por su bloque /64,
 * que es lo que suele tener asignado un mismo cliente; una IPv4 mapeada en IPv6 cuenta como IPv4.
 * Sin dependencias: `node:net` para reconocer la dirección y `URL` para escribirla canónica.
 */
import { isIPv4, isIPv6 } from 'node:net';

/** Los 8 grupos de 16 bits de una IPv6 válida (sin zona). */
function groups(ip: string): number[] {
  let text = ip;
  const tail: number[] = [];
  const lastColon = text.lastIndexOf(':');
  const last = text.slice(lastColon + 1);
  if (isIPv4(last)) {
    const [a = 0, b = 0, c = 0, d = 0] = last.split('.').map(Number);
    tail.push((a << 8) | b, (c << 8) | d);
    text = text.slice(0, lastColon + 1);
    // `::1.2.3.4` deja `::`; `1:…:6:1.2.3.4` deja `1:…:6:`.
    if (!text.endsWith('::')) text = text.slice(0, -1);
  }
  const parse = (part: string) => (part === '' ? [] : part.split(':').map((g) => parseInt(g, 16)));
  const [head = '', rest] = text.split('::');
  const left = parse(head);
  const right = rest === undefined ? [] : parse(rest);
  const missing = 8 - left.length - right.length - tail.length;
  return [...left, ...Array<number>(Math.max(0, missing)).fill(0), ...right, ...tail];
}

/** IPv6 en su forma canónica comprimida (RFC 5952), como la escribe `URL`. */
function canonical(words: number[]): string {
  const text = words.map((w) => w.toString(16)).join(':');
  return new URL(`http://[${text}]`).hostname.slice(1, -1);
}

/** Clave de una dirección: IPv4 tal cual, IPv6 por su /64; si no es una IP, la cadena tal cual. */
export function clientKey(ip: string): string {
  if (isIPv4(ip)) return ip;
  const address = ip.split('%')[0] ?? '';
  if (!isIPv6(address)) return ip;
  const words = groups(address);
  const mapped = words.slice(0, 5).every((w) => w === 0) && words[5] === 0xffff;
  if (mapped) {
    const [hi = 0, lo = 0] = words.slice(6);
    return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.');
  }
  return `${canonical([...words.slice(0, 4), 0, 0, 0, 0])}/64`;
}
