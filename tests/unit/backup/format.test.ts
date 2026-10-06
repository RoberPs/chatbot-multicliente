import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { keyId } from '../../../src/backup/config.js';
import { RestoreFailure } from '../../../src/backup/errors.js';
import {
  authenticateHeader,
  BLOCK_SIZE,
  createBackupWriter,
  openBackup,
  readHeader,
  type HeaderInput,
} from '../../../src/backup/format.js';

const KEY = randomBytes(32);
const OTHER_KEY = randomBytes(32);
const input: HeaderInput = {
  instanceId: 'demo-01',
  schema: { index: 4, tag: '0004_handoff', hash: 'a'.repeat(64) },
  coreVersion: '0.1.0',
  createdAt: '2026-09-29T10:15:00.000Z',
  reason: 'manual',
  tables: [{ schema: 'public', name: 'business', rows: 1 }],
};

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cbak-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

let counter = 0;
async function write(plain: Buffer, key = KEY, header = input): Promise<string> {
  const path = join(dir, `f${counter++}.cbak`);
  const { stream } = createBackupWriter(header, key);
  await pipeline(Readable.from([plain]), stream, createWriteStream(path));
  return path;
}

async function read(path: string, keys: Buffer[] = [KEY]): Promise<Buffer> {
  const { stream } = await openBackup(path, keys);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function failure(promise: Promise<unknown>): Promise<RestoreFailure> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(RestoreFailure);
    return error as RestoreFailure;
  }
  throw new Error('Se esperaba un rechazo');
}

/** Posiciones de los bloques: [inicio, longitud total] de cada uno. */
async function blocks(path: string): Promise<Array<[number, number]>> {
  const bytes = await readFile(path);
  const { offset } = await readHeader(path);
  const out: Array<[number, number]> = [];
  let at = offset;
  while (at < bytes.length) {
    const total = 4 + bytes.readUInt32BE(at) + 16;
    out.push([at, total]);
    at += total;
  }
  return out;
}

