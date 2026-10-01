/**
 * Versiones del parque (009, research R5 y R6, contracts/instance-versions-command.md): consulta
 * `/health` de cada instancia del inventario con su secreto de salud (solo en memoria), clasifica
 * cada fila con una prioridad cerrada, la cruza con la versión anotada y pinta tabla o JSON. Todo
 * es puro salvo la petición HTTP (con `fetch` inyectable). Ninguna salida lleva un secreto ni el
 * identificador recibido de otra instancia (FR-014).
 */
import { join } from 'node:path';
import { z } from 'zod';
import { extractSemanticVersion, SEMVER } from '../health/version.js';
import { parseEnvFile } from './env-file.js';
import { updateInstance, type Instance, type Inventory } from './inventory.js';

// ---------------------------------------------------------------------------
// Tipos (data-model §6)
// ---------------------------------------------------------------------------

export type RowResult =
  | 'ok'
  | 'degraded'
  | 'not_ready'
  | 'unreachable'
  | 'invalid_response'
  | 'no_health'
  | 'auth_failed'
  | 'rate_limited'
  | 'status_only'
  | 'identity_mismatch'
  | 'not_queried';

export type RowReason = 'no_url' | 'not_https' | 'no_secret';
type InstanceStatus = 'ok' | 'degraded' | 'not_ready';

export interface VersionRow {
  id: string;
  client: string;
  result: RowResult;
  reason: RowReason | null;
  status: InstanceStatus | null;
  coreVersion: string | null;
  schema: { applied: string | null; expected: string } | null;
  /** `imageVersion` del inventario, tal como está anotada. */
  annotated: string | null;
  matches: boolean | null;
  review: boolean;
}

export interface VersionsReport {
  checkedAt: string;
  ok: boolean;
  instances: VersionRow[];
}

/** Lo que devolvió la consulta de una instancia. */
export type QueryOutcome =
  | { kind: 'not_queried'; reason: 'no_url' | 'not_https' }
  /** Red, DNS, TLS, tiempo agotado o conexión cortada. */
  | { kind: 'error' }
  /** `body: null` si superó el tamaño máximo. */
  | { kind: 'response'; status: number; body: string | null; secretSent: boolean };

// ---------------------------------------------------------------------------
// Respuestas de /health (contracts/health-endpoint.md)
// ---------------------------------------------------------------------------

const statusSchema = z.enum(['ok', 'degraded', 'not_ready']);
const publicSchema = z.strictObject({ status: statusSchema });
const fullSchema = z.strictObject({
  status: statusSchema,
  instanceId: z.string().nullable(),
  coreVersion: z.string().regex(SEMVER),
  schema: z.strictObject({
    applied: z.strictObject({ index: z.int(), tag: z.string().nullable() }).nullable(),
    expected: z.strictObject({ index: z.int(), tag: z.string() }),
  }),
});

/** Tamaño máximo del cuerpo de `/health` que se lee. */
export const MAX_BODY_BYTES = 4096;

// ---------------------------------------------------------------------------
// Versión anotada y coincidencia
// ---------------------------------------------------------------------------

/** Versión semántica de la anotación (`chatbot:1.4.0` → `1.4.0`); `null` si no hay ninguna. */
export function annotatedVersion(imageVersion: string | null): string | null {
  return imageVersion === null ? null : extractSemanticVersion(imageVersion);
}

/**
 * ¿La versión observada es la anotada? `null` si no hay observada o no hay anotación; una
 * anotación sin versión semántica es una discrepancia.
 */
export function computeMatch(observed: string | null, imageVersion: string | null): boolean | null {
  if (observed === null || imageVersion === null) return null;
  return annotatedVersion(imageVersion) === observed;
}

// ---------------------------------------------------------------------------
// URL permitidas (FR-015)
// ---------------------------------------------------------------------------

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** URL de `/health` de la instancia, o el motivo por el que no se consulta. */
export function allowedUrl(
  publicUrl: string | null,
  allowInsecure: boolean,
): { url: string } | { reason: 'no_url' | 'not_https' } {
  if (publicUrl === null || publicUrl.trim() === '') return { reason: 'no_url' };
  let url: URL;
  try {
    url = new URL(publicUrl.trim());
  } catch {
    return { reason: 'not_https' };
  }
  if (url.username !== '' || url.password !== '') return { reason: 'not_https' };
  const secure = url.protocol === 'https:';
  const local = allowInsecure && url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname);
  if (!secure && !local) return { reason: 'not_https' };
  return { url: new URL('/health', url.origin).toString() };
}

// ---------------------------------------------------------------------------
// Clasificación (prioridad del contrato)
// ---------------------------------------------------------------------------

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

const schemaLabel = (ref: { index: number; tag: string | null } | null): string | null =>
  ref === null ? null : (ref.tag ?? `desconocida (#${String(ref.index)})`);

/** Código coherente con el estado: 200 solo con `ok`, 503 con los demás. */
const codeMatches = (code: number, status: InstanceStatus) =>
  status === 'ok' ? code === 200 : code === 503;

