import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertCaReadable,
  classifyDatabaseUrl,
  DatabaseConfigError,
  describeDatabaseError,
  requiresVerifiedTls,
  withDatabaseName,
} from '../../../src/config/database-url.js';

const base = (host: string, query = '') => `postgres://usuario:clave@${host}:5432/basex${query}`;

describe('classifyDatabaseUrl: host local o remoto (013, R1)', () => {
  it.each([
    ['localhost', base('localhost')],
    ['LOCALHOST', base('LOCALHOST')],
    ['127.0.0.1', base('127.0.0.1')],
    ['127.0.0.5', base('127.0.0.5')],
    ['127.255.255.254', base('127.255.255.254')],
    ['[::1]', base('[::1]')],
    ['[0:0:0:0:0:0:0:1]', base('[0:0:0:0:0:0:0:1]')],
    ['socket por ?host=', 'postgres:///basex?host=/var/run/postgresql'],
    ['socket con usuario y host vacío', 'postgres://usuario:clave@/basex?host=/var/run/postgresql'],
    ['socket codificado', 'postgres://usuario@%2Fvar%2Frun%2Fpostgresql/basex'],
  ])('%s es local', (_name, url) => {
    const c = classifyDatabaseUrl(url);
    expect(c).toMatchObject({ kind: 'ok', local: true });
  });

  it.each([
    ['10.0.0.5', base('10.0.0.5')],
    ['192.168.1.10', base('192.168.1.10')],
    ['128.0.0.1', base('128.0.0.1')],
    ['db.interna', base('db.interna')],
    ['[fd00::1]', base('[fd00::1]')],
    ['?host= remoto aunque la URL diga localhost', base('localhost', '?host=db.interna')],
  ])('%s es remoto', (_name, url) => {
    expect(classifyDatabaseUrl(url)).toMatchObject({ kind: 'ok', local: false });
  });
});

describe('classifyDatabaseUrl: TLS verificado', () => {
  it('solo con un único sslmode=verify-full', () => {
    expect(classifyDatabaseUrl(base('db.interna', '?sslmode=verify-full'))).toMatchObject({
      verifiedTls: true,
    });
  });

  it.each([
    ['require', '?sslmode=require'],
    ['verify-ca', '?sslmode=verify-ca'],
    ['prefer', '?sslmode=prefer'],
    ['allow', '?sslmode=allow'],
    ['disable', '?sslmode=disable'],
    ['ssl=true', '?ssl=true'],
    ['repetido', '?sslmode=verify-full&sslmode=verify-full'],
    ['repetido con otro', '?sslmode=disable&sslmode=verify-full'],
    ['mayúsculas', '?sslmode=VERIFY-FULL'],
    ['sin sslmode', ''],
  ])('%s no es TLS verificado', (_name, query) => {
    const c = classifyDatabaseUrl(base('db.interna', query));
    expect(c).toMatchObject({ kind: 'ok', verifiedTls: false });
    expect(requiresVerifiedTls(c)).toBe(true);
  });

  it('un host local nunca requiere TLS', () => {
    expect(requiresVerifiedTls(classifyDatabaseUrl(base('127.0.0.1')))).toBe(false);
    expect(
      requiresVerifiedTls(classifyDatabaseUrl(base('db.interna', '?sslmode=verify-full'))),
    ).toBe(false);
  });

  it('caFile es el valor de sslrootcert o null', () => {
    expect(
      classifyDatabaseUrl(
        base('db.interna', '?sslmode=verify-full&sslrootcert=/etc/chatbot/ca.crt'),
      ),
    ).toMatchObject({ caFile: '/etc/chatbot/ca.crt' });
    expect(classifyDatabaseUrl(base('db.interna'))).toMatchObject({ caFile: null });
  });
});

describe('classifyDatabaseUrl: URL no válidas', () => {
  it.each([
    ['mysql', 'mysql://usuario:clave@db.interna/basex'],
    ['sin esquema', 'db.interna:5432/basex'],
    ['texto', 'no es una url'],
    ['sin host ni socket', 'postgres://'],
    ['sin host ni socket con base', 'postgres:///basex'],
  ])('%s', (_name, url) => {
    expect(classifyDatabaseUrl(url)).toEqual({ kind: 'invalid' });
    expect(requiresVerifiedTls(classifyDatabaseUrl(url))).toBe(false);
  });
});