describe('formato CBAK v1', () => {
  it.each([
    ['vacío', 0],
    ['menor que un bloque', 1000],
    ['exactamente 64 KiB', BLOCK_SIZE],
    ['varios bloques', BLOCK_SIZE * 3 + 17],
  ])('ida y vuelta: %s', async (_name, size) => {
    // Datos aleatorios: gzip no los reduce, así que el flujo cifrado tiene varios bloques.
    const plain = randomBytes(size);
    const path = await write(plain);
    expect((await read(path)).equals(plain)).toBe(true);
    const sizes = (await blocks(path)).map(([, total]) => total - 20);
    for (const s of sizes.slice(0, -1)) expect(s).toBe(BLOCK_SIZE);
    expect(sizes.at(-1)).toBeGreaterThanOrEqual(1);
    expect(sizes.at(-1)).toBeLessThanOrEqual(BLOCK_SIZE);
  });

  it('un gzip de exactamente 64 KiB × n termina con un bloque final completo', async () => {
    const plain = randomBytes(BLOCK_SIZE * 2);
    const path = await write(plain);
    expect((await read(path)).equals(plain)).toBe(true);
  });

  it('la cabecera se lee sin clave y lleva sal y keyId', async () => {
    const path = await write(Buffer.from('hola'));
    const { header } = await readHeader(path);
    expect(header).toMatchObject({ format: 'cbak', formatVersion: 1, ...input });
    expect(header.keyId).toBe(keyId(KEY));
    expect(Buffer.from(header.salt, 'base64')).toHaveLength(16);
  });

  it('el fichero no contiene en claro el volcado', async () => {
    const secret = 'Teléfono del cliente +34600111222 y su mensaje privado';
    const plain = Buffer.from(`${secret}\n`.repeat(50));
    const path = await write(plain);
    const bytes = await readFile(path);
    expect(bytes.includes(Buffer.from('+34600111222'))).toBe(false);
    expect(bytes.includes(Buffer.from('mensaje privado'))).toBe(false);
  });

  it('un byte cambiado en un bloque → corrupted', async () => {
    const path = await write(randomBytes(BLOCK_SIZE * 2 + 5));
    const bytes = await readFile(path);
    const [, second] = await blocks(path);
    const at = (second?.[0] ?? 0) + 30;
    bytes[at] = (bytes[at] ?? 0) ^ 0xff;
    await writeFile(path, bytes);
    expect((await failure(read(path))).code).toBe('corrupted');
  });

  it('fichero truncado (sin bloque final) → corrupted', async () => {
    const path = await write(randomBytes(BLOCK_SIZE * 2 + 5));
    const all = await blocks(path);
    const last = all.at(-1) ?? [0, 0];
    const bytes = await readFile(path);
    await writeFile(path, bytes.subarray(0, last[0]));
    expect((await failure(read(path))).code).toBe('corrupted');
  });

  it('truncado a mitad de un bloque → corrupted', async () => {
    const path = await write(randomBytes(BLOCK_SIZE + 5));
    const bytes = await readFile(path);
    await writeFile(path, bytes.subarray(0, bytes.length - 3));
    expect((await failure(read(path))).code).toBe('corrupted');
  });

  it('bloques reordenados → corrupted', async () => {
    const path = await write(randomBytes(BLOCK_SIZE * 3 + 5));
    const bytes = await readFile(path);
    const [first, second] = await blocks(path);
    const a = bytes.subarray(first?.[0], (first?.[0] ?? 0) + (first?.[1] ?? 0));
    const b = bytes.subarray(second?.[0], (second?.[0] ?? 0) + (second?.[1] ?? 0));
    const swapped = Buffer.concat([
      bytes.subarray(0, first?.[0]),
      Buffer.from(b),
      Buffer.from(a),
      bytes.subarray((second?.[0] ?? 0) + (second?.[1] ?? 0)),
    ]);
    await writeFile(path, swapped);
    expect((await failure(read(path))).code).toBe('corrupted');
  });

  it('bytes sobrantes tras el último bloque → corrupted', async () => {
    const path = await write(Buffer.from('datos'));
    const bytes = await readFile(path);
    await writeFile(path, Buffer.concat([bytes, Buffer.from([1, 2, 3])]));
    expect((await failure(read(path))).code).toBe('corrupted');
  });

  it('cabecera manipulada (un recuento cambiado) → corrupted', async () => {
    const path = await write(Buffer.from('datos'));
    const bytes = await readFile(path);
    const text = bytes.toString('latin1').replace('"rows":1', '"rows":7');
    await writeFile(path, Buffer.from(text, 'latin1'));
    expect((await readHeader(path)).header.tables[0]?.rows).toBe(7);
    expect((await failure(read(path))).code).toBe('corrupted');
    expect((await failure(authenticateHeader(path, [KEY]))).code).toBe('corrupted');
  });

  it('clave incorrecta → wrong_key con el keyId de la cabecera', async () => {
    const path = await write(Buffer.from('datos'));
    const error = await failure(read(path, [OTHER_KEY]));
    expect(error.code).toBe('wrong_key');
    expect(error.details.keyId).toBe(keyId(KEY));
    expect(error.message).not.toContain(KEY.toString('hex'));
  });

  it('una clave anterior en la lista de lectura descifra', async () => {
    const path = await write(Buffer.from('datos'));
    expect((await read(path, [OTHER_KEY, KEY])).toString()).toBe('datos');
    await expect(authenticateHeader(path, [OTHER_KEY, KEY])).resolves.toMatchObject({
      instanceId: 'demo-01',
    });
  });

  it('firma distinta → not_a_backup', async () => {
    const path = join(dir, 'ajeno.cbak');
    await writeFile(path, 'PGDMP esto no es una copia');
    expect((await failure(readHeader(path))).code).toBe('not_a_backup');
  });

  it('cabecera que no es JSON → not_a_backup', async () => {
    const path = await write(Buffer.from('datos'));
    const bytes = await readFile(path);
    bytes[12] = 0x7a; // '{' → 'z'
    await writeFile(path, bytes);
    expect((await failure(readHeader(path))).code).toBe('not_a_backup');
  });

  it('formatVersion 2 → unsupported_format', async () => {
    const path = await write(Buffer.from('datos'));
    const text = (await readFile(path))
      .toString('latin1')
      .replace('"formatVersion":1', '"formatVersion":2');
    await writeFile(path, Buffer.from(text, 'latin1'));
    expect((await failure(readHeader(path))).code).toBe('unsupported_format');
  });

  it('versión de la firma desconocida → unsupported_format', async () => {
    const path = await write(Buffer.from('datos'));
    const bytes = await readFile(path);
    bytes[7] = 2;
    await writeFile(path, bytes);
    expect((await failure(readHeader(path))).code).toBe('unsupported_format');
  });

  it('campo desconocido en la cabecera → rechazo', async () => {
    const path = await write(Buffer.from('datos'));
    const bytes = await readFile(path);
    const length = bytes.readUInt32BE(8);
    const header = JSON.parse(bytes.subarray(12, 12 + length).toString('utf8')) as object;
    const forged = Buffer.from(JSON.stringify({ ...header, owner: 'x' }));
    const prefix = Buffer.alloc(12);
    bytes.copy(prefix, 0, 0, 8);
    prefix.writeUInt32BE(forged.length, 8);
    await writeFile(path, Buffer.concat([prefix, forged, bytes.subarray(12 + length)]));
    await expect(readHeader(path)).rejects.toBeInstanceOf(RestoreFailure);
  });
});
