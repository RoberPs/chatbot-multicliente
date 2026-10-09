/**
 * Clasificación de una URL de base de datos y errores de conexión sin datos (013, research R1 y
 * R4, contracts/database-tls.md). Lo comparten `instance:check`, `instance:db`, el arranque y las
 * órdenes de copias, para que la misma URL tenga siempre la misma respuesta. Puro: sin `pg` ni
 * HTTP; solo lee el disco en `assertCaReadable`.
 *
 * Ningún mensaje lleva la URL ni una parte de ella (usuario, contraseña, host, base), la ruta de
 * `sslrootcert` ni los nombres del certificado (FR-006, SC-002).
 */
import { accessSync, constants } from 'node:fs';
import { isIP } from 'node:net';

export type DatabaseUrlClassification =
  | { kind: 'invalid' }
  | {
      kind: 'ok';
      /** `localhost`, `127.0.0.0/8`, `::1` (cualquier forma) o un socket local. */
      local: boolean;
      /**
       * Un único `sslmode`, vale exactamente `verify-full` y el host no es una IP remota: con una
       * IP, `pg` no pasa la dirección a TLS y Node compara el certificado con `localhost`.
       */
      verifiedTls: boolean;
      /** Un único `sslmode` y vale exactamente `verify-full`, sea cual sea el host. */
      verifyFull: boolean;
      /** El host es una IP literal (IPv4 o IPv6). */
      ipHost: boolean;
      /** Valor de `sslrootcert`: solo para comprobar que se puede leer; nunca se muestra. */
      caFile: string | null;
    };

/** Lee la URL como `pg-connection-string`: un host vacío con credenciales también vale (socket). */
function parse(url: string): { url: URL; hostname: string } | null {
  const text = url.trim();
  try {
    const parsed = new URL(text);
    return { url: parsed, hostname: parsed.hostname };
  } catch {
    try {
      return { url: new URL(text.replace('@/', '@___DUMMY___/')), hostname: '' };
    } catch {
      return null;
    }
  }
}

function decode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** `::1` en cualquiera de sus formas (WHATWG URL normaliza la IPv6). */
function isIpv6Loopback(host: string): boolean {
  try {
    return new URL(`http://[${host}]/`).hostname === '[::1]';
  } catch {
    return false;
  }
}

/** `localhost`, `127.0.0.0/8`, `::1` (con o sin corchetes) o la ruta de un socket. */
export function isLocalHost(host: string): boolean {
  if (host.startsWith('/')) return true;
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost') return true;
  switch (isIP(h)) {
    case 4:
      return h.split('.')[0] === '127';
    case 6:
      return isIpv6Loopback(h);
    default:
      return false;
  }
}

export function classifyDatabaseUrl(url: string): DatabaseUrlClassification {
  const parsed = parse(url);
  if (!parsed) return { kind: 'invalid' };
  const { url: u } = parsed;
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') return { kind: 'invalid' };
  // Como en `pg`: el parámetro `host` manda sobre el servidor de la URL.
  const hostParam = u.searchParams.getAll('host').at(-1);
  const host = hostParam ?? decode(parsed.hostname);
  if (host === '') return { kind: 'invalid' };
  const sslmodes = u.searchParams.getAll('sslmode');
  const local = isLocalHost(host);
  const ipHost = isIP(host.replace(/^\[|\]$/g, '')) !== 0;
  const verifyFull = sslmodes.length === 1 && sslmodes[0] === 'verify-full';
  return {
    kind: 'ok',
    local,
    verifiedTls: verifyFull && (local || !ipHost),
    verifyFull,
    ipHost,
    caFile: u.searchParams.getAll('sslrootcert').at(-1) ?? null,
  };
}

/**
 * La misma dirección apuntando a otra base del mismo servidor (016, FR-006, FR-007, research R6).
 *
 * Existe porque `new URL` **lanza** con las direcciones sin nombre de servidor
 * (`postgres://u:c@/base?host=…`), que son las del despliegue real: por eso `db:verify` no se
 * podía usar en producción. Aquí se reutiliza el `parse()` tolerante de este fichero, que ya
 * rodeaba esa limitación para la clasificación, en lugar de dejar que cada módulo tenga su
 * propia versión del problema.
 *
 * Conserva usuario, contraseña, servidor (o su ausencia), puerto y **todos** los parámetros en
 * su orden; solo cambia el nombre de la base. Devuelve `null` —nunca lanza— si la dirección no
 * se puede interpretar o el protocolo no es de PostgreSQL, para que quien llame decida el motivo
 * sin tener que capturar nada ni mostrar la dirección (FR-012).
 */
export function withDatabaseName(url: string, database: string): string | null {
  const parsed = parse(url);
  if (!parsed) return null;
  const { url: u } = parsed;
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') return null;
  const text = url.trim();
  // `parse()` pudo sustituir la autoridad vacía por un servidor de relleno, así que no se puede
  // reconstruir con `u.toString()`: se cambia solo el nombre de la base sobre el texto original.
  const hash = text.indexOf('#');
  const body = hash === -1 ? text : text.slice(0, hash);
  const suffix = hash === -1 ? '' : text.slice(hash);
  const query = body.indexOf('?');
  const authority = query === -1 ? body : body.slice(0, query);
  const search = query === -1 ? '' : body.slice(query);
  // El nombre de la base es lo que va tras la primera `/` después de `//`.
  const start = authority.indexOf('//');
  if (start === -1) return null;
  const slash = authority.indexOf('/', start + 2);
  if (slash === -1) return null;
  return `${authority.slice(0, slash + 1)}${encodeURIComponent(database)}${search}${suffix}`;
}

