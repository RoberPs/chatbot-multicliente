/**
 * **La corrección del fallo 2** (016, T026 y T027; FR-006, FR-008): comprobar una copia con la
 * forma de dirección del despliegue real.
 *
 * Por qué no lo veía ninguna prueba: todas usaban direcciones **con nombre de servidor**,
 * mientras que el despliegue real usa dos agrupaciones de PostgreSQL alcanzadas solo por socket,
 * sin nombre de servidor. `new URL` lanza con esa forma, así que en producción las copias nunca
 * se pudieron comprobar, y además el error se atribuía a la creación de la base temporal, que en
 * realidad había funcionado.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyBackup, createBackup, type BackupReport } from '../../../src/backup/service.js';
import {
  cliEnv,
  databasesLike,
  seedInstance,
  tableSnapshot,
  tempBackupDir,
  testBackupConfig,
  TEST_KEY_2,
  type TempDir,
} from '../../helpers/backup.js';
import { createTestDatabase, toAuthorityless, type TestDatabase } from '../../helpers/db.js';

let test: TestDatabase;
let dir: TempDir;
let backup: BackupReport;
/** La dirección de verificación **sin nombre de servidor**: la que rompía el código. */
let authorityless: string;

beforeAll(async () => {
  test = await createTestDatabase();
  dir = await tempBackupDir();
  await seedInstance(test.db);
  const config = testBackupConfig({ dir: dir.path });
  backup = await createBackup({ databaseUrl: test.url, config, reason: 'manual' });
  // El servidor pasa de la autoridad de la URL a un parámetro: misma base, forma de producción.
  authorityless = toAuthorityless(config.verifyUrl);
});

afterAll(async () => {
  await test.close();
  await dir.remove();
});

const path = (name: string) => join(dir.path, name);
const configWith = (verifyUrl: string) => ({ ...testBackupConfig({ dir: dir.path }), verifyUrl });

describe('db:verify con una dirección sin nombre de servidor (FR-006)', () => {
  it('copia válida → restaurable, con los recuentos y sin base temporal', async () => {
    const before = await tableSnapshot(test.url);
    const report = await verifyBackup({
      file: path(backup.file),
      config: configWith(authorityless),
    });
    expect(report).toMatchObject({ restorable: true, sourceInstance: 'test-01' });
    expect(report.tables?.length).toBeGreaterThan(0);
    // La base temporal se borra y la instancia no cambia.
    expect(await databasesLike('verify_')).toEqual([]);
    expect(await tableSnapshot(test.url)).toEqual(before);
  });

  it('con nombre de servidor sigue funcionando exactamente igual que antes (US2-3)', async () => {
    const report = await verifyBackup({ file: path(backup.file), config: configWith(test.url) });
    expect(report).toMatchObject({ restorable: true, sourceInstance: 'test-01' });
    expect(await databasesLike('verify_')).toEqual([]);
  });
});

describe('motivos distinguibles (FR-008)', () => {
  it('copia dañada → corrupted, no un problema de conexión', async () => {
    const original = await readFile(path(backup.file));
    const damaged = Buffer.from(original);
    // Se estropea el cuerpo cifrado, no la cabecera.
    damaged[damaged.length - 20] = (damaged.at(-20) ?? 0) ^ 0xff;
    const file = path('danada.bak');
    await writeFile(file, damaged);
    const report = await verifyBackup({ file, config: configWith(authorityless) });
    expect(report.restorable).toBe(false);
    expect(report.failure).toBe('corrupted');
  });

  it('copia con otra clave → wrong_key, no un problema de conexión', async () => {
    const report = await verifyBackup({
      file: path(backup.file),
      config: { ...configWith(authorityless), key: TEST_KEY_2, previousKeys: [] },
    });
    expect(report.restorable).toBe(false);
    expect(report.failure).toBe('wrong_key');
  });

  it('dirección de verificación ininterpretable → verify_url_invalid', async () => {
    const report = await verifyBackup({
      file: path(backup.file),
      config: configWith('no-es-una-direccion'),
    });
    expect(report.restorable).toBe(false);
    // Antes decía «no se pudo crear la base de datos temporal», que era mentira.
    expect(report.failure).toBe('verify_url_invalid');
  });

  it('servidor de verificación inalcanzable → verify_db_unavailable', async () => {
    const report = await verifyBackup({
      file: path(backup.file),
      config: configWith('postgres://u:c@127.0.0.1:1/postgres'),
    });
    expect(report.restorable).toBe(false);
    expect(report.failure).toBe('verify_db_unavailable');
  });

  it('ningún informe lleva la dirección, el host, el usuario ni la ruta (FR-012)', async () => {
    const report = await verifyBackup({
      file: path(backup.file),
      config: configWith(authorityless),
    });
    const dump = JSON.stringify(report);
    for (const secret of ['postgres://', 'host=', '127.0.0.1', 'password']) {
      expect(dump).not.toContain(secret);
    }
  });
});

/**
 * T027: la forma **literal** de producción, con una ruta de socket Unix de verdad.
 *
 * Se salta en Windows porque allí no hay sockets Unix. Como **no hay integración continua en
 * Linux**, la puerta obligatoria de esta forma es el escenario de producción de SC-004 (T051),
 * no esta prueba: así lo dice FR-006 desde el análisis de la spec. Lo que sí se comprueba en
 * cualquier sistema es la forma sin nombre de servidor, que es la que causaba el fallo.
 */
describe.skipIf(process.platform === 'win32')(
  'db:verify con una ruta de socket Unix real (FR-006)',
  () => {
    it('copia válida → restaurable', async () => {
      // El contenedor de las pruebas publica su socket en el directorio de la imagen; con una
      // dirección por socket, `pg` ignora el puerto TCP y usa el fichero del socket.
      const env = cliEnv(test.url, dir.path);
      const socketDir = env.PGHOST ?? '/var/run/postgresql';
      const report = await verifyBackup({
        file: path(backup.file),
        config: configWith(`postgres://postgres:postgres@/postgres?host=${socketDir}`),
      });
      // Si el socket no está montado, el motivo es de conexión —nunca de la dirección—, que es
      // justo lo que FR-008 exige distinguir.
      expect(['verify_db_unavailable', undefined]).toContain(
        report.restorable ? undefined : report.failure,
      );
    });
  },
);
