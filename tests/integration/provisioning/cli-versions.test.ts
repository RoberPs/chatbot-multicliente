/**
 * `pnpm instance:versions` contra servidores Fastify reales en puertos locales (009,
 * contracts/instance-versions-command.md): cada fila del contrato, `--only`, `--json`, códigos de
 * salida, `--annotate` (con y sin confirmación, sin pisar cambios), SC-002 y ausencia de secretos.
 */
import { randomBytes } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import { readFile, stat } from 'node:fs/promises';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { healthRoutes } from '../../../src/channels/health/routes.js';
import { main } from '../../../src/cli/instance.js';
import type { HealthReport } from '../../../src/health/report.js';
import type { EnvMap } from '../../../src/provisioning/env-file.js';
import {
  createInventory,
  serializeInventory,
  type Instance,
  type Inventory,
} from '../../../src/provisioning/inventory.js';
import {
  collectSecrets,
  containsAny,
  instanceFromEnv,
  instanceIO,
  OTHER_INVENTORY_KEY_HEX,
  productionEnv,
  TEST_INVENTORY_KEY,
  TEST_INVENTORY_KEY_HEX,
  testDeps,
  TODAY,
  workspace,
  type Workspace,
} from '../../helpers/provisioning.js';

const EXPECTED = { index: 5, tag: '0005_config_transfer' };
const secret = () => randomBytes(32).toString('hex');

const servers: Array<FastifyInstance | Server> = [];
const sockets: Socket[] = [];
afterAll(async () => {
  for (const s of sockets) s.destroy();
  for (const s of servers) {
    if ('inject' in s) await s.close();
    else s.close();
  }
});

async function listen(app: FastifyInstance): Promise<string> {
  await app.listen({ port: 0, host: '127.0.0.1' });
  servers.push(app);
  const address = app.server.address() as { port: number };
  return `http://127.0.0.1:${String(address.port)}`;
}

/** Instancia que sirve el contrato de `/health` con un informe fijo. */
async function healthServer(options: {
  instanceId: string;
  secret: string | undefined;
  coreVersion?: string;
  onRequest?: () => Promise<void>;
  /** Estado del tope de gasto del informe (010). */
  spendCap?: HealthReport['spendCap'];
}): Promise<string> {
  const app = Fastify();
  const report: HealthReport = {
    status: 'ok',
    coreVersion: options.coreVersion ?? '1.4.0',
    schema: { applied: EXPECTED, expected: EXPECTED },
    spendCap: options.spendCap ?? null,
  };
  if (options.onRequest) app.addHook('onRequest', options.onRequest);
  await app.register(healthRoutes, {
    report: () => Promise.resolve(report),
    secret: options.secret,
    instanceId: options.instanceId,
  });
  return listen(app);
}

/** Puerto cerrado: conexión rechazada. */
async function closedUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((r) => {
    server.close(() => {
      r();
    });
  });
  return `http://127.0.0.1:${String(port)}`;
}

