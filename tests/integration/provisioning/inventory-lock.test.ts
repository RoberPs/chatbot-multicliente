import { readdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createInventory,
  inventorySchema,
  withInventoryLock,
  writeInventory,
  type Inventory,
} from '../../../src/provisioning/inventory.js';
import { ProvisioningError } from '../../../src/provisioning/messages.js';
import {
  instanceFromEnv,
  productionEnv,
  TEST_INVENTORY_KEY,
  TODAY,
  workspace,
  type Workspace,
} from '../../helpers/provisioning.js';

let ws: Workspace;
beforeEach(async () => {
  ws = await workspace();
  await ws.writeInventory(createInventory(TEST_INVENTORY_KEY, TODAY));
});
afterEach(async () => {
  await ws.remove();
});

async function addInstance(id: string, holdMs: number, waitMs: number): Promise<void> {
  await withInventoryLock(
    ws.inventoryPath,
    async (read) => {
      if (read.kind !== 'ok') throw new Error('sin inventario');
      await new Promise((r) => setTimeout(r, holdMs));
      const next: Inventory = {
        ...read.inventory,
        instances: [...read.inventory.instances, instanceFromEnv(productionEnv(id))],
      };
      await writeInventory(ws.inventoryPath, next);
    },
    { waitMs, retryMs: 10 },
  );
}

const codeOf = async (promise: Promise<unknown>): Promise<string | null> => {
  try {
    await promise;
    return null;
  } catch (error) {
    return error instanceof ProvisioningError ? error.code : 'otro';
  }
};

describe('bloqueo y escritura atómica del inventario (research R6)', () => {
  it('dos escrituras a la vez: la segunda espera y las dos terminan; el JSON queda completo', async () => {
    await Promise.all([addInstance('demo-01', 150, 5000), addInstance('demo-02', 0, 5000)]);
    const inventory = inventorySchema.parse(JSON.parse(await ws.inventoryText()));
    expect(inventory.instances.map((i) => i.id).sort()).toEqual(['demo-01', 'demo-02']);
    expect(
      (await readdir(ws.dir)).filter((n) => n.includes('.tmp-') || n.endsWith('.lock')),
    ).toEqual([]);
  });

  it('si el bloqueo no se libera a tiempo → inventory_busy; el inventario sigue válido', async () => {
    const slow = addInstance('demo-01', 400, 5000);
    await new Promise((r) => setTimeout(r, 50));
    expect(await codeOf(addInstance('demo-02', 0, 100))).toBe('inventory_busy');
    await slow;
    const inventory = inventorySchema.parse(JSON.parse(await ws.inventoryText()));
    expect(inventory.instances.map((i) => i.id)).toEqual(['demo-01']);
  });

  it('un bloqueo de más de 10 min se señala como huérfano y no se borra', async () => {
    const lock = `${ws.inventoryPath}.lock`;
    await writeFile(lock, '{"pid":1}');
    const old = new Date(Date.now() - 11 * 60 * 1000);
    await utimes(lock, old, old);
    let error: unknown;
    try {
      await addInstance('demo-01', 0, 50);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ProvisioningError);
    expect((error as ProvisioningError).code).toBe('inventory_busy');
    expect((error as ProvisioningError).ctx.orphan).toBe(true);
    expect((await stat(lock)).isFile()).toBe(true);
  });

  it('un inventario corrupto no se sobrescribe y el error es inventory_unreadable', async () => {
    await writeFile(ws.inventoryPath, '{ "format": "chatbot-inventory", roto');
    const before = await readFile(ws.inventoryPath);
    expect(await codeOf(addInstance('demo-01', 0, 1000))).toBe('inventory_unreadable');
    expect((await readFile(ws.inventoryPath)).equals(before)).toBe(true);
    expect((await readdir(ws.dir)).some((n) => n.endsWith('.lock'))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')(
    'en POSIX el inventario queda con modo 0600',
    async () => {
      await addInstance('demo-01', 0, 1000);
      expect((await stat(ws.inventoryPath)).mode & 0o777).toBe(0o600);
    },
  );
});
