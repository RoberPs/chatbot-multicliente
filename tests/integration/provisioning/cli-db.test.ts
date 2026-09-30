import { randomBytes } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, inject, it } from 'vitest';
import { main } from '../../../src/cli/instance.js';
import { parseEnvText } from '../../../src/provisioning/env-file.js';
import { databaseIdentity } from '../../../src/provisioning/fingerprint.js';
import { withInventoryLock, type Inventory } from '../../../src/provisioning/inventory.js';
import { ProvisioningError } from '../../../src/provisioning/messages.js';
import {
  containsAny,
  envText,
  instanceFromEnv,
  instanceIO,
  productionEnv,
  sampleInventory,
  TEST_INVENTORY_KEY_HEX,
  testDeps,
  workspace,
  type Workspace,
} from '../../helpers/provisioning.js';

let ws: Workspace;
let id: string;
let envPath: string;

/** Instancia "en alta" con su entorno en la ruta por defecto y DATABASE_URL vacía. */
beforeEach(async () => {
  ws = await workspace();
  id = `c-${randomBytes(4).toString('hex')}`;
  const env = productionEnv(id, { DATABASE_URL: '' });
  const sample = sampleInventory(2);
  sample.inventory.instances.push({ ...instanceFromEnv(env), status: 'provisioning' });
  await ws.writeInventory(sample.inventory);
  envPath = join(ws.envsDir, `${id}.env`);
  await writeFile(
    envPath,
    envText(env).replace(
      'DATABASE_URL=\n',
      `# PENDIENTE: se escribe con pnpm instance:db ${id}\nDATABASE_URL=\n`,
    ),
    { mode: 0o600 },
  );
});
afterEach(async () => {
  await ws.remove();
});

const adminUrl = () => inject('pgAdminUrl');
const env = (extra: Record<string, string | undefined> = {}) => ({
  INSTANCE_INVENTORY: ws.inventoryPath,
  INSTANCE_INVENTORY_KEY: TEST_INVENTORY_KEY_HEX,
  INSTANCE_DB_ADMIN_URL: adminUrl(),
  ...extra,
});
const adminPassword = () => decodeURIComponent(new URL(adminUrl()).password);

