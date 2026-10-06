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
  expectNoUrlParts,
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
      `-- DATABASE_URL (con la contraseña) escrita en ${envPath}; no se muestra aquí.`,
    );
    const written = (await readEnv()).DATABASE_URL ?? '';
    expect(databaseIdentity(written)).toMatchObject({ host: 'db.interna', port: 5433 });
    expect(out.includes(new URL(written).password)).toBe(false);
    expect((await instance())?.database).toMatchObject({ host: 'db.interna', port: 5433 });

    // Encontrado al recorrer el quickstart (T053): la salida entera es un script SQL válido,
    // así que se puede pasar tal cual a psql.
    const lines = out.split('\n').filter((l) => l.trim() !== '');
    expect(lines.every((l) => l.startsWith('--') || l.endsWith(';'))).toBe(true);
    const admin = new pg.Client({ connectionString: adminUrl() });
    await admin.connect();
    try {
      // Una a una, como psql (CREATE DATABASE no admite transacción).
      for (const statement of lines.filter((l) => !l.startsWith('--')))
        await admin.query(statement);
    } finally {
      await admin.end();
    }
    const direct = new URL(written);
    const server = new URL(adminUrl());
    direct.hostname = server.hostname;
    direct.port = server.port;
    // 013: con --host remoto lleva verify-full; el servidor de pruebas no tiene TLS.
    expect(direct.searchParams.get('sslmode')).toBe('verify-full');
    direct.searchParams.delete('sslmode');
    expect(await canConnect(direct.toString())).toBe(true);
  });
});

describe('pnpm instance:db con TLS verificado (013, FR-007)', () => {
  const remoteAdmin = 'postgres://admin:clave-admin-remota@10.0.0.5:5432/postgres';
  const ADMIN_TLS_TEXT = [
    'INSTANCE_DB_ADMIN_URL apunta a un servidor remoto sin TLS verificado: por esa conexión viaja la credencial de administración.',
    '→ Añade sslmode=verify-full (y sslrootcert=<ruta> si la autoridad no es pública), o usa --print-sql --host <servidor> --port <puerto> y aplica el SQL tú mismo.',
  ].join('\n');

  async function expectRefused(io: ReturnType<typeof instanceIO>, url: string): Promise<void> {
    const envBefore = await readFile(envPath);
    const invBefore = await ws.inventoryText();
    let connected = false;
    let inventoryOpened = false;
    const deps = testDeps({
      connectPg: () => {
        connected = true;
        return Promise.reject(new Error('no debe conectarse'));
      },
      writeInventory: () => {
        inventoryOpened = true;
        return Promise.resolve();
      },
    });
    const started = Date.now();
    expect(await main(['db', id], io, deps)).toBe(1);
    // Vuelve al instante: no intenta conectar con 10.0.0.5.
    expect(Date.now() - started).toBeLessThan(2000);
    expect(connected).toBe(false);
    expect(inventoryOpened).toBe(false);
    expect(io.stderr.join('\n')).toBe(ADMIN_TLS_TEXT);
    expect((await readFile(envPath)).equals(envBefore)).toBe(true);
    expect(await ws.inventoryText()).toBe(invBefore);
    // Ni siquiera el bloqueo del inventario.
    expect(await ws.otherFilesText()).toBe(invBefore);
    expectNoUrlParts(io.all(), url);
  }

  it.each([
    ['sin sslmode', remoteAdmin],
    ['con sslmode=require', `${remoteAdmin}?sslmode=require`],
  ])('URL de administración remota %s → admin_url_tls_required sin conectar', async (_n, url) => {
    await expectRefused(instanceIO(env({ INSTANCE_DB_ADMIN_URL: url })), url);
  });

  it('igual con una instancia de pruebas', async () => {
    const inv = await ws.readInventory();
    const inst = inv.instances.find((i) => i.id === id);
    if (inst) inst.status = 'testing';
    await ws.writeInventory(inv);
    await expectRefused(instanceIO(env({ INSTANCE_DB_ADMIN_URL: remoteAdmin })), remoteAdmin);
  });

  it('igual con la URL pedida sin eco en la terminal', async () => {
    const io = instanceIO(env({ INSTANCE_DB_ADMIN_URL: undefined }), {
      tty: true,
      hidden: [remoteAdmin],
    });
    await expectRefused(io, remoteAdmin);
  });

  it('--print-sql --host remoto --sslrootcert: DATABASE_URL con verify-full y sslrootcert, sin mostrar la ruta', async () => {
    const io = instanceIO(env({ INSTANCE_DB_ADMIN_URL: undefined }));
    const failing = () => Promise.reject(new Error('no debe conectarse'));
    expect(
      await main(
        [
          'db',
          id,
          '--print-sql',
          '--host',
          'db.interna',
          '--port',
          '5432',
          '--sslrootcert',
          '/etc/chatbot/db-ca.crt',
        ],
        io,
        testDeps({ connectPg: failing }),
      ),
    ).toBe(0);
    expect(io.stdout.join('\n')).toContain('CREATE ROLE "chatbot_');
    const written = new URL((await readEnv()).DATABASE_URL ?? '');
    expect(written.searchParams.get('sslmode')).toBe('verify-full');
    expect(written.searchParams.get('sslrootcert')).toBe('/etc/chatbot/db-ca.crt');
    expect(io.all()).not.toContain('/etc/chatbot/db-ca.crt');
    expect(io.all()).not.toContain('db-ca.crt');
  });

  it('una URL de administración local sin TLS sigue funcionando como hoy', async () => {
    const io = instanceIO(env());
    expect(new URL(adminUrl()).searchParams.get('sslmode')).toBeNull();
    expect(await main(['db', id], io, testDeps())).toBe(0);
    expect(await canConnect((await readEnv()).DATABASE_URL ?? '')).toBe(true);
  });
});

describe('pnpm instance:db con una IP y verify-full (aclaración posterior)', () => {
  it('se niega con admin_url_ip_host sin conectar ni abrir el inventario', async () => {
    const url = 'postgres://admin:clave-admin-remota@10.0.0.5:5432/postgres?sslmode=verify-full';
    const invBefore = await ws.inventoryText();
    let connected = false;
    const io = instanceIO(env({ INSTANCE_DB_ADMIN_URL: url }));
    const deps = testDeps({
      connectPg: () => {
        connected = true;
        return Promise.reject(new Error('no debe conectarse'));
      },
    });
    expect(await main(['db', id], io, deps)).toBe(1);
    expect(connected).toBe(false);
    expect(io.stderr.join('\n')).toBe(
      [
        'INSTANCE_DB_ADMIN_URL apunta a una IP: con una IP no se comprueba que el certificado sea de ese servidor, y por esa conexión viaja la credencial de administración.',
        '→ Usa el nombre del servidor que figura en su certificado, o usa --print-sql --host <servidor> --port <puerto> y aplica el SQL tú mismo.',
      ].join('\n'),
    );
    expect(await ws.inventoryText()).toBe(invBefore);
    expectNoUrlParts(io.all(), url);
  });
});
