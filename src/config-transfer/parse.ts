/**
 * Lectura de un fichero de configuración subido (008, research R3 y R4): BOM → UTF-8 → JSON →
 * sobre → versión → actualizadores → esquema. Devuelve el documento validado o **todos** los
 * errores a la vez, cada uno con su sección, elemento y motivo (FR-008). Función pura.
 */
import type { CountryCode } from 'libphonenumber-js';
import type { z } from 'zod';
import { INSTANCE_ID_PATTERN } from '../config/env.js';
import {
  CURRENT_FORMAT_VERSION,
  FORMAT_ID,
  isSectionKey,
  SECTION_LABELS,
  UPDATERS,
  type ConfigDocument,
  type ConfigFileEnvelope,
  type FileRejectReason,
  type ImportIssue,
  type SectionKey,
  type Updater,
} from './format.js';
import {
  configFileSchema,
  crossCheckConfig,
  listLengthIssues,
  MISSING_MESSAGE,
  type RawIssue,
} from './schema.js';

export interface ParseOptions {
  /** Región para los teléfonos escritos sin prefijo (la de la instancia). */
  phoneRegion: CountryCode;
  currentVersion?: number;
  updaters?: Readonly<Record<number, Updater>>;
}

export type ParseResult =
  | {
      ok: true;
      envelope: ConfigFileEnvelope;
      document: ConfigDocument;
      /** Versión del formato del fichero tal como llegó (antes de actualizarlo). */
      fileVersion: number;
    }
  | {
      ok: false;
      reason: FileRejectReason | 'invalid';
      issues: ImportIssue[];
      /** `INSTANCE_ID` de origen si se pudo leer y es válido (para el registro). */
      sourceInstance: string | null;
    };

const BOM = [0xef, 0xbb, 0xbf];

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function fileIssue(code: FileRejectReason, message: string): ImportIssue {
  return {
    section: 'file',
    sectionLabel: SECTION_LABELS.file,
    item: null,
    field: null,
    message,
    code,
  };
}

function reject(
  code: FileRejectReason,
  message: string,
  sourceInstance: string | null = null,
): ParseResult {
  return { ok: false, reason: code, issues: [fileIssue(code, message)], sourceInstance };
}

/** `INSTANCE_ID` del sobre si cumple el patrón; si no, `null` (nunca texto libre al registro). */
export function sourceInstanceOf(raw: unknown): string | null {
  if (!isRecord(raw) || !isRecord(raw.source)) return null;
  const id = raw.source.instanceId;
  return typeof id === 'string' && INSTANCE_ID_PATTERN.test(id) ? id : null;
}

const EXPECTED: Record<string, string> = {
  string: 'un texto',
  number: 'un número',
  int: 'un número entero',
  boolean: 'true o false',
  array: 'una lista',
  object: 'un objeto',
  null: 'null',
};

/** Mensajes en español para los errores sin mensaje propio en el esquema. */
const errorMap: z.core.$ZodErrorMap = (issue) => {
  switch (issue.code) {
    case 'invalid_type':
      return issue.input === undefined
        ? MISSING_MESSAGE
        : `Tipo de dato no válido: se esperaba ${EXPECTED[issue.expected] ?? issue.expected}`;
    case 'invalid_value':
      return `Valor no válido; se admite: ${issue.values.map((v) => JSON.stringify(v)).join(', ')}`;
    case 'unrecognized_keys':
      return 'Campo desconocido';
    case 'invalid_union':
      return 'Valor no válido';
    case 'invalid_format':
      return 'Formato no válido';
    case 'too_big':
      return issue.origin === 'array'
        ? `Como máximo ${String(issue.maximum)} elementos`
        : `Máximo ${String(issue.maximum)}`;
    case 'too_small':
      return issue.origin === 'array'
        ? `Como mínimo ${String(issue.minimum)} elementos`
        : `Mínimo ${String(issue.minimum)}`;
    default:
      return undefined;
  }
};

