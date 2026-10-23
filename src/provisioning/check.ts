/**
 * Validación de un entorno antes de desplegar (007, US1, research R2 y R5,
 * contracts/check-result.md). Reutiliza el esquema del arranque (`checkEnv`) y añade las reglas
 * de alta: modo producción, `https` y comparación por huellas con el resto de instancias del
 * inventario. La calidad de los secretos son las reglas del arranque en producción
 * (`secret-rules.ts`, 012): errores en el perfil `production` y avisos en `testing`. Funciones puras: reciben el
 * entorno y el inventario ya leídos y nunca escriben (FR-009) ni muestran un valor (FR-007).
 *
 * Despliegue seguro (013, contracts/check-rules.md): `TRUST_PROXY` con `https` y TLS verificado
 * en las URL de base de datos remotas, con la misma clasificación que `instance:db` y el arranque.
 */
import {
  classifyDatabaseUrl,
  isVerifyFullOnIp,
  requiresVerifiedTls,
  type DatabaseUrlClassification,
} from '../config/database-url.js';
import { checkEnv, INSTANCE_ID_PATTERN, type EnvIssue } from '../config/env.js';
import { checkSecrets, type SecretRule } from '../config/secret-rules.js';
import type { CredentialVerdict } from '../llm/credential-probe.js';
import {
  isLlmProvider,
  keyVariableOf,
  LLM_PROVIDERS,
  type LlmProvider,
} from '../llm/provider.js';
import type { EnvMap } from './env-file.js';
import { databaseIdentity, envFingerprints, type Fingerprint } from './fingerprint.js';
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
      ? // 012: un secreto repetido dentro del mismo entorno nombra la otra variable.
        ctx.otherVariable === undefined
        ? {}
        : { otherVariable: ctx.otherVariable }
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

/**
 * 017: proveedor declarado en el entorno. Ausente equivale a `anthropic` (FR-003). Un valor no
 * elegible ya lo denuncia el esquema del arranque a través de `checkEnv`, así que aquí se toma el
 * de por omisión para poder seguir comprobando el resto del entorno en lugar de callarse.
 */
function declaredProvider(env: EnvMap): LlmProvider {
  const raw = env.LLM_PROVIDER?.trim() ?? '';
  return isLlmProvider(raw) ? raw : 'anthropic';
}

/** Credencial del proveedor declarado. */
const llmKeyOf = (env: EnvMap): { variable: string; value: string | undefined } => {
  const variable = keyVariableOf(declaredProvider(env));
  return { variable, value: env[variable] };
};

/** Hosts que no pueden ser la URL pública de una instancia. */
const LOCAL_PUBLIC_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

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
  // Las de los secretos las añade `secrets()` en los dos perfiles.
  if (Object.hasOwn(SECRET_CODES, issue.rule)) return;
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
  // 009: sin él no se puede comprobar la versión de la instancia desde el inventario.
  'HEALTH_SECRET',
];