type InstanceRef = Pick<Instance, 'id' | 'client' | 'imageVersion'>;

/**
 * Fila de una instancia. Prioridad: `not_queried` → `unreachable` → `no_health` → `auth_failed`
 * → `rate_limited` → `invalid_response` → `status_only` → `identity_mismatch` → estado.
 */
export function classify(instance: InstanceRef, outcome: QueryOutcome): VersionRow {
  const row = (
    result: RowResult,
    extra: Partial<Pick<VersionRow, 'reason' | 'status' | 'coreVersion' | 'schema'>> = {},
  ): VersionRow => {
    const coreVersion = extra.coreVersion ?? null;
    const matches = computeMatch(coreVersion, instance.imageVersion);
    return {
      id: instance.id,
      client: instance.client,
      result,
      reason: extra.reason ?? null,
      status: extra.status ?? null,
      coreVersion,
      schema: extra.schema ?? null,
      annotated: instance.imageVersion,
      matches,
      review: !(result === 'ok' && matches === true),
    };
  };

  if (outcome.kind === 'not_queried') return row('not_queried', { reason: outcome.reason });
  if (outcome.kind === 'error') return row('unreachable');

  const { status: code, body } = outcome;
  if (code === 502 || code === 504) return row('unreachable');
  if (code === 404) return row('no_health');
  if (code === 401) return row('auth_failed');
  if (code === 429) return row('rate_limited');
  if (body === null || (code !== 200 && code !== 503)) return row('invalid_response');
  const json = parseJson(body);

  if (!outcome.secretSent) {
    const parsed = publicSchema.safeParse(json);
    if (!parsed.success || !codeMatches(code, parsed.data.status)) {
      return row('invalid_response');
    }
    return row('status_only', { reason: 'no_secret', status: parsed.data.status });
  }

  const parsed = fullSchema.safeParse(json);
  if (!parsed.success || !codeMatches(code, parsed.data.status)) return row('invalid_response');
  const report = parsed.data;
  // La versión solo se atribuye a la instancia si el identificador es el suyo (FR-014).
  if (report.instanceId !== instance.id) return row('identity_mismatch');
  return row(report.status, {
    status: report.status,
    coreVersion: report.coreVersion,
    schema: {
      applied: schemaLabel(report.schema.applied),
      expected: report.schema.expected.tag,
    },
  });
}

// ---------------------------------------------------------------------------
// Salida
// ---------------------------------------------------------------------------

const RESULT_LABELS: Record<RowResult, string> = {
  ok: 'Correcto',
  degraded: 'Degradado',
  not_ready: 'No lista',
  unreachable: 'No responde',
  invalid_response: 'Respuesta no válida',
  no_health: 'Sin información de versión',
  auth_failed: 'Secreto rechazado',
  rate_limited: 'Límite de peticiones',
  status_only: 'Solo estado',
  identity_mismatch: 'Identidad distinta',
  not_queried: 'No consultada',
};

const STATUS_LABELS: Record<InstanceStatus, string> = {
  ok: 'correcto',
  degraded: 'degradado',
  not_ready: 'no lista',
};

const REASON_LABELS: Record<RowReason, string> = {
  no_url: 'sin URL',
  not_https: 'no https',
  no_secret: 'sin secreto',
};

function stateLabel(row: VersionRow): string {
  const label = RESULT_LABELS[row.result];
  if (row.result === 'status_only' && row.status !== null) {
    return `${label}: ${STATUS_LABELS[row.status]}`;
  }
  if (row.result === 'not_queried' && row.reason !== null) {
    return `${label} (${REASON_LABELS[row.reason]})`;
  }
  return label;
}

function matchLabel(row: VersionRow): string {
  if (row.matches === true) return 'sí';
  if (row.matches === false) return 'NO';
  return row.coreVersion === null ? '—' : 'sin anotar';
}

const pad = (text: string, size: number) => text + ' '.repeat(Math.max(0, size - text.length));

/** Tabla para personas (contracts/instance-versions-command.md). */
export function renderTable(report: VersionsReport): string {
  if (report.instances.length === 0) return 'No hay instancias activas en el inventario.';
  const header = ['Instancia', 'Cliente', 'Estado', 'Núcleo', 'Esquema', 'Anotada', 'Coincide'];
  const rows = report.instances.map((r) => [
    r.id,
    r.client,
    stateLabel(r),
    r.coreVersion ?? '—',
    r.schema?.applied ?? '—',
    r.annotated ?? '—',
    matchLabel(r),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]) =>
    cells
      .map((c, i) => pad(c, (widths[i] ?? 0) + 2))
      .join('')
      .trimEnd();
  const pending = report.instances.filter((r) => r.review).length;
  const total = report.instances.length;
  return [
    line(header),
    ...rows.map(line),
    '',
    pending === 0
      ? 'Todas las instancias están correctas y coinciden con lo anotado.'
      : `${String(pending)} de ${String(total)} ${total === 1 ? 'instancia requiere' : 'instancias requieren'} revisión.`,
  ].join('\n');
}