/** `['hours', 2, 'end']` → `hours[2].end`. */
function formatPath(path: ReadonlyArray<PropertyKey>): string {
  return path.reduce<string>((acc, key) => {
    if (typeof key === 'number') return `${acc}[${key}]`;
    const name = String(key);
    return acc === '' ? name : `${acc}.${name}`;
  }, '');
}

const LIST_SECTIONS = new Set<SectionKey>([
  'openingHours',
  'closures',
  'services',
  'resources',
  'faqs',
]);

/** Nombre o pregunta del elemento entre « », o su posición si no la tiene. */
function itemLabel(section: SectionKey, element: unknown, index: number): string {
  const text = isRecord(element)
    ? section === 'faqs'
      ? element.question
      : section === 'services' || section === 'resources'
        ? element.name
        : undefined
    : undefined;
  if (typeof text !== 'string' || text.trim() === '') return `n.º ${index + 1}`;
  const label = text.trim();
  return label.length > ITEM_LABEL_MAX ? `«${label.slice(0, ITEM_LABEL_MAX)}…»` : `«${label}»`;
}

/** Nombres y preguntas más largos se recortan en la lista de errores. */
const ITEM_LABEL_MAX = 60;

/** Error con la ruta del fichero → error con sección, elemento y campo (data-model §4). */
function toIssue(path: ReadonlyArray<PropertyKey>, message: string, raw: unknown): ImportIssue {
  const [head, ...rest] = path;
  if (!isSectionKey(head)) {
    return {
      section: 'file',
      sectionLabel: SECTION_LABELS.file,
      item: null,
      field: formatPath(path) || null,
      message,
    };
  }
  const [index, ...inner] = rest;
  if (LIST_SECTIONS.has(head) && typeof index === 'number') {
    const list = isRecord(raw) && Array.isArray(raw[head]) ? (raw[head] as unknown[]) : [];
    return {
      section: head,
      sectionLabel: SECTION_LABELS[head],
      item: itemLabel(head, list[index], index),
      field: formatPath(inner) || null,
      message,
    };
  }
  return {
    section: head,
    sectionLabel: SECTION_LABELS[head],
    item: null,
    field: formatPath(rest) || null,
    message,
  };
}

/**
 * Posiciones de las claves de cada objeto del fichero, calculadas una vez por objeto (012, R15):
 * ordenar los errores no recorre las claves en cada comparación.
 */
type KeyPositions = WeakMap<object, Map<string, number>>;

/** Posición de una clave en el objeto del fichero (las que faltan, al final). */
function keyPosition(cache: KeyPositions, node: unknown, key: string): number {
  if (!isRecord(node)) return Number.MAX_SAFE_INTEGER;
  let positions = cache.get(node);
  if (!positions) {
    positions = new Map(Object.keys(node).map((k, i) => [k, i]));
    cache.set(node, positions);
  }
  return positions.get(key) ?? Number.MAX_SAFE_INTEGER;
}

/** Compara dos rutas por el orden en que aparecen en el fichero. */
function compareInFile(
  cache: KeyPositions,
  raw: unknown,
  a: RawIssue['path'],
  b: RawIssue['path'],
): number {
  let node: unknown = raw;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const ka = a[i];
    const kb = b[i];
    if (ka === undefined) return -1;
    if (kb === undefined) return 1;
    if (ka !== kb) {
      if (typeof ka === 'number' && typeof kb === 'number') return ka - kb;
      const pa = keyPosition(cache, node, String(ka));
      const pb = keyPosition(cache, node, String(kb));
      return pa !== pb ? pa - pb : String(ka).localeCompare(String(kb));
    }
    node =
      isRecord(node) || Array.isArray(node) ? (node as Record<string, unknown>)[ka] : undefined;
  }
  return 0;
}

