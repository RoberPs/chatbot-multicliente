/**
 * Validación de un entorno antes de desplegar (007, US1, research R2 y R5,
 * contracts/check-result.md). Reutiliza el esquema del arranque (`checkEnv`) y añade las reglas
 * de alta: modo producción, `https`, calidad de cada secreto, repeticiones dentro del entorno y
 * comparación por huellas con el resto de instancias del inventario. Funciones puras: reciben el
 * entorno y el inventario ya leídos y nunca escriben (FR-009) ni muestran un valor (FR-007).
 */
import { checkEnv, INSTANCE_ID_PATTERN, type EnvIssue } from '../config/env.js';
import type { EnvMap } from './env-file.js';
import {
  databaseIdentity,
  databasePassword,
  envFingerprints,
  envValues,
  type Fingerprint,
} from './fingerprint.js';
import type { Instance, Inventory, InventoryAccess } from './inventory.js';
import { CHECK_CATALOG, type CheckCode, type MessageContext } from './messages.js';
import { secretQuality } from './secrets.js';

export interface Finding {
  code: CheckCode;
  variable: string | null;
  otherInstance?: string;
  otherVariable?: string;
  otherCurrent?: boolean;
  message: string;
  action: string;
  /** Texto tras `VARIABLE:` en la salida para personas; no va en `--json`. */
  detail?: string;
}

export type Profile = 'production' | 'testing';

export interface CheckResult {
  ok: boolean;
  instanceId: string | null;
  profile: Profile;
  compared: boolean;
  comparedWith: number;
  errors: Finding[];
  warnings: Finding[];
}

export function finding(code: CheckCode, ctx: MessageContext = {}): Finding {
  const entry = CHECK_CATALOG[code];
  return {
    code,
    variable: ctx.variable ?? null,
    ...(ctx.otherInstance === undefined
      ? {}
      : {
          otherInstance: ctx.otherInstance,
          otherVariable: ctx.otherVariable,
          otherCurrent: ctx.otherCurrent,
        }),
    message: entry.message(ctx),
    action: entry.action(ctx),
    ...(entry.detail ? { detail: entry.detail(ctx) } : {}),
  };
}

/** Errores y advertencias sin repetir la misma (código, variable, otra instancia y variable). */
class Findings {
  readonly errors: Finding[] = [];
  readonly warnings: Finding[] = [];
  private readonly seen = new Set<string>();