/** Salida `--json`: `checkedAt`, `ok` e `instances`. */
export function renderJson(report: VersionsReport): string {
  return JSON.stringify({
    checkedAt: report.checkedAt,
    ok: report.ok,
    instances: report.instances,
  });
}

/** 0 si nada exige revisión (o no hay instancias); 1 si hay algo que revisar. */
export function exitCode(report: VersionsReport): 0 | 1 {
  return report.ok ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Anotación (R6)
// ---------------------------------------------------------------------------

export interface AnnotationChange {
  id: string;
  /** Anotación vista en la consulta (para no pisar un cambio posterior). */
  from: string | null;
  to: string;
}

/** Filas `ok` (identidad comprobada) cuya versión observada no es la anotada. */
export function annotationPlan(report: VersionsReport): AnnotationChange[] {
  return report.instances
    .filter((r) => r.result === 'ok' && r.coreVersion !== null && r.matches !== true)
    .map((r) => ({ id: r.id, from: r.annotated, to: r.coreVersion ?? '' }));
}

/**
 * Escribe la versión observada en `imageVersion`. Una instancia cuya anotación cambió desde la
 * consulta (o que ya no existe) no se toca.
 */
export function applyAnnotations(
  inventory: Inventory,
  plan: AnnotationChange[],
): { inventory: Inventory; applied: string[]; skipped: string[] } {
  let next = inventory;
  const applied: string[] = [];
  const skipped: string[] = [];
  for (const change of plan) {
    const current = next.instances.find((i) => i.id === change.id);
    if (!current || current.imageVersion !== change.from) {
      skipped.push(change.id);
      continue;
    }
    next = updateInstance(next, change.id, { image: change.to });
    applied.push(change.id);
  }
  return { inventory: next, applied, skipped };
}

// ---------------------------------------------------------------------------
// Consulta
// ---------------------------------------------------------------------------

/**
 * `HEALTH_SECRET` del entorno `<envsDir>/<id>.env`, solo en memoria. `null` si no hay fichero o
 * variable; nunca propaga el contenido del fichero.
 */
export function readHealthSecret(envsDir: string, id: string): string | null {
  try {
    const value = parseEnvFile(join(envsDir, `${id}.env`)).HEALTH_SECRET?.trim() ?? '';
    return value === '' ? null : value;
  } catch {
    return null;
  }
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Lee el cuerpo hasta `max` bytes; `null` si es más grande. */
async function readLimited(response: Response, max: number): Promise<string | null> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = (await reader.read()) as { done: boolean; value?: Uint8Array };
    if (done || value === undefined) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * `GET <url>` con el secreto en `Authorization: Bearer` (solo si lo hay), sin seguir
 * redirecciones (un redireccionamiento nunca recibe el secreto) y con tiempo límite.
 */
export async function queryInstance(
  url: string,
  secret: string | null,
  options: { fetch?: FetchLike; timeoutMs: number },
): Promise<QueryOutcome> {
  const doFetch = options.fetch ?? fetch;
  try {
    const response = await doFetch(url, {
      method: 'GET',
      headers: secret === null ? {} : { authorization: `Bearer ${secret}` },
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    const body = await readLimited(response, MAX_BODY_BYTES);
    return { kind: 'response', status: response.status, body, secretSent: secret !== null };
  } catch {
    return { kind: 'error' };
  }
}

export interface CollectOptions {
  envsDir: string;
  /** Solo estas instancias (ids del inventario). */
  only?: string[];
  timeoutMs: number;
  allowInsecure: boolean;
  fetch?: FetchLike;
  now?: () => Date;
  /** Consultas simultáneas (8). */
  concurrency?: number;
}

/** Consulta las instancias no retiradas, en paralelo y como mucho `concurrency` a la vez. */
export async function collectVersions(
  inventory: Inventory,
  options: CollectOptions,
): Promise<VersionsReport> {
  const selected = [...inventory.instances]
    .filter((i) => i.status !== 'retired')
    .filter((i) => options.only === undefined || options.only.includes(i.id))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const rows: VersionRow[] = new Array<VersionRow>(selected.length);
  let next = 0;
  const worker = async () => {
    while (next < selected.length) {
      const index = next++;
      const instance = selected[index];
      if (!instance) continue;
      const target = allowedUrl(instance.publicUrl, options.allowInsecure);
      const outcome: QueryOutcome =
        'reason' in target
          ? { kind: 'not_queried', reason: target.reason }
          : await queryInstance(target.url, readHealthSecret(options.envsDir, instance.id), {
              fetch: options.fetch,
              timeoutMs: options.timeoutMs,
            });
      rows[index] = classify(instance, outcome);
    }
  };
  const workers = Math.max(1, Math.min(options.concurrency ?? 8, selected.length));
  await Promise.all(Array.from({ length: workers }, worker));

  return {
    checkedAt: (options.now?.() ?? new Date()).toISOString(),
    ok: rows.every((r) => !r.review),
    instances: rows,
  };
}