/** Errores de Zod como rutas del fichero; una clave desconocida por error. */
function zodIssues(error: z.ZodError): RawIssue[] {
  return error.issues.flatMap((issue): RawIssue[] => {
    const path = issue.path.map((k) => (typeof k === 'number' ? k : String(k)));
    if (issue.code === 'unrecognized_keys') {
      return issue.keys.map((key) => ({ path: [...path, key], message: issue.message }));
    }
    return [{ path, message: issue.message }];
  });
}

/** Valida un fichero ya analizado como JSON y en la versión actual. */
export function validateConfigFile(
  raw: unknown,
  region: CountryCode,
):
  | { ok: true; envelope: ConfigFileEnvelope; document: ConfigDocument }
  | { ok: false; issues: ImportIssue[] } {
  // 012 (FR-028): una lista por encima de su máximo se rechaza sin validar nada más.
  const lengths = listLengthIssues(raw);
  if (lengths.length > 0) {
    return { ok: false, issues: lengths.map((i) => toIssue(i.path, i.message, raw)) };
  }

  const parsed = configFileSchema(region).safeParse(raw, { error: errorMap });
  const raws = [
    ...(parsed.success ? [] : zodIssues(parsed.error)),
    ...crossCheckConfig(raw, region),
  ];
  if (parsed.success && raws.length === 0) return { ok: true, ...parsed.data };

  // Sin repetir el mismo motivo en el mismo sitio (lineal, 012), y en el orden del fichero.
  const seen = new Set<string>();
  const unique = raws.filter((issue) => {
    const key = `${formatPath(issue.path)}|${issue.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const cache: KeyPositions = new WeakMap();
  unique.sort((a, b) => compareInFile(cache, raw, a.path, b.path));
  return { ok: false, issues: unique.map((i) => toIssue(i.path, i.message, raw)) };
}

/**
 * Analiza los bytes subidos. Un fichero que no es JSON, no es una exportación o es de una
 * versión que no se entiende se rechaza con un único error de la sección `file`.
 */
export function parseConfigFile(bytes: Uint8Array, options: ParseOptions): ParseResult {
  const current = options.currentVersion ?? CURRENT_FORMAT_VERSION;
  const updaters = options.updaters ?? UPDATERS;

  const hasBom = BOM.every((b, i) => bytes[i] === b);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(hasBom ? bytes.subarray(3) : bytes);
  } catch {
    return reject('unreadable', 'El fichero no se puede leer: no es un texto en UTF-8');
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return reject('unreadable', 'El fichero no se puede leer: no es un JSON válido');
  }

  const sourceInstance = sourceInstanceOf(raw);
  if (!isRecord(raw) || raw.format !== FORMAT_ID) {
    return reject(
      'not_export',
      'El fichero no es una exportación de la configuración del negocio (falta el sobre "format": "business-config")',
    );
  }

  const version = raw.formatVersion;
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    return reject(
      'unsupported_version',
      'El fichero no indica una versión del formato válida (formatVersion)',
      sourceInstance,
    );
  }
  if (version > current) {
    const schema =
      isRecord(raw.source) && typeof raw.source.schema === 'string'
        ? raw.source.schema.slice(0, 100)
        : 'de origen';
    return reject(
      'future_version',
      `El fichero es de una versión del formato (${version}) posterior a la que entiende esta ` +
        `instancia (${current}): actualiza esta instancia a un núcleo con la migración ` +
        `«${schema}» o posterior`,
      sourceInstance,
    );
  }

  let updated: unknown = raw;
  for (let v = version; v < current; v++) {
    const updater = updaters[v];
    if (!updater) {
      return reject(
        'unsupported_version',
        `Esta instancia ya no admite la versión ${version} del formato del fichero`,
        sourceInstance,
      );
    }
    updated = updater(updated);
  }
  if (version !== current && isRecord(updated)) updated = { ...updated, formatVersion: current };

  const result = validateConfigFile(updated, options.phoneRegion);
  if (!result.ok) return { ok: false, reason: 'invalid', issues: result.issues, sourceInstance };
  return {
    ok: true,
    envelope: { ...result.envelope, formatVersion: version },
    document: result.document,
    fileVersion: version,
  };
}