  add(list: 'errors' | 'warnings', f: Finding): void {
    const key = `${f.code}|${f.variable ?? ''}|${f.otherInstance ?? ''}|${f.otherVariable ?? ''}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this[list].push(f);
  }

  error(code: CheckCode, ctx: MessageContext = {}): void {
    this.add('errors', finding(code, ctx));
  }

  warning(code: CheckCode, ctx: MessageContext = {}): void {
    this.add('warnings', finding(code, ctx));
  }

  hasError(variable: string): boolean {
    return this.errors.some((e) => e.variable === variable);
  }
}

const present = (value: string | undefined): value is string =>
  value !== undefined && value.trim() !== '';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Variable del entorno de la que sale un valor del inventario. */
function envVariable(inventoryVariable: string): string {
  return inventoryVariable === 'DATABASE' ||
    inventoryVariable === 'DATABASE_USER' ||
    inventoryVariable === 'DATABASE_PASSWORD'
    ? 'DATABASE_URL'
    : inventoryVariable;
}

// ---------------------------------------------------------------------------
// Coherencia (reglas del núcleo + reglas de alta)
// ---------------------------------------------------------------------------

/** Traduce una incidencia del núcleo por su regla, nunca por el texto del mensaje (R2). */
function translateCoreIssue(issue: EnvIssue, profile: Profile, out: Findings): void {
  const variable = issue.variable;
  switch (issue.rule) {
    case 'missing':
    case 'backup_required':
    case 'backup_incomplete':
    case 'emergency_phone_required':
      out.error('missing', { variable });
      return;
    case 'whatsapp_incomplete':
    case 'smtp_incomplete':
    case 'llm_key_required':
    case 'backup_key_equals_session':
    case 'trust_proxy_all':
      out.error(issue.rule, { variable });
      return;
    case 'public_url_invalid':
      if (profile === 'production') {
        out.error('public_url_not_https', { variable });
        return;
      }
      break;
    default:
      break;
  }
  out.error('core_rule', { variable, coreMessage: issue.message });
}

/** Variables obligatorias del alta (FR-002), aunque el esquema no llegue a evaluarlas. */
const REQUIRED = [
  'DATABASE_URL',
  'OPERATOR_PASSWORD_HASH',
  'SESSION_SECRET',
  'NODE_ENV',
  'INSTANCE_ID',
  'BACKUP_DIR',
  'BACKUP_KEY',
];

function coherence(env: EnvMap, profile: Profile, out: Findings): void {
  for (const issue of checkEnv(env)) translateCoreIssue(issue, profile, out);

  const required = profile === 'production' ? [...REQUIRED, 'PUBLIC_BASE_URL'] : REQUIRED;
  for (const variable of required) {
    if (!present(env[variable])) out.error('missing', { variable });
  }
  if (present(env.ANTHROPIC_API_KEY) && !present(env.EMERGENCY_CONTACT_PHONE)) {
    out.error('missing', { variable: 'EMERGENCY_CONTACT_PHONE' });
  }

  if (profile === 'production') {
    if (present(env.NODE_ENV) && env.NODE_ENV.trim() !== 'production') {
      out.error('not_production', { variable: 'NODE_ENV' });
    }
    if (present(env.PUBLIC_BASE_URL) && !isPublicHttps(env.PUBLIC_BASE_URL)) {
      out.error('public_url_not_https', { variable: 'PUBLIC_BASE_URL' });
    }
    const proxy = env.TRUST_PROXY?.trim() ?? '';
    if (proxy === '' || proxy === 'false')
      out.warning('trust_proxy_empty', { variable: 'TRUST_PROXY' });
  }

  const db = databaseIdentity(env.DATABASE_URL);
  if (db) {
    if (db.user === 'postgres') out.warning('database_superuser', { variable: 'DATABASE_URL' });
    if (profile === 'production' && LOCAL_HOSTS.has(db.host)) {
      out.warning('database_localhost', { variable: 'DATABASE_URL' });
    }
  }

  if (!present(env.ANTHROPIC_API_KEY) && !out.hasError('ANTHROPIC_API_KEY')) {
    out.warning('pending_optional', { variable: 'ANTHROPIC_API_KEY' });
  }
  if (!present(env.SMTP_URL) && !present(env.SMTP_FROM)) {
    out.warning('pending_optional', { variable: 'SMTP_URL' });
  }
  const whatsapp = [
    'WHATSAPP_PHONE_NUMBER_ID',
    'WHATSAPP_ACCESS_TOKEN',
    'WHATSAPP_APP_SECRET',
    'WHATSAPP_VERIFY_TOKEN',
    'WHATSAPP_GRAPH_VERSION',
  ];
  if (whatsapp.every((v) => !present(env[v]))) {
    out.warning('pending_optional', { variable: 'WHATSAPP_PHONE_NUMBER_ID' });
  }
}

function isPublicHttps(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' && !LOCAL_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

/** Secretos a revisar: (variable del entorno, valor). Para la BD, su contraseña. */
function secretEntries(env: EnvMap): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  for (const variable of [
    'SESSION_SECRET',
    'BACKUP_KEY',
    'OPERATOR_PASSWORD_HASH',
    'ANTHROPIC_API_KEY',
    'WHATSAPP_ACCESS_TOKEN',
    'WHATSAPP_APP_SECRET',
    'WHATSAPP_VERIFY_TOKEN',
    'STT_API_KEY',
  ]) {
    const value = env[variable];
    if (present(value)) entries.push([variable, value]);
  }
  for (const previous of (env.BACKUP_KEYS_PREVIOUS ?? '').split(',')) {
    if (present(previous)) entries.push(['BACKUP_KEYS_PREVIOUS', previous]);
  }
  const password = databasePassword(env.DATABASE_URL);
  if (password !== null) entries.push(['DATABASE_URL', password]);
  return entries;
}

function quality(env: EnvMap, out: Findings): void {
  const reported = new Set(out.errors.map((e) => e.variable));
  for (const [variable, value] of secretEntries(env)) {
    // Si el núcleo ya rechaza la variable, no se repite como secreto débil.
    if (reported.has(variable)) continue;
    for (const q of secretQuality(variable, value)) {
      if (q.severity === 'error') out.error(q.code, { variable });
      else out.warning(q.code, { variable });
    }
  }
}

/** Dos variables secretas del mismo entorno con el mismo valor (`secret_reused_within`). */
function reusedWithin(env: EnvMap, out: Findings): void {
  const seen = new Map<string, string>();
  for (const v of envValues(env)) {
    if (v.class !== 'secret') continue;
    const first = seen.get(v.normalized);
    if (first === undefined) {
      seen.set(v.normalized, v.variable);
      continue;
    }
    const pair = new Set([first, v.variable]);
    // BACKUP_KEY = SESSION_SECRET ya lo detecta la regla del núcleo.
    if (pair.has('BACKUP_KEY') && pair.has('SESSION_SECRET')) continue;
    if (first === v.variable) continue;
    out.error('secret_reused_within', { variable: envVariable(v.variable), otherVariable: first });
  }
}

// ---------------------------------------------------------------------------
// Comparación con el inventario (R5)
// ---------------------------------------------------------------------------

export interface Comparison {
  errors: Finding[];
  warnings: Finding[];
  comparedWith: number;
}

/**
 * Compara las huellas de un entorno con las de las demás instancias (vigentes y anteriores,
 * también las dadas de baja). La instancia `selfId` no cuenta.
 */
export function compare(
  fingerprints: Fingerprint[],
  inventory: Inventory,
  selfId: string | null,
): Comparison {
  const out = new Findings();
  const others = inventory.instances.filter((i) => i.id !== selfId);
  for (const other of others) {
    for (const mine of fingerprints) {
      for (const theirs of other.fingerprints) {
        if (theirs.class !== mine.class || theirs.value !== mine.value) continue;
        const ctx: MessageContext = {
          variable: envVariable(mine.variable),
          otherInstance: other.id,
          otherVariable: theirs.variable,
          otherCurrent: theirs.current,
        };
        switch (mine.class) {
          case 'secret':
            if (mine.variable === 'SMTP_URL' && theirs.variable === 'SMTP_URL') {
              out.warning('shared_smtp', ctx);
            } else out.error('duplicate_secret', ctx);
            break;
          case 'database':
            out.error('duplicate_database', ctx);
            break;
          case 'database_user':
            out.error('duplicate_database_user', ctx);
            break;
          case 'public_url':
            out.error('duplicate_public_url', ctx);
            break;
          case 'whatsapp_phone':
            out.error('duplicate_whatsapp_phone', ctx);
            break;
          case 'backup_dir':
            out.warning('shared_backup_dir', ctx);
            break;
        }
      }
    }
  }
  return { errors: out.errors, warnings: out.warnings, comparedWith: others.length };
}

/**
 * ¿Es este entorno la instancia del inventario con su mismo `INSTANCE_ID`? Sí si comparte con
 * ella al menos una huella (vigente o anterior) o si ella no tiene ninguna. Si no comparte nada,
 * es otra instancia que reutiliza el identificador (`duplicate_instance_id`).
 */
export function isSameInstance(fingerprints: Fingerprint[], instance: Instance): boolean {
  if (instance.fingerprints.length === 0) return true;
  return fingerprints.some((mine) =>
    instance.fingerprints.some((t) => t.class === mine.class && t.value === mine.value),
  );
}

// ---------------------------------------------------------------------------
// Resultado
// ---------------------------------------------------------------------------

/** Valida un entorno contra las reglas del núcleo, las de alta y el inventario. */
export function validate(
  env: EnvMap,
  access: InventoryAccess,
  options: { today?: string } = {},
): CheckResult {
  const rawId = env.INSTANCE_ID?.trim() ?? '';
  const instanceId = INSTANCE_ID_PATTERN.test(rawId) ? rawId : null;
  const out = new Findings();

  const inventory = access.kind === 'ok' ? access.inventory : null;
  const registered =
    inventory && instanceId !== null
      ? inventory.instances.find((i) => i.id === instanceId)
      : undefined;
  const profile: Profile = registered?.status === 'testing' ? 'testing' : 'production';

  coherence(env, profile, out);
  quality(env, out);
  reusedWithin(env, out);

  let compared = false;
  let comparedWith = 0;
  switch (access.kind) {
    case 'absent':
      out.warning('not_compared', { path: access.path });
      break;
    case 'unreadable':
      out.error('inventory_unreadable', { reason: access.reason, path: access.path });
      break;
    case 'key_missing':
      out.error('inventory_key_missing', { path: access.path });
      break;
    case 'key_wrong':
      out.error('inventory_key_wrong', { path: access.path });
      break;
    case 'ok': {
      compared = true;
      const fps = envFingerprints(env, access.key, options.today ?? '1970-01-01');
      let selfId: string | null = null;
      if (registered) {
        if (isSameInstance(fps, registered)) {
          selfId = registered.id;
          if (registered.status === 'retired') {
            out.warning('retired_instance', { variable: 'INSTANCE_ID', id: registered.id });
          }
        } else {
          out.error('duplicate_instance_id', {
            variable: 'INSTANCE_ID',
            otherInstance: registered.id,
          });
        }
      } else if (instanceId !== null) {
        out.warning('not_registered', { variable: 'INSTANCE_ID', id: instanceId });
      }
      const comparison = compare(fps, access.inventory, selfId);
      comparedWith = comparison.comparedWith;
      for (const e of comparison.errors) out.add('errors', e);
      for (const w of comparison.warnings) out.add('warnings', w);
      break;
    }
  }

  return {
    ok: out.errors.length === 0,
    instanceId,
    profile,
    compared,
    comparedWith,
    errors: out.errors,
    warnings: out.warnings,
  };
}

const withoutDetail = ({ detail: _detail, ...rest }: Finding) => rest;

/** Salida `--json`: una sola línea, sin el texto auxiliar de la salida para personas. */
export function checkResultJson(result: CheckResult): string {
  return JSON.stringify({
    ok: result.ok,
    instanceId: result.instanceId,
    profile: result.profile,
    compared: result.compared,
    comparedWith: result.comparedWith,
    errors: result.errors.map(withoutDetail),
    warnings: result.warnings.map(withoutDetail),
  });
}

function findingLine(mark: string, f: Finding): string[] {
  const text = f.variable === null ? f.message : `${f.variable}: ${f.detail ?? f.message}`;
  return [`  ${mark} ${text}`, `      → ${f.action}`];
}

/** Salida para personas (contracts/check-result.md). */
export function formatCheckResult(result: CheckResult): string {
  const scope = result.compared
    ? `comparado con ${String(result.comparedWith)} ${result.comparedWith === 1 ? 'instancia' : 'instancias'}`
    : 'sin comparar con otras instancias';
  const lines = [
    `Validación de ${result.instanceId ?? '(sin INSTANCE_ID válido)'} (perfil ${result.profile}, ${scope})`,
  ];
  if (result.errors.length > 0) {
    lines.push('', `ERRORES (${String(result.errors.length)})`);
    for (const f of result.errors) lines.push(...findingLine('✗', f));
  }
  if (result.warnings.length > 0) {
    lines.push('', `ADVERTENCIAS (${String(result.warnings.length)})`);
    for (const f of result.warnings) lines.push(...findingLine('!', f));
  }
  lines.push('', result.ok ? 'APTO para desplegar.' : 'NO APTO para desplegar.');
  return lines.join('\n');
}