function coherence(env: EnvMap, profile: Profile, out: Findings): void {
  for (const issue of checkEnv(env)) translateCoreIssue(issue, profile, out);

  const required = profile === 'production' ? [...REQUIRED, 'PUBLIC_BASE_URL'] : REQUIRED;
  for (const variable of required) {
    if (!present(env[variable])) out.error('missing', { variable });
  }
  // 017 (FR-005): con bot hay que tener salida a una persona, y «hay bot» es «hay credencial del
  // proveedor declarado», no «hay la credencial de un proveedor concreto».
  if (present(llmKeyOf(env).value) && !present(env.EMERGENCY_CONTACT_PHONE)) {
    out.error('missing', { variable: 'EMERGENCY_CONTACT_PHONE' });
  }

  if (profile === 'production') {
    if (present(env.NODE_ENV) && env.NODE_ENV.trim() !== 'production') {
      out.error('not_production', { variable: 'NODE_ENV' });
    }
    if (present(env.PUBLIC_BASE_URL) && !isPublicHttps(env.PUBLIC_BASE_URL)) {
      out.error('public_url_not_https', { variable: 'PUBLIC_BASE_URL' });
    }
  }

  deployment(env, profile, out);

  if (databaseIdentity(env.DATABASE_URL)?.user === 'postgres') {
    out.warning('database_superuser', { variable: 'DATABASE_URL' });
  }
  const main = present(env.DATABASE_URL) ? classifyDatabaseUrl(env.DATABASE_URL) : null;
  if (profile === 'production' && main?.kind === 'ok' && main.local) {
    out.warning('database_localhost', { variable: 'DATABASE_URL' });
  }

  const llm = llmKeyOf(env);
  if (!present(llm.value) && !out.hasError(llm.variable)) {
    out.warning('pending_optional', { variable: llm.variable });
  }
  // 017 (FR-033): las credenciales de los otros proveedores elegibles se ignoran para funcionar
  // —nunca sirven de respaldo (FR-004)— pero conviene que el operador sepa que están ahí.
  for (const provider of LLM_PROVIDERS) {
    const variable = keyVariableOf(provider);
    if (variable === llm.variable) continue;
    if (present(env[variable])) out.warning('llm_key_unused', { variable });
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

/** URL de base de datos que revisa la regla de TLS, además de `DATABASE_URL`. */
const OPTIONAL_DATABASE_URLS = ['BACKUP_VERIFY_URL', 'INSTANCE_DB_ADMIN_URL'] as const;

/**
 * Reglas de despliegue (013): error en `production` y advertencia en `testing`, salvo una URL
 * opcional mal formada, que es error en los dos. No lee el fichero de `sslrootcert`: su ruta es la
 * del contenedor.
 */
function deployment(env: EnvMap, profile: Profile, out: Findings): void {
  const flag = (
    code: 'trust_proxy_empty' | 'database_tls_required' | 'database_tls_ip_host',
    variable: string,
  ) => {
    if (profile === 'production') out.error(code, { variable });
    else out.warning(code, { variable });
  };

  const proxy = env.TRUST_PROXY?.trim() ?? '';
  if (isHttps(env.PUBLIC_BASE_URL) && (proxy === '' || proxy === 'false')) {
    flag('trust_proxy_empty', 'TRUST_PROXY');
  }

  // Una DATABASE_URL no interpretable ya la señala el esquema del arranque: no se duplica.
  const urls: Array<[string, DatabaseUrlClassification]> = [];
  if (present(env.DATABASE_URL)) urls.push(['DATABASE_URL', classifyDatabaseUrl(env.DATABASE_URL)]);
  for (const variable of OPTIONAL_DATABASE_URLS) {
    const value = env[variable];
    if (!present(value)) continue;
    const c = classifyDatabaseUrl(value);
    if (c.kind === 'invalid') out.error('database_url_invalid', { variable });
    else urls.push([variable, c]);
  }
  for (const [variable, c] of urls) {
    // Con una IP, `verify-full` no comprueba el nombre: código propio, que pide el nombre.
    if (isVerifyFullOnIp(c)) flag('database_tls_ip_host', variable);
    else if (requiresVerifiedTls(c)) flag('database_tls_required', variable);
  }
}

function isHttps(value: string | undefined): boolean {
  if (!present(value)) return false;
  try {
    return new URL(value.trim()).protocol === 'https:';
  } catch {
    return false;
  }
}

function isPublicHttps(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' && !LOCAL_PUBLIC_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

/** Código de `instance:check` de cada regla de los secretos. */
const SECRET_CODES: Record<SecretRule, CheckCode> = {
  too_short: 'secret_too_short',
  example_value: 'secret_example_value',
  trivial: 'secret_trivial',
  reused: 'secret_reused',
  health_secret_required: 'health_secret_required',
};

/**
 * Las mismas incidencias de los secretos que el arranque en producción (FR-035): errores en el
 * perfil `production`; avisos en `testing`, que no bloquean la instancia de pruebas.
 */
function secrets(env: EnvMap, profile: Profile, out: Findings): void {
  for (const f of checkSecrets(env)) {
    // La falta de HEALTH_SECRET ya es `missing` en los dos perfiles (009).
    if (f.rule === 'health_secret_required') continue;
    const ctx = {
      variable: f.variable,
      ...(f.otherVariable ? { otherVariable: f.otherVariable } : {}),
    };
    if (profile === 'production') out.error(SECRET_CODES[f.rule], ctx);
    else out.warning(SECRET_CODES[f.rule], ctx);
  }
}

/**
 * Lo propio de la 007 que no es calidad de un secreto: el formato del hash del operador y el
 * prefijo de la clave del modelo.
 */
function operatorHashAndKeyFormat(env: EnvMap, out: Findings): void {
  const reported = new Set(out.errors.map((e) => e.variable));
  // 017: las **tres** variables de credencial, no solo la de Anthropic, y los dos códigos de forma
  // —el aviso y el error—, no solo el aviso. Dejar pasar `llm_key_other_provider` aquí habría
  // dejado el agujero abierto por el otro lado.
  const LLM_CODES = new Set(['llm_key_format', 'llm_key_other_provider']);
  for (const variable of ['OPERATOR_PASSWORD_HASH', ...LLM_PROVIDERS.map(keyVariableOf)]) {
    const value = env[variable];
    if (!present(value)) continue;
    const already = reported.has(variable);
    for (const q of secretQuality(variable, value)) {
      if (variable !== 'OPERATOR_PASSWORD_HASH' && !LLM_CODES.has(q.code)) continue;
      /**
       * 017: un error de calidad **no silencia** el diagnóstico de «credencial de otro
       * proveedor», y esto no es un detalle estético.
       *
       * El caso real: una clave clásica de Gemini (`AIza…`) tiene **39** caracteres y el mínimo
       * de la variable de Anthropic es **40**, así que al pegarla en esa variable salta primero
       * `secret_too_short`. (El nombre de la variable no se escribe aquí a propósito: la regla C1
       * lo reserva a `src/llm/`, y `tests/unit/llm/seam.test.ts` lo vigila — cazó este comentario.) Con la supresión de la 007 el entorno quedaba **no apto** —el
       * agujero seguía cerrado— pero el mensaje decía «es demasiado corta», y el operador se iba
       * a buscar una clave más larga del proveedor equivocado en lugar de enterarse de que la
       * había puesto en la variable que no era. Es el error más probable, en la comprobación que
       * existe justo para cazarlo.
       *
       * «Parece una credencial de otro proveedor» **explica** la longitud, así que gana el sitio.
       * Los demás códigos siguen suprimidos como en la 007, para no apilar hallazgos.
       */
      if (already && q.code !== 'llm_key_other_provider') continue;
      const ctx: MessageContext = {
        variable,
        ...(q.otherProvider === undefined ? {} : { otherProvider: q.otherProvider }),
      };
      if (q.severity === 'error') out.error(q.code, ctx);
      else out.warning(q.code, ctx);
    }
  }
}

/**
 * 017 (FR-030, FR-030a): el veredicto de la validación opcional.
 *
 * Si no se pidió la validación **no se emite nada**, y eso es lo que hace «no se comprobó»
 * distinguible de «no se pudo comprobar». Un `inconclusive` deja el entorno **apto**: la ausencia
 * de veredicto no es un veredicto.
 */
function credentialVerdict(env: EnvMap, verdict: CredentialVerdict | undefined, out: Findings): void {
  if (verdict === undefined || verdict === 'accepted') return;
  const { variable } = llmKeyOf(env);
  if (verdict === 'rejected') out.error('llm_key_rejected', { variable });
  else out.warning('llm_key_unverified', { variable });
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
 * ella al menos una huella que la identifique (vigente o anterior) o si ella no tiene ninguna. Si
 * no comparte nada, es otra instancia que reutiliza el identificador (`duplicate_instance_id`).
 * `BACKUP_DIR` y `SMTP_URL` no identifican: varias instancias pueden compartirlos (FR-006).
 */
export function isSameInstance(fingerprints: Fingerprint[], instance: Instance): boolean {
  const identifying = (f: Fingerprint) => f.class !== 'backup_dir' && f.variable !== 'SMTP_URL';
  const theirs = instance.fingerprints.filter(identifying);
  if (theirs.length === 0) return true;
  return fingerprints
    .filter(identifying)
    .some((mine) => theirs.some((t) => t.class === mine.class && t.value === mine.value));
}

// ---------------------------------------------------------------------------
// Resultado
// ---------------------------------------------------------------------------

/** Valida un entorno contra las reglas del núcleo, las de alta y el inventario. */
export function validate(
  env: EnvMap,
  access: InventoryAccess,
  /**
   * `credentialVerdict` solo llega con `--validar-credencial`. `validate` sigue siendo
   * **sincrónica y sin red**: la petición la hace quien la llama y aquí solo entra su resultado.
   * Así la comprobación por omisión no puede hacer red ni por accidente (FR-029, SC-009), y nada
   * de esto escribe en ninguna parte (FR-034).
   */
  options: { today?: string; credentialVerdict?: CredentialVerdict } = {},
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
  secrets(env, profile, out);
  operatorHashAndKeyFormat(env, out);
  credentialVerdict(env, options.credentialVerdict, out);

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