describe('assertCaReadable', () => {
  let dir: string;
  let caPath: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ca-'));
    caPath = join(dir, 'ca.crt');
    await writeFile(caPath, 'certificado');
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it('no hace nada sin sslrootcert', () => {
    expect(() => {
      assertCaReadable(base('db.interna'), 'DATABASE_URL');
    }).not.toThrow();
  });

  it('pasa con un fichero legible', () => {
    const url = base(
      'db.interna',
      `?sslmode=verify-full&sslrootcert=${encodeURIComponent(caPath)}`,
    );
    expect(() => {
      assertCaReadable(url, 'DATABASE_URL');
    }).not.toThrow();
  });

  it('con una ruta inexistente lanza ca_unreadable sin la ruta', () => {
    const missing = '/ruta/secreta/no-existe.crt';
    const url = base('db.interna', `?sslmode=verify-full&sslrootcert=${missing}`);
    let error: unknown;
    try {
      assertCaReadable(url, 'BACKUP_VERIFY_URL');
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(DatabaseConfigError);
    const e = error as DatabaseConfigError;
    expect(e.reason).toBe('ca_unreadable');
    expect(e.variable).toBe('BACKUP_VERIFY_URL');
    expect(e.message).toBe(
      'BACKUP_VERIFY_URL: no se puede leer el certificado de la autoridad indicado en sslrootcert.',
    );
    expect(e.action).toBe(
      'Monta el fichero en el contenedor (solo lectura) y comprueba la ruta y sus permisos.',
    );
    expect(`${e.message} ${e.action}`).not.toContain('secreta');
  });
});

describe('describeDatabaseError (por código, nunca por el texto)', () => {
  const withCode = (code: string, message = 'Hostname/IP does not match: db.interna, 10.0.0.5') =>
    Object.assign(new Error(message), { code });

  it.each([
    'ERR_TLS_CERT_ALTNAME_INVALID',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    'CERT_HAS_EXPIRED',
    'CERT_NOT_YET_VALID',
  ])('%s → tls_untrusted', (code) => {
    const e = describeDatabaseError(withCode(code), 'DATABASE_URL');
    expect(e.reason).toBe('tls_untrusted');
    expect(e.message).toBe(
      'DATABASE_URL: el certificado del servidor no es válido para ese nombre o no lo firma una autoridad de confianza.',
    );
    expect(e.action).toBe('Revisa el nombre del servidor en la URL y sslrootcert.');
    expect(`${e.message} ${e.action}`).not.toMatch(/db\.interna|10\.0\.0\.5/);
  });

  it('el código en un cause anidado también cuenta', () => {
    const outer = new Error('fallo al conectar con db.interna', {
      cause: withCode('CERT_HAS_EXPIRED'),
    });
    expect(describeDatabaseError(outer, 'DATABASE_URL').reason).toBe('tls_untrusted');
  });

  it('el servidor sin TLS → tls_unsupported', () => {
    const e = describeDatabaseError(
      new Error('The server does not support SSL connections'),
      'BACKUP_VERIFY_URL',
    );
    expect(e.reason).toBe('tls_unsupported');
    expect(e.message).toBe('BACKUP_VERIFY_URL: el servidor no acepta conexiones TLS.');
    expect(e.action).toBe('Activa TLS en el servidor PostgreSQL.');
  });

  it.each([
    ['ECONNREFUSED', withCode('ECONNREFUSED', 'connect ECONNREFUSED 10.0.0.5:5432')],
    ['ENOTFOUND', withCode('ENOTFOUND', 'getaddrinfo ENOTFOUND db.interna')],
    ['sin código', new Error('Connection terminated unexpectedly db.interna')],
    ['no es un Error', 'db.interna'],
  ])('%s → unreachable', (_name, error) => {
    const e = describeDatabaseError(error, 'DATABASE_URL');
    expect(e.reason).toBe('unreachable');
    expect(e.message).toBe('DATABASE_URL: no se puede conectar con la base de datos.');
    expect(e.action).toBe(
      'Comprueba que el servidor está en marcha y accesible desde la instancia.',
    );
    expect(`${e.message} ${e.action}`).not.toMatch(/db\.interna|10\.0\.0\.5/);
  });

  it('un DatabaseConfigError se devuelve tal cual', () => {
    const original = new DatabaseConfigError('ca_unreadable', 'DATABASE_URL');
    expect(describeDatabaseError(original, 'BACKUP_VERIFY_URL')).toBe(original);
  });
});

describe('classifyDatabaseUrl: IP literal remota (aclaración posterior)', () => {
  it.each([
    ['IPv4', base('10.0.0.5', '?sslmode=verify-full')],
    ['IPv6', base('[fd00::1]', '?sslmode=verify-full')],
  ])('%s con verify-full no cuenta como TLS verificado', (_name, url) => {
    const c = classifyDatabaseUrl(url);
    expect(c).toMatchObject({ kind: 'ok', local: false, verifiedTls: false, ipHost: true });
    expect(requiresVerifiedTls(c)).toBe(true);
  });

  it('un nombre no es ipHost y una IP local no requiere TLS', () => {
    expect(classifyDatabaseUrl(base('db.interna', '?sslmode=verify-full'))).toMatchObject({
      ipHost: false,
      verifiedTls: true,
    });
    for (const host of ['127.0.0.1', '[::1]']) {
      expect(requiresVerifiedTls(classifyDatabaseUrl(base(host)))).toBe(false);
    }
  });
});

/**
 * `withDatabaseName` (016, T004; FR-011, SC-007): la misma dirección apuntando a otra base, con
 * las **tres** formas de dirección de la spec. Es la corrección del fallo 2: `new URL` lanza con
 * las dos formas sin servidor, que son las del despliegue real.
 */
describe('withDatabaseName: las tres formas de dirección', () => {
  const casos: Array<[string, string, string]> = [
    [
      'con nombre de servidor',
      'postgres://u:c@servidor:5432/base?sslmode=verify-full',
      'postgres://u:c@servidor:5432/otra?sslmode=verify-full',
    ],
    [
      'con autoridad vacía (servidor en parámetro)',
      'postgres://u:c@/base?host=localhost&port=5433',
      'postgres://u:c@/otra?host=localhost&port=5433',
    ],
    [
      'con ruta de socket Unix',
      'postgres://u:c@/base?host=/var/run/postgresql',
      'postgres://u:c@/otra?host=/var/run/postgresql',
    ],
  ];

  it.each(casos)('%s', (_nombre, url, esperada) => {
    expect(withDatabaseName(url, 'otra')).toBe(esperada);
  });

  it('conserva usuario, contraseña, puerto y todos los parámetros en su orden', () => {
    const url =
      'postgres://oper%40dor:cl%2Fave@/base?host=/var/run/postgresql&port=6432&sslmode=verify-full&sslrootcert=/ca/ca.crt';
    const result = withDatabaseName(url, 'verify_1');
    expect(result).not.toBeNull();
    expect(result).toBe(
      'postgres://oper%40dor:cl%2Fave@/verify_1?host=/var/run/postgresql&port=6432&sslmode=verify-full&sslrootcert=/ca/ca.crt',
    );
    // La clasificación de la 013 sigue leyendo lo mismo de la dirección reconstruida.
    expect(classifyDatabaseUrl(result ?? '')).toMatchObject({
      kind: 'ok',
      local: true,
      caFile: '/ca/ca.crt',
    });
  });

  it.each(casos.map(([nombre, url]) => [nombre, url] as const))(
    'es idempotente con el mismo nombre de base: %s',
    (_nombre, url) => {
      expect(withDatabaseName(url, 'base')).toBe(url);
    },
  );

  it.each([
    ['protocolo ajeno', 'mysql://u:c@servidor/base'],
    ['texto no interpretable', 'no es una dirección'],
    ['vacío', ''],
    ['solo el esquema', 'postgres://'],
  ])('devuelve null sin lanzar: %s', (_nombre, url) => {
    expect(withDatabaseName(url, 'otra')).toBeNull();
  });

  it('no lleva la dirección a ningún mensaje: no lanza nunca (FR-012)', () => {
    for (const url of ['', 'basura', 'postgres://u:c@/base?host=/var/run/postgresql']) {
      expect(() => withDatabaseName(url, 'x')).not.toThrow();
    }
  });
});