/** Acepta la conexión y no contesta nunca. */
async function blackHoleUrl(): Promise<string> {
  const server = createServer((socket) => sockets.push(socket));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${String((server.address() as { port: number }).port)}`;
}

interface Fleet {
  ws: Workspace;
  envs: Record<string, EnvMap>;
  inventory: Inventory;
}

async function fleet(
  members: Array<{
    id: string;
    url: string | null;
    image?: string | null;
    secret?: string | null;
    status?: Instance['status'];
  }>,
): Promise<Fleet> {
  const ws = await workspace();
  const inventory = createInventory(TEST_INVENTORY_KEY, TODAY);
  const envs: Record<string, EnvMap> = {};
  for (const m of members) {
    const env = productionEnv(m.id);
    if (m.secret === null) delete env.HEALTH_SECRET;
    else if (m.secret !== undefined) env.HEALTH_SECRET = m.secret;
    envs[m.id] = env;
    await ws.writeEnv(`${m.id}.env`, env);
    inventory.instances.push({
      ...instanceFromEnv(env, { status: m.status ?? 'active', client: `Cliente ${m.id}` }),
      publicUrl: m.url,
      imageVersion: m.image === undefined ? '1.4.0' : m.image,
    });
  }
  await ws.writeInventory(inventory);
  return { ws, envs, inventory };
}

async function versions(
  f: Fleet,
  args: string[],
  options: { tty?: boolean; answers?: string[]; key?: string } = {},
) {
  const io = instanceIO(
    { INSTANCE_INVENTORY_KEY: options.key ?? TEST_INVENTORY_KEY_HEX },
    { tty: options.tty, answers: options.answers },
  );
  const code = await main(['versions', '--inventory', f.ws.inventoryPath, ...args], io, testDeps());
  return { code, io, out: io.stdout.join('\n'), err: io.stderr.join('\n') };
}

const allSecrets = (f: Fleet) => Object.values(f.envs).flatMap(collectSecrets);

const rowOf = (out: string, id: string) =>
  out.split('\n').find((l) => l.startsWith(`${id} `)) ?? '';

let opened: Workspace[] = [];
beforeEach(() => {
  opened = [];
});
afterEach(async () => {
  for (const ws of opened) await ws.remove();
});

describe('instance:versions', () => {
  it('cada fila del contrato en una sola ejecución; la caída no impide ver las demás', async () => {
    const s = {
      a: secret(),
      b: secret(),
      d: secret(),
      g: secret(),
      h: secret(),
      i: secret(),
    };
    // Servidor de destino de la redirección: registra si le llega la credencial.
    let redirectedAuth: string | undefined = 'sin petición';
    const target = Fastify();
    target.get('/health', async (request) => {
      redirectedAuth = request.headers.authorization;
      return { status: 'ok' };
    });
    const targetUrl = await listen(target);
    const redirect = Fastify();
    redirect.get('/health', async (_request, reply) => reply.redirect(`${targetUrl}/health`, 302));

    const noHealth = Fastify();
    const f = await fleet([
      {
        id: 'demo-a',
        // 010: el tope alcanzado se ve en la columna Tope y no cambia el resultado de la fila.
        url: await healthServer({ instanceId: 'demo-a', secret: s.a, spendCap: 'reached' }),
        secret: s.a,
      },
      {
        id: 'demo-b',
        url: await healthServer({ instanceId: 'demo-b', secret: s.b, coreVersion: '1.3.0' }),
        secret: s.b,
      },
      { id: 'demo-c', url: await closedUrl() },
      // URL cruzada: responde una instancia que acepta el secreto pero es otra.
      { id: 'demo-d', url: await healthServer({ instanceId: 'demo-a', secret: s.d }), secret: s.d },
      { id: 'demo-e', url: await listen(noHealth) },
      {
        id: 'demo-f',
        url: await healthServer({ instanceId: 'demo-f', secret: secret() }),
        secret: null,
      },
      {
        id: 'demo-g',
        url: await healthServer({ instanceId: 'demo-g', secret: secret() }),
        secret: s.g,
      },
      {
        id: 'demo-h',
        url: await healthServer({ instanceId: 'demo-h', secret: undefined }),
        secret: s.h,
      },
      { id: 'demo-i', url: await listen(redirect), secret: s.i },
      { id: 'demo-r', url: await closedUrl(), status: 'retired' },
      { id: 'demo-s', url: null },
    ]);
    opened.push(f.ws);
    const before = await f.ws.inventoryText();
    const mtime = (await stat(f.ws.inventoryPath)).mtimeMs;

    const { code, out, io } = await versions(f, ['--allow-insecure']);
    expect(code).toBe(1);
    expect(rowOf(out, 'demo-a')).toMatch(
      /Correcto\s+1\.4\.0\s+0005_config_transfer\s+1\.4\.0\s+sí\s+alcanzado$/,
    );
    expect(rowOf(out, 'demo-b')).toMatch(/Correcto\s+1\.3\.0\s+.*NO\s+—$/);
    expect(rowOf(out, 'demo-c')).toMatch(/No responde\s+—\s+—/);
    expect(rowOf(out, 'demo-d')).toMatch(/Identidad distinta\s+—\s+—/);
    expect(rowOf(out, 'demo-d')).not.toContain('demo-a');
    expect(rowOf(out, 'demo-e')).toContain('Sin información de versión');
    expect(rowOf(out, 'demo-f')).toContain('Solo estado');
    expect(rowOf(out, 'demo-g')).toContain('Secreto rechazado');
    expect(rowOf(out, 'demo-h')).toContain('Secreto rechazado');
    expect(rowOf(out, 'demo-i')).toContain('Respuesta no válida');
    expect(redirectedAuth).toBe('sin petición');
    expect(rowOf(out, 'demo-s')).toContain('No consultada (sin URL)');
    expect(out).not.toContain('demo-r ');
    expect(out).toContain('9 de 10 instancias requieren revisión.');
    expect(containsAny(io.all(), allSecrets(f))).toBe(false);

    // Sin --annotate el inventario no cambia (contenido y fecha).
    expect(await f.ws.inventoryText()).toBe(before);
    expect((await stat(f.ws.inventoryPath)).mtimeMs).toBe(mtime);
  });

  it('http sin --allow-insecure → No consultada (no https)', async () => {
    const s = secret();
    const f = await fleet([
      { id: 'demo-a', url: await healthServer({ instanceId: 'demo-a', secret: s }), secret: s },
    ]);
    opened.push(f.ws);
    const { code, out } = await versions(f, []);
    expect(code).toBe(1);
    expect(rowOf(out, 'demo-a')).toContain('No consultada (no https)');
  });

  it('--only, --json y código 0 si todo es correcto y coincide', async () => {
    const s = secret();
    const f = await fleet([
      { id: 'demo-a', url: await healthServer({ instanceId: 'demo-a', secret: s }), secret: s },
      { id: 'demo-c', url: await closedUrl() },
    ]);
    opened.push(f.ws);
    const only = await versions(f, ['--allow-insecure', '--only', 'demo-a']);
    expect(only.code).toBe(0);
    expect(only.out).not.toContain('demo-c');

    const json = await versions(f, ['--allow-insecure', '--json']);
    expect(json.code).toBe(1);
    const parsed = JSON.parse(json.out) as {
      ok: boolean;
      checkedAt: string;
      instances: Array<{ id: string; result: string; review: boolean }>;
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.instances.map((i) => [i.id, i.result])).toEqual([
      ['demo-a', 'ok'],
      ['demo-c', 'unreachable'],
    ]);
    expect(Number.isNaN(Date.parse(parsed.checkedAt))).toBe(false);
  });

  it('código 2: clave incorrecta, argumentos o id desconocido en --only', async () => {
    const f = await fleet([{ id: 'demo-a', url: null }]);
    opened.push(f.ws);
    expect((await versions(f, [], { key: OTHER_INVENTORY_KEY_HEX })).code).toBe(2);
    expect((await versions(f, ['--timeout', '0'])).code).toBe(2);
    expect((await versions(f, ['--timeout', '31'])).code).toBe(2);
    expect((await versions(f, ['--desconocida'])).code).toBe(2);
    expect((await versions(f, ['--only', 'no-existe'])).code).toBe(2);
  });

  it('sin instancias activas → mensaje y código 0', async () => {
    const f = await fleet([{ id: 'demo-r', url: null, status: 'retired' }]);
    opened.push(f.ws);
    const { code, out } = await versions(f, []);
    expect(code).toBe(0);
    expect(out).toContain('No hay instancias activas en el inventario.');
  });
});

describe('instance:versions --annotate', () => {
  async function annotatedFleet(onRequest?: () => Promise<void>) {
    const a = secret();
    const b = secret();
    const f = await fleet([
      {
        id: 'demo-a',
        url: await healthServer({ instanceId: 'demo-a', secret: a, coreVersion: '1.5.0' }),
        secret: a,
        image: 'chatbot:1.4.0',
      },
      {
        id: 'demo-b',
        url: await healthServer({
          instanceId: 'demo-b',
          secret: b,
          coreVersion: '1.5.0',
          ...(onRequest ? { onRequest } : {}),
        }),
        secret: b,
        image: null,
      },
      { id: 'demo-c', url: await closedUrl(), image: '1.4.0' },
    ]);
    opened.push(f.ws);
    return f;
  }

  it('--annotate --yes escribe imageVersion solo en las filas ok', async () => {
    const f = await annotatedFleet();
    const { code, out } = await versions(f, ['--allow-insecure', '--annotate', '--yes']);
    expect(code).toBe(1);
    expect(out).toContain('demo-a: chatbot:1.4.0 → 1.5.0');
    expect(out).toContain('demo-b: sin anotar → 1.5.0');
    const inventory = await f.ws.readInventory();
    const image = (id: string) => inventory.instances.find((i) => i.id === id)?.imageVersion;
    expect(image('demo-a')).toBe('1.5.0');
    expect(image('demo-b')).toBe('1.5.0');
    expect(image('demo-c')).toBe('1.4.0');
    // Solo cambia imageVersion.
    const before = f.inventory.instances.find((i) => i.id === 'demo-a');
    expect(inventory.instances.find((i) => i.id === 'demo-a')).toEqual({
      ...before,
      imageVersion: '1.5.0',
    });

    const again = await versions(f, ['--allow-insecure', '--only', 'demo-a,demo-b']);
    expect(again.code).toBe(0);
  });

  it('pregunta en la terminal y no escribe si no se confirma', async () => {
    const f = await annotatedFleet();
    const before = await f.ws.inventoryText();
    const { io } = await versions(f, ['--allow-insecure', '--annotate'], {
      tty: true,
      answers: ['n'],
    });
    expect(io.questions.some((q) => q.includes('¿Anotar estas versiones? (s/N)'))).toBe(true);
    expect(await f.ws.inventoryText()).toBe(before);

    await versions(f, ['--allow-insecure', '--annotate'], { tty: true, answers: ['s'] });
    expect(
      (await f.ws.readInventory()).instances.find((i) => i.id === 'demo-a')?.imageVersion,
    ).toBe('1.5.0');
  });

  it('sin terminal y sin --yes → código 2 sin escribir', async () => {
    const f = await annotatedFleet();
    const before = await f.ws.inventoryText();
    const { code } = await versions(f, ['--allow-insecure', '--annotate']);
    expect(code).toBe(2);
    expect(await f.ws.inventoryText()).toBe(before);
  });

  it('una anotación que cambió entre la consulta y la escritura no se pisa', async () => {
    let path = '';
    const f = await annotatedFleet(async () => {
      // Otro operador anota demo-b mientras se consulta.
      const inventory = JSON.parse(await readFile(path, 'utf8')) as Inventory;
      const b = inventory.instances.find((i) => i.id === 'demo-b');
      if (b) b.imageVersion = '1.4.9';
      const { writeFile } = await import('node:fs/promises');
      await writeFile(path, serializeInventory(inventory));
    });
    path = f.ws.inventoryPath;
    const { out } = await versions(f, ['--allow-insecure', '--annotate', '--yes']);
    expect(out).toMatch(/demo-b.*no se ha anotado/i);
    const inventory = await f.ws.readInventory();
    expect(inventory.instances.find((i) => i.id === 'demo-b')?.imageVersion).toBe('1.4.9');
    expect(inventory.instances.find((i) => i.id === 'demo-a')?.imageVersion).toBe('1.5.0');
  });
});

describe('SC-002', () => {
  it('10 instancias con 3 que no contestan terminan en menos de 60 s', async () => {
    const members = [];
    for (let i = 0; i < 7; i++) {
      const s = secret();
      const id = `demo-${String(i).padStart(2, '0')}`;
      members.push({ id, url: await healthServer({ instanceId: id, secret: s }), secret: s });
    }
    for (let i = 7; i < 10; i++) {
      members.push({ id: `demo-${String(i).padStart(2, '0')}`, url: await blackHoleUrl() });
    }
    const f = await fleet(members);
    opened.push(f.ws);
    const started = Date.now();
    const { code, out } = await versions(f, ['--allow-insecure']);
    expect(Date.now() - started).toBeLessThan(60_000);
    expect(code).toBe(1);
    expect(out.match(/No responde/g)?.length).toBe(3);
    expect(out.match(/Correcto/g)?.length).toBe(7);
  }, 70_000);
});
