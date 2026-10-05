import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBackup, type BackupReport } from '../../../src/backup/service.js';
import { main } from '../../../src/cli/restore.js';
import {
  cliEnv,
  seedInstance,
  tableSnapshot,
  tempBackupDir,
  testBackupConfig,
  testIO,
  TEST_KEY,
  TEST_KEY_2,
  type TempDir,
} from '../../helpers/backup.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';
import { eq } from 'drizzle-orm';
import { business } from '../../../src/db/schema.js';

let test: TestDatabase;
let dir: TempDir;
let backup: BackupReport;
let foreign: BackupReport;

beforeAll(async () => {
  test = await createTestDatabase();
  dir = await tempBackupDir();
  await seedInstance(test.db);
  const config = testBackupConfig({ dir: dir.path });
  backup = await createBackup({ databaseUrl: test.url, config, reason: 'manual' });
  foreign = await createBackup({
    databaseUrl: test.url,
    config: { ...config, instanceId: 'otra-02' },
    reason: 'manual',
  });
});
afterAll(async () => {
  await test.close();
  await dir.remove();
});

const rename = () => test.db.update(business).set({ name: 'Cambiado' }).where(eq(business.id, 1));

describe('pnpm db:restore', () => {
  it('sin --yes muestra el resumen y otro identificador cancela sin tocar la BD', async () => {
    await rename();
    const before = await tableSnapshot(test.url);
    const io = testIO(cliEnv(test.url, dir.path), { interactive: true, answers: ['otra-cosa'] });
    expect(await main([backup.file], io)).toBe(1);
    expect(io.stdout[0]).toBe(`Restaurar: ${backup.file}`);
    expect(io.stdout[1]).toMatch(/Copia de la instancia test-01 · esquema 0007_chat_design · núcleo /);
    expect(io.questions[0]).toContain('(test-01)');
    expect(io.stderr).toContain('Cancelado: no se ha modificado nada.');
    expect(await tableSnapshot(test.url)).toEqual(before);
  });

  it('escribiendo el INSTANCE_ID correcto restaura', async () => {
    await rename();
    const io = testIO(cliEnv(test.url, dir.path), { interactive: true, answers: ['test-01'] });
    expect(await main([backup.file], io)).toBe(0);
    expect(io.stdout).toContain(`Restaurada: ${backup.file}`);
    expect(io.stdout.join('\n')).toContain(
      'se borrará 1 conversación que ya supera los 30 días sin mensajes',
    );
    const [row] = await test.db.select({ name: business.name }).from(business);
    expect(row?.name).not.toBe('Cambiado');
    expect(io.all()).not.toContain(TEST_KEY);
  });

  it('stdin no interactivo sin --yes → código 2', async () => {
    const io = testIO(cliEnv(test.url, dir.path));
    expect(await main([backup.file], io)).toBe(2);
  });

  it('--yes --json imprime el informe', async () => {
    const io = testIO(cliEnv(test.url, dir.path));
    expect(await main([backup.file, '--yes', '--json'], io)).toBe(0);
    const report = JSON.parse(io.stdout[0] ?? '{}') as Record<string, unknown>;
    expect(report).toMatchObject({
      ok: true,
      file: backup.file,
      sourceInstance: 'test-01',
      schema: '0007_chat_design',
      pendingMigrations: [],
    });
  });

  it('--from-instance se pasa a la restauración', async () => {
    const without = testIO(cliEnv(test.url, dir.path));
    expect(await main([foreign.file, '--yes'], without)).toBe(1);
    expect(without.stderr[0]).toBe(
      'La copia es de la instancia «otra-02». Para restaurarla aquí, repite con --from-instance otra-02.',
    );
    const withFlag = testIO(cliEnv(test.url, dir.path));
    expect(await main([foreign.file, '--from-instance', 'otra-02', '--yes'], withFlag)).toBe(0);
  });

  it('mensaje de clave distinta', async () => {
    const io = testIO(cliEnv(test.url, dir.path, { BACKUP_KEY: TEST_KEY_2 }));
    expect(await main([backup.file, '--yes'], io)).toBe(1);
    expect(io.stderr[0]).toMatch(
      /^La copia se hizo con otra clave \(id [0-9a-f]{16}\)\. Añade la clave anterior en BACKUP_KEYS_PREVIOUS\.$/,
    );
    expect(io.all()).not.toContain(TEST_KEY);
    expect(io.all()).not.toContain(TEST_KEY_2);
  });

  it('fichero inexistente o argumentos no válidos → código 2', async () => {
    expect(await main(['no-existe.cbak', '--yes'], testIO(cliEnv(test.url, dir.path)))).toBe(2);
    expect(await main([], testIO(cliEnv(test.url, dir.path)))).toBe(2);
    expect(await main([backup.file, '--from-instance'], testIO(cliEnv(test.url, dir.path)))).toBe(
      2,
    );
  });
});
