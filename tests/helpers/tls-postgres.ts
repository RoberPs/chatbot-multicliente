/**
 * PostgreSQL 16 con TLS para las pruebas de la 013 (research R9). El certificado lo genera
 * `openssl` dentro del propio contenedor: una autoridad propia y un certificado de servidor con
 * SAN `DNS:<serverName>` (`localhost` por defecto). La autoridad se copia a un directorio
 * temporal del equipo para usarla en `sslrootcert`.
 *
 * Para probar un nombre fuera del certificado se arranca otro servidor con otro `serverName`: con
 * una IP en la URL no sirve, porque `pg` no pasa la IP a TLS y Node compara el certificado con
 * `localhost`.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

const script = (serverName: string) => `
set -e
mkdir -p /certs && cd /certs
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=autoridad-pruebas" \\
  -keyout ca.key -out ca.crt \\
  -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign"
openssl req -newkey rsa:2048 -nodes -subj "/CN=${serverName}" -keyout server.key -out server.csr
printf "subjectAltName=DNS:${serverName}\\nbasicConstraints=CA:FALSE\\nkeyUsage=digitalSignature,keyEncipherment\\nextendedKeyUsage=serverAuth\\n" > ext.cnf
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 2 \\
  -out server.crt -extfile ext.cnf
chown postgres:postgres server.key server.crt
chmod 600 server.key
exec docker-entrypoint.sh postgres -c ssl=on \\
  -c ssl_cert_file=/certs/server.crt -c ssl_key_file=/certs/server.key
`;

export interface TlsPostgres {
  /** Certificado de la autoridad en el equipo (para `sslrootcert`). */
  caPath: string;
  /**
   * URL de `db` con `sslmode=verify-full&sslrootcert=<caPath>` por defecto. `host` cambia el
   * nombre con el que se conecta (con `127.0.0.1`, `pg` compara el certificado con `localhost`).
   */
  urlFor(db: string, options?: { host?: 'localhost' | '127.0.0.1'; sslrootcert?: string }): string;
  /** URL de administración (`postgres`) con TLS verificado. */
  adminUrl: string;
  stop(): Promise<void>;
}

export async function startTlsPostgres(
  options: { serverName?: string } = {},
): Promise<TlsPostgres> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer('postgres:16')
    // Valores reconocibles para buscarlos en las salidas (SC-002).
    .withUsername('usuario_tls')
    .withPassword('clave_tls_pruebas')
    .withEntrypoint(['bash', '-c', script(options.serverName ?? 'localhost')])
    .withCommand(['postgres'])
    .start();
  const dir = await mkdtemp(join(tmpdir(), 'tls-pg-'));
  const caPath = join(dir, 'ca.crt');
  const ca = await container.exec(['cat', '/certs/ca.crt']);
  if (ca.exitCode !== 0) throw new Error('No se ha podido leer la autoridad del contenedor');
  await writeFile(caPath, ca.stdout);

  const port = container.getPort();
  const urlFor: TlsPostgres['urlFor'] = (db, options = {}) => {
    const url = new URL('postgres://placeholder');
    url.hostname = options.host ?? 'localhost';
    url.port = String(port);
    url.username = container.getUsername();
    url.password = container.getPassword();
    url.pathname = `/${db}`;
    url.searchParams.set('sslmode', 'verify-full');
    url.searchParams.set('sslrootcert', options.sslrootcert ?? caPath);
    return url.toString();
  };
  return {
    caPath,
    urlFor,
    adminUrl: urlFor('postgres'),
    async stop() {
      await container.stop();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