async function canConnect(url: string): Promise<boolean> {
  const client = new pg.Client({ connectionString: url });
  client.on('error', () => undefined);
  try {
    await client.connect();
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

const readEnv = async () => parseEnvText(await readFile(envPath, 'utf8'));
const instance = async () => (await ws.readInventory()).instances.find((i) => i.id === id);

describe('pnpm instance:db (US3)', () => {
  it('crea la BD, escribe DATABASE_URL y guarda la identidad sin contraseña', async () => {
    const io = instanceIO(env());
    expect(await main(['db', id], io, testDeps())).toBe(0);
    const names = `chatbot_${id.replaceAll('-', '_')}`;
    const out = io.stdout.join('\n');
    expect(out).toMatch(/^Base de datos creada en [^\s:]+:\d+$/m);
    expect(out).toContain(`  base de datos  ${names} (vacía; solo su usuario puede conectarse)`);
    expect(out).toContain(`DATABASE_URL escrita en ${envPath}. Inventario actualizado.`);
    expect(out).toContain('Las credenciales de administración no se han guardado.');

    const written = await readEnv();
    expect(await canConnect(written.DATABASE_URL ?? '')).toBe(true);
    expect(await readFile(envPath, 'utf8')).not.toContain(
      '# PENDIENTE: se escribe con pnpm instance:db',
    );
    if (process.platform !== 'win32') expect((await stat(envPath)).mode & 0o777).toBe(0o600);

    const registered = await instance();
    expect(registered?.database).toEqual(databaseIdentity(written.DATABASE_URL));
    expect(registered?.fingerprints.map((f) => f.variable)).toEqual(
      expect.arrayContaining(['DATABASE', 'DATABASE_USER', 'DATABASE_PASSWORD']),
    );

    const password = new URL(written.DATABASE_URL ?? '').password;
    const everything = `${io.all()}\n${await ws.otherFilesText()}`;
    expect(
      containsAny(everything, [password, adminPassword(), adminUrl(), written.DATABASE_URL ?? '']),
    ).toBe(false);
  });

  it.each([
    [
      'unknown_instance',
      () => ['db', 'no-existe', '--env', envPath],
      'No hay ninguna instancia no-existe',
    ],
    ['env_other_instance', () => ['db', 'demo-01', '--env', envPath], 'no es demo-01'],
  ])('rechazo %s sin cambiar nada', async (_code, args, text) => {
    const envBefore = await readFile(envPath);
    const invBefore = await ws.inventoryText();
    const io = instanceIO(env());
    expect(await main(args(), io, testDeps())).toBe(1);
    expect(io.stderr.join('\n')).toContain(text);
    expect((await readFile(envPath)).equals(envBefore)).toBe(true);
    expect(await ws.inventoryText()).toBe(invBefore);
  });

  it('rechazos instance_retired, database_already_registered y database_url_set', async () => {
    const mutate = async (fn: (inv: Inventory) => void) => {
      const inv = await ws.readInventory();
      fn(inv);
      await ws.writeInventory(inv);
    };
    const inst = (inv: Inventory) =>
      inv.instances.find((i) => i.id === id) as Inventory['instances'][number];

    await mutate((inv) => {
      inst(inv).status = 'retired';
      inst(inv).dates.retired = '2026-09-30';
    });
    let io = instanceIO(env());
    expect(await main(['db', id], io, testDeps())).toBe(1);
    expect(io.stderr.join('\n')).toContain('dada de baja');

    await mutate((inv) => {
      inst(inv).status = 'provisioning';
      inst(inv).dates.retired = null;
      inst(inv).database = { host: 'h', port: 5432, name: 'n', user: 'u' };
    });
    io = instanceIO(env());
    expect(await main(['db', id], io, testDeps())).toBe(1);
    expect(io.stderr.join('\n')).toContain('ya tiene base de datos');

    await mutate((inv) => {
      inst(inv).database = null;
    });
    const text = (await readFile(envPath, 'utf8')).replace(
      'DATABASE_URL=\n',
      'DATABASE_URL=postgres://ya@h/d\n',
    );
    await writeFile(envPath, text);
    io = instanceIO(env());
    expect(await main(['db', id], io, testDeps())).toBe(1);
    expect(io.stderr.join('\n')).toContain('DATABASE_URL ya tiene valor');
    expect(await readFile(envPath, 'utf8')).toBe(text);
  });

  it('sin --env y sin el fichero por defecto → 2 con env_unreadable e indicación de --env', async () => {
    const io = instanceIO(env());
    expect(await main(['db', 'demo-01'], io, testDeps())).toBe(2);
    expect(io.stderr.join('\n')).toContain('--env <fichero>');
  });

  it.each(['database', 'revoke'] as const)(
    'fallo inyectado en el paso %s → DATABASE_URL vuelve a quedar como estaba y el inventario no cambia',
    async (step) => {
      const envBefore = await readFile(envPath, 'utf8');
      const invBefore = await ws.inventoryText();
      const io = instanceIO(env());
      expect(await main(['db', id], io, testDeps({ dbFailAt: step }))).toBe(1);
      const report = io.stderr.join('\n');
      expect(report).toContain(`(paso: ${step}).`);
      expect(report).toContain(
        'DATABASE_URL ha vuelto a quedar vacía y el inventario no se ha modificado.',
      );
      if (step === 'database') {
        expect(report).toContain('Deshecho: usuario');
        expect(report).toContain('No queda nada creado en el servidor.');
      } else {
        expect(report).toContain('Quedan creados: base de datos');
        expect(report).toContain('REVOKE CONNECT, TEMPORARY ON DATABASE');
        expect(report).toContain('o para retirarlo: DROP DATABASE');
      }
      expect(await readFile(envPath, 'utf8')).toBe(envBefore);
      expect(await ws.inventoryText()).toBe(invBefore);
    },
  );

  it('fallo al escribir el inventario tras crear la BD → inventory_not_updated; sync lo completa', async () => {
    const io = instanceIO(env());
    const deps = testDeps({
      writeInventory: () => Promise.reject(new ProvisioningError('write_failed', { path: 'x' })),
    });
    expect(await main(['db', id], io, deps)).toBe(1);
    expect(io.stderr.join('\n')).toContain('pero el inventario no se ha actualizado');
    expect(io.stderr.join('\n')).toContain(`pnpm instance:sync ${id} ${envPath}`);
    expect((await readEnv()).DATABASE_URL).not.toBe('');
    expect((await instance())?.database).toBeNull();

    const sync = instanceIO(env());
    expect(await main(['sync', id, envPath], sync, testDeps())).toBe(0);
    expect((await instance())?.database).toEqual(databaseIdentity((await readEnv()).DATABASE_URL));
  });

  it('mientras dura la orden, otra escritura del inventario falla con inventory_busy', async () => {
    let busy: string | null = null;
    const connect = async (url: string) => {
      if (busy === null) {
        try {
          await withInventoryLock(ws.inventoryPath, () => Promise.resolve(), {
            waitMs: 50,
            retryMs: 10,
          });
          busy = 'no';
        } catch (error) {
          busy = error instanceof ProvisioningError ? error.code : 'otro';
        }
      }
      const { connectPg } = await import('../../../src/provisioning/database.js');
      return connectPg(url);
    };
    const io = instanceIO(env());
    expect(await main(['db', id], io, testDeps({ connectPg: connect }))).toBe(0);
    expect(busy).toBe('inventory_busy');
  });

  it('sin URL de administración: sin terminal → 2; con terminal se pide sin eco', async () => {
    const noTty = instanceIO(env({ INSTANCE_DB_ADMIN_URL: undefined }));
    expect(await main(['db', id], noTty, testDeps())).toBe(2);
    expect(noTty.stderr.join('\n')).toContain('INSTANCE_DB_ADMIN_URL');

    const tty = instanceIO(env({ INSTANCE_DB_ADMIN_URL: undefined }), {
      tty: true,
      hidden: [adminUrl()],
    });
    expect(await main(['db', id], tty, testDeps())).toBe(0);
    expect(tty.questions.some((q) => q.includes('URL de administración'))).toBe(true);
    expect(containsAny(tty.all(), [adminPassword(), adminUrl()])).toBe(false);
  });

  it('--print-sql: sin --host/--port → 2; con ellos no abre ninguna conexión', async () => {
    const io = instanceIO(env());
    expect(await main(['db', id, '--print-sql'], io, testDeps())).toBe(2);

    const failing = () => Promise.reject(new Error('no debe conectarse'));
    const sql = instanceIO(env({ INSTANCE_DB_ADMIN_URL: undefined }));
    expect(
      await main(
        ['db', id, '--print-sql', '--host', 'db.interna', '--port', '5433'],
        sql,
        testDeps({ connectPg: failing }),
      ),
    ).toBe(0);
    const out = sql.stdout.join('\n');
    expect(out).toContain('CREATE ROLE "chatbot_');
    expect(out).toContain("LOGIN PASSWORD 'SCRAM-SHA-256$4096:");
    expect(out).toContain(
      `DATABASE_URL (con la contraseña) escrita en ${envPath}; no se muestra aquí.`,
    );
    const written = (await readEnv()).DATABASE_URL ?? '';
    expect(databaseIdentity(written)).toMatchObject({ host: 'db.interna', port: 5433 });
    expect(out.includes(new URL(written).password)).toBe(false);
    expect((await instance())?.database).toMatchObject({ host: 'db.interna', port: 5433 });
  });
});
