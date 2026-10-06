/**
 * Los registros de las copias no llevan datos personales (SC-004, FR-024,
 * contracts/backup-log.md): ni nombres, teléfonos, emails o textos de la fixture, ni la clave, ni
 * la ruta completa del directorio, ni mensajes de PostgreSQL.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyRetention } from '../../../src/backup/retention.js';
import { createBackupScheduler } from '../../../src/backup/scheduler.js';
import { createBackup, restoreBackup, verifyBackup } from '../../../src/backup/service.js';
import { runMigrations } from '../../../src/db/migrate.js';
import {
  captureLogger,
  createDatabaseMigratedUpTo,
  seedInstance,
  seedSchema0003,
  tempBackupDir,
  testBackupConfig,
  testClock,
  TEST_KEY,
  type ScratchDatabase,
  type SeededInstance,
  type TempDir,
} from '../../helpers/backup.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';

let test: TestDatabase;
let old: ScratchDatabase;
let dir: TempDir;
let seeded: SeededInstance;

beforeAll(async () => {
  test = await createTestDatabase();
  seeded = await seedInstance(test.db);
  old = await createDatabaseMigratedUpTo(3);
  await seedSchema0003(old.url);
  dir = await tempBackupDir();
});
afterAll(async () => {
  await test.close();
  await old.close();
  await dir.remove();
});

/** Emails y teléfonos que aparecen en la fixture (contacto, canales de derivación). */
function fixtureContacts(): string[] {
  const text = JSON.stringify(seeded.fixture);
  const emails = text.match(/[\w.+-]+@[\w-]+\.[\w.]+/g) ?? [];
  const phones = text.match(/\+\d[\d ]{7,}/g) ?? [];
  return [...emails, ...phones.map((p) => p.trim())];
}

describe('registros de las copias sin datos personales', () => {
  it('copia, restauración, rechazos, comprobación, retención, diaria fallida y arranque bloqueado', async () => {
    const logger = captureLogger();
    const config = testBackupConfig({ dir: dir.path });

    const backup = await createBackup({ databaseUrl: test.url, config, reason: 'manual', logger });
    await restoreBackup({
      databaseUrl: test.url,
      file: join(dir.path, backup.file),
      config,
      logger,
    });

    const bytes = await readFile(join(dir.path, backup.file));
    const at = Math.floor(bytes.length / 2);
    bytes[at] = (bytes[at] ?? 0) ^ 0x01;
    await writeFile(join(dir.path, 'danada.cbak'), bytes);
    await restoreBackup({
      databaseUrl: test.url,
      file: join(dir.path, 'danada.cbak'),
      config,
      logger,
    }).catch(() => undefined);
    // Un fallo de PostgreSQL durante la carga: su mensaje no se registra.
    await restoreBackup({
      databaseUrl: test.url,
      file: join(dir.path, backup.file),
      config,
      logger,
      internal: {
        afterTable: async (loaded, _t, client) => {
          if (loaded === 3) await client.query(`select 1/0 as "${seeded.businessName}"`);
        },
      },
    }).catch(() => undefined);

    await verifyBackup({ file: join(dir.path, backup.file), config, logger });
    await applyRetention({ config, logger });

    const failing = () =>
      new Transform({
        transform(_c, _e, callback) {
          callback(Object.assign(new Error(`sin espacio en ${dir.path}`), { code: 'ENOSPC' }));
        },
      });
    await createBackupScheduler({
      databaseUrl: test.url,
      db: test.db,
      config,
      clock: testClock('2026-09-29T08:00:00Z'),
      logger,
      internal: { throughput: failing },
    }).tick();

    await runMigrations(old.url, { timezone: 'Europe/Madrid', currency: 'EUR' }, { logger }).catch(
      () => undefined,
    );

    const events = new Set(logger.lines.map((l) => l.obj.event));
    for (const name of [
      'backup_created',
      'restore_completed',
      'restore_rejected',
      'verify_completed',
      'backup_retention_applied',
      'backup_failed',
      'migration_blocked',
    ]) {
      expect(events).toContain(name);
    }

    const text = logger.text();
    const forbidden = [
      seeded.businessName,
      ...seeded.phones,
      ...seeded.texts,
      ...fixtureContacts(),
      TEST_KEY,
      dir.path,
      dir.path.replaceAll('\\', '\\\\'),
      'division by zero',
      'sin espacio',
    ];
    for (const value of forbidden) {
      expect(text, `el registro contiene «${value}»`).not.toContain(value);
    }
  });
});