/** `verify-full` con una IP remota: pide TLS verificado pero no se comprueba el nombre. */
export function isVerifyFullOnIp(classification: DatabaseUrlClassification): boolean {
  return (
    classification.kind === 'ok' &&
    !classification.local &&
    classification.ipHost &&
    classification.verifyFull
  );
}

/** Remota, interpretable y sin TLS verificado: lo que rechazan `instance:check` e `instance:db`. */
export function requiresVerifiedTls(classification: DatabaseUrlClassification): boolean {
  return classification.kind === 'ok' && !classification.local && !classification.verifiedTls;
}

// ---------------------------------------------------------------------------
// Errores de configuración y de conexión
// ---------------------------------------------------------------------------

export type DatabaseConfigReason =
  'ca_unreadable' | 'tls_untrusted' | 'tls_unsupported' | 'unreachable';
export type DatabaseUrlVariable = 'DATABASE_URL' | 'BACKUP_VERIFY_URL';

const TEXTS: Record<DatabaseConfigReason, { message: string; action: string }> = {
  ca_unreadable: {
    message: 'no se puede leer el certificado de la autoridad indicado en sslrootcert.',
    action: 'Monta el fichero en el contenedor (solo lectura) y comprueba la ruta y sus permisos.',
  },
  tls_untrusted: {
    message:
      'el certificado del servidor no es válido para ese nombre o no lo firma una autoridad de confianza.',
    action: 'Revisa el nombre del servidor en la URL y sslrootcert.',
  },
  tls_unsupported: {
    message: 'el servidor no acepta conexiones TLS.',
    action: 'Activa TLS en el servidor PostgreSQL.',
  },
  unreachable: {
    message: 'no se puede conectar con la base de datos.',
    action: 'Comprueba que el servidor está en marcha y accesible desde la instancia.',
  },
};

/** Error de la base de datos con texto fijo: nombra la variable y nada más. */
export class DatabaseConfigError extends Error {
  readonly action: string;

  constructor(
    readonly reason: DatabaseConfigReason,
    readonly variable: DatabaseUrlVariable,
  ) {
    super(`${variable}: ${TEXTS[reason].message}`);
    this.name = 'DatabaseConfigError';
    this.action = TEXTS[reason].action;
  }

  /** Mensaje y acción, como los muestran el arranque y las órdenes. */
  describe(): string {
    return `${this.message}\n→ ${this.action}`;
  }
}

/**
 * Antes de crear ningún cliente: si la URL lleva `sslrootcert`, el fichero debe poder leerse.
 * `pg` lo lee al construir el cliente y su error lleva la ruta.
 */
export function assertCaReadable(url: string, variable: DatabaseUrlVariable): void {
  const c = classifyDatabaseUrl(url);
  if (c.kind !== 'ok' || c.caFile === null) return;
  try {
    accessSync(c.caFile, constants.R_OK);
  } catch {
    throw new DatabaseConfigError('ca_unreadable', variable);
  }
}

/** Códigos de verificación del certificado de Node. */
const TLS_UNTRUSTED = new Set([
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
]);

/**
 * `pg` no da código cuando el servidor rechaza TLS: solo este texto fijo, sin datos. Es la única
 * comparación con un texto, y con uno que no lleva nada de la URL.
 */
const PG_NO_SSL = 'The server does not support SSL connections';

/** El error y sus causas (`cause`, `AggregateError`), sin recorrer más de unos pocos niveles. */
function chain(error: unknown, depth = 0): unknown[] {
  if (depth > 4 || error === null || typeof error !== 'object') return [error];
  const e = error as { cause?: unknown; errors?: unknown };
  const nested = [
    ...(e.cause === undefined ? [] : [e.cause]),
    ...(Array.isArray(e.errors) ? (e.errors as unknown[]) : []),
  ];
  return [error, ...nested.flatMap((n) => chain(n, depth + 1))];
}

/** Traduce un fallo al conectar a un error con texto fijo, por su código (R4). */
export function describeDatabaseError(
  error: unknown,
  variable: DatabaseUrlVariable,
): DatabaseConfigError {
  if (error instanceof DatabaseConfigError) return error;
  const all = chain(error);
  const code = (e: unknown) => (e as { code?: unknown } | null)?.code;
  if (all.some((e) => TLS_UNTRUSTED.has(String(code(e))))) {
    return new DatabaseConfigError('tls_untrusted', variable);
  }
  if (all.some((e) => e instanceof Error && e.message === PG_NO_SSL && code(e) === undefined)) {
    return new DatabaseConfigError('tls_unsupported', variable);
  }
  return new DatabaseConfigError('unreachable', variable);
}
