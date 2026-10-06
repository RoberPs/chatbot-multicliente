/**
 * Convierte el cuerpo plano de un formulario (`slots[0].start`, `ids[]`…) en objetos y listas
 * anidados que entienden los esquemas del dominio.
 */

type Token = string | number;

const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_INDEX = 500;
const MAX_DEPTH = 4;

function tokenize(key: string): Token[] | null {
  const match = /^([A-Za-z_]\w*)((?:\[\d{1,9}\]|\.[A-Za-z_]\w*)*)$/.exec(key);
  if (!match) return null;
  const [, head = '', rest = ''] = match;
  const tokens: Token[] = [head];
  for (const part of rest.matchAll(/\[(\d+)\]|\.([A-Za-z_]\w*)/g)) {
    if (part[1] !== undefined) {
      const index = Number(part[1]);
      if (index > 1_000_000_000) return null;
      tokens.push(index);
    } else if (part[2] !== undefined) {
      tokens.push(part[2]);
    }
  }
  if (tokens.length > MAX_DEPTH) return null;
  return tokens.some((t) => typeof t === 'string' && FORBIDDEN.has(t)) ? null : tokens;
}

type Node = Record<string, unknown>;
const INDEXED = Symbol('indexed');

function assign(target: Node, tokens: Token[], value: unknown): void {
  let node: Node = target;
  tokens.forEach((token, i) => {
    const key = String(token);
    const isLast = i === tokens.length - 1;
    if (isLast) {
      if (!(key in node)) node[key] = value;
      return;
    }
    const nextIsIndex = typeof tokens[i + 1] === 'number';
    let child = node[key];
    if (typeof child !== 'object' || child === null || Array.isArray(child)) {
      child = nextIsIndex ? { [INDEXED]: true } : {};
      node[key] = child;
    }
    node = child as Node;
  });
}

function finalize(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const node = value as Node & { [INDEXED]?: boolean };
  if (node[INDEXED]) {
    return Object.keys(node)
      .map(Number)
      .sort((a, b) => a - b)
      .slice(0, MAX_INDEX)
      .map((k) => finalize(node[String(k)]));
  }
  return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, finalize(v)]));
}

export function parseForm(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null) return {};
  const out: Node = {};
  for (const [rawKey, value] of Object.entries(body as Record<string, unknown>)) {
    if (rawKey === '_csrf') continue;
    const key = rawKey.endsWith('[]') ? rawKey.slice(0, -2) : rawKey;
    const tokens = tokenize(key);
    if (!tokens) continue;
    const isNested = tokens.length > 1;
    // Un nombre repetido solo tiene sentido en listas simples (`ids`, `service_ids`…).
    const normalized = isNested && Array.isArray(value) ? (value[0] as unknown) : value;
    assign(out, tokens, normalized);
  }
  return finalize(out) as Record<string, unknown>;
}

const isBlank = (v: unknown): boolean =>
  v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

/** Quita las filas cuyos campos indicados están todos vacíos (filas de reserva del formulario). */
export function compactRows(list: unknown, fields: string[]): Array<Record<string, unknown>> {
  if (!Array.isArray(list)) return [];
  return list.filter(
    (row): row is Record<string, unknown> =>
      typeof row === 'object' &&
      row !== null &&
      fields.some((f) => !isBlank((row as Record<string, unknown>)[f])),
  );
}
