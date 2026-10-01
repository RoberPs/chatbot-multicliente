import { readdir } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../../../src/cli/backup.js';
import {
  cliEnv,
  seedInstance,
  tempBackupDir,
  testIO,
  TEST_KEY,
  type TempDir,
} from '../../helpers/backup.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';

let test: TestDatabase;
let dir: TempDir;

beforeAll(async () => {
  test = await createTestDatabase();
  await seedInstance(test.db);
});
afterAll(async () => {
  await test.close();
});
beforeEach(async () => {
  dir = await tempBackupDir();
});
afterEach(async () => {
  await dir.remove();
});

describe('pnpm db:backup', () => {
  it('--json imprime el informe en una línea', async () => {
    const io = testIO(cliEnv(test.url, dir.path));
    expect(await main(['--json'], io)).toBe(0);
    expect(io.stdout).toHaveLength(1);
    const report = JSON.parse(io.stdout[0] ?? '{}') as Record<string, unknown>;
    expect(report).toMatchObject({ ok: true, reason: 'manual', schema: '0005_config_transfer' });
    expect(await readdir(dir.path)).toEqual([report.file]);
    expect(io.all()).not.toContain(TEST_KEY);
  });

  it('la salida legible trae nombre, tamaño, esquema, núcleo, fecha local y recuentos', async () => {
    const io = testIO(cliEnv(test.url, dir.path));
    expect(await main([], io)).toBe(0);
    const [first, second, third] = io.stdout;
    expect(first).toMatch(
      /^Copia creada: test-01__0005_config_transfer__\d{8}T\d{6}Z__manual\.cbak$/,
    );
    expect(second).toMatch(
      /Tamaño: [\d,]+ (B|KB|MB) · Esquema: 0005_config_transfer · Núcleo: \d+\.\d+\.\d+ · \d{4}-\d{2}-\d{2} \d{2}:\d{2} \(Europe\/Madrid\)/,
    );
    expect(third).toContain('business 1');
    expect(third).toContain('conversation 3');
    expect(io.stdout[3]).toBe('  Retención (7 días): 0 copias borradas, 1 conservadas.');
    expect(io.all()).not.toContain(TEST_KEY);
  });

  it('sin configuración de copias → código 1 con el mensaje de key_missing', async () => {
    const io = testIO(
      cliEnv(test.url, dir.path, {
        INSTANCE_ID: undefined,
        BACKUP_DIR: undefined,
        BACKUP_KEY: undefined,
      }),
    );
    expect(await main([], io)).toBe(1);
    expect(io.stderr[0]).toBe(
      'Falta BACKUP_KEY. Genérala con openssl rand -hex 32 y guárdala fuera del directorio de copias.',
    );
    expect(await readdir(dir.path)).toEqual([]);
  });

  it('BACKUP_RETENTION_DAYS=31 → código 2 con el mensaje del máximo', async () => {
    const io = testIO(cliEnv(test.url, dir.path, { BACKUP_RETENTION_DAYS: '31' }));
    expect(await main([], io)).toBe(2);
    expect(io.stderr.join('\n')).toContain(
      'BACKUP_RETENTION_DAYS debe estar entre 1 y 30 días (máximo 30)',
    );
  });

  it('un argumento desconocido → código 2', async () => {
    const io = testIO(cliEnv(test.url, dir.path));
    expect(await main(['--todo'], io)).toBe(2);
  });

  it('directorio inexistente → código 1 con su mensaje', async () => {
    const io = testIO(cliEnv(test.url, `${dir.path}-no-existe`));
    expect(await main([], io)).toBe(1);
    expect(io.stderr[0]).toBe('El directorio de copias (BACKUP_DIR) no existe.');
  });
});
