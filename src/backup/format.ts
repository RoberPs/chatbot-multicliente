/**
 * Formato de fichero CBAK v1 (006, contracts/backup-file-format.md, research R3).
 *
 *   firma "CBAK\0\0\0\1" · longitud de la cabecera (uint32 BE) · cabecera JSON en claro ·
 *   bloques [L (uint32 BE) · texto cifrado AES-256-GCM · etiqueta de 16 bytes]
 *
 * El texto en claro de los bloques es el flujo gzip del volcado, en trozos de 64 KiB (el último,
 * de 1 a 64 KiB). Nonce = contador de 11 bytes BE + byte de último bloque; AAD = SHA-256 de la
 * cabecera. Cada bloque se autentica antes de entregar su contenido; un fichero truncado, con
 * bloques reordenados o con bytes sobrantes se rechaza.
 *
 * Todo núcleo futuro MUST seguir leyendo la v1 (FR-017).
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { Readable, Transform, type TransformCallback } from 'node:stream';
import { createGunzip, createGzip } from 'node:zlib';
import { z } from 'zod';
import { INSTANCE_ID_PATTERN } from '../config/env.js';
import { deriveFileKey, keyId } from './config.js';
import { RestoreFailure } from './errors.js';
import { BACKUP_REASONS } from './naming.js';

export const SIGNATURE = Buffer.from([0x43, 0x42, 0x41, 0x4b, 0x00, 0x00, 0x00, 0x01]);
export const BLOCK_SIZE = 65_536;
export const MAX_HEADER_BYTES = 65_536;
const TAG_BYTES = 16;
const PREFIX_BYTES = SIGNATURE.length + 4;

const schemaVersionSchema = z.strictObject({
  index: z.number().int().min(0),
  tag: z.string().regex(/^\d{4}_[a-z0-9_]+$/),
  hash: z.string().regex(/^[0-9a-f]{64}$/),
});

export const headerSchema = z.strictObject({
  format: z.literal('cbak'),
  formatVersion: z.literal(1),
  instanceId: z.string().regex(INSTANCE_ID_PATTERN),
  schema: schemaVersionSchema,
  coreVersion: z.string().min(1).max(64),
  createdAt: z.iso.datetime(),
  reason: z.enum(BACKUP_REASONS),
  tables: z.array(
    z.strictObject({
      schema: z.string().min(1).max(63),
      name: z.string().min(1).max(63),
      rows: z.number().int().min(0),
    }),
  ),
  salt: z.base64().refine((s) => Buffer.from(s, 'base64').length === 16),
  keyId: z.string().regex(/^[0-9a-f]{16}$/),
});

export type BackupHeader = z.infer<typeof headerSchema>;
/** Lo que aporta quien escribe; la sal y el `keyId` los pone el escritor. */
export type HeaderInput = Omit<BackupHeader, 'format' | 'formatVersion' | 'salt' | 'keyId'>;

export interface ParsedHeader {
  header: BackupHeader;
  /** Bytes exactos de la cabecera (su SHA-256 es el AAD). */
  raw: Buffer;
  /** Posición del primer bloque. */
  offset: number;
}

function nonce(counter: bigint, last: boolean): Buffer {
  const n = Buffer.alloc(12);
  // 11 bytes big-endian: los 3 primeros quedan a cero (más de 2^64 bloques no es posible).
  n.writeBigUInt64BE(counter, 3);
  n[11] = last ? 1 : 0;
  return n;
}

function encryptBlock(key: Buffer, aad: Buffer, counter: bigint, last: boolean, data: Buffer) {
  const cipher = createCipheriv('aes-256-gcm', key, nonce(counter, last));
  cipher.setAAD(aad);
  const body = Buffer.concat([cipher.update(data), cipher.final()]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  return Buffer.concat([length, body, cipher.getAuthTag()]);
}

function decryptBlock(
  key: Buffer,
  aad: Buffer,
  counter: bigint,
  last: boolean,
  body: Buffer,
  tag: Buffer,
): Buffer | null {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce(counter, last));
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    return null;
  }
}

/** Interpreta firma y cabecera de los primeros bytes de un fichero. */
export function parseHeaderBytes(bytes: Buffer): ParsedHeader {
  if (bytes.length < PREFIX_BYTES || !bytes.subarray(0, 4).equals(SIGNATURE.subarray(0, 4))) {
    throw new RestoreFailure('not_a_backup');
  }
  if (!bytes.subarray(0, 7).equals(SIGNATURE.subarray(0, 7))) {
    throw new RestoreFailure('not_a_backup');
  }
  if (bytes[7] !== SIGNATURE[7]) throw new RestoreFailure('unsupported_format');
  const length = bytes.readUInt32BE(SIGNATURE.length);
  if (length === 0 || length > MAX_HEADER_BYTES) throw new RestoreFailure('not_a_backup');
  if (bytes.length < PREFIX_BYTES + length) throw new RestoreFailure('corrupted');
  const raw = bytes.subarray(PREFIX_BYTES, PREFIX_BYTES + length);
  let json: unknown;
  try {
    json = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new RestoreFailure('not_a_backup');
  }
  const shape = json as { format?: unknown; formatVersion?: unknown } | null;
  if (typeof shape !== 'object' || shape === null || shape.format !== 'cbak') {
    throw new RestoreFailure('not_a_backup');
  }
  if (shape.formatVersion !== 1) throw new RestoreFailure('unsupported_format');
  const parsed = headerSchema.safeParse(json);
  if (!parsed.success) throw new RestoreFailure('corrupted');
  return { header: parsed.data, raw: Buffer.from(raw), offset: PREFIX_BYTES + length };
}

/** Lee la cabecera de un fichero sin clave (retención, listados, resumen de la restauración). */
export async function readHeader(path: string): Promise<ParsedHeader> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(PREFIX_BYTES + MAX_HEADER_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return parseHeaderBytes(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

/** Clave de lectura cuyo `keyId` es el de la cabecera; `wrong_key` si ninguna lo tiene. */
function pickKey(header: BackupHeader, keys: Buffer[]): Buffer {
  if (keys.length === 0) throw new RestoreFailure('key_missing');
  const key = keys.find((k) => keyId(k) === header.keyId);
  if (!key) throw new RestoreFailure('wrong_key', { keyId: header.keyId });
  return key;
}

/**
 * Autentica la cabecera descifrando solo el primer bloque (retención: copia "válida"). Lanza
 * `wrong_key` o `corrupted`.
 */
export async function authenticateHeader(path: string, keys: Buffer[]): Promise<BackupHeader> {
  const { header, raw, offset } = await readHeader(path);
  const key = pickKey(header, keys);
  const fileKey = deriveFileKey(key, Buffer.from(header.salt, 'base64'));
  const aad = createHash('sha256').update(raw).digest();
  const handle = await open(path, 'r');
  try {
    const lengthBytes = Buffer.alloc(4);
    const first = await handle.read(lengthBytes, 0, 4, offset);
    if (first.bytesRead < 4) throw new RestoreFailure('corrupted');
    const length = lengthBytes.readUInt32BE(0);
    if (length < 1 || length > BLOCK_SIZE) throw new RestoreFailure('corrupted');
    const block = Buffer.alloc(length + TAG_BYTES);
    const { bytesRead } = await handle.read(block, 0, block.length, offset + 4);
    if (bytesRead < block.length) throw new RestoreFailure('corrupted');
    const body = block.subarray(0, length);
    const tag = block.subarray(length);
    const ok =
      decryptBlock(fileKey, aad, 0n, false, body, tag) ??
      decryptBlock(fileKey, aad, 0n, true, body, tag);
    if (!ok) throw new RestoreFailure('corrupted');
    return header;
  } finally {
    await handle.close();
  }
}

/**
 * Escritor CBAK: recibe el volcado en claro y emite los bytes del fichero (firma, cabecera y
 * bloques cifrados del flujo gzip).
 */
export function createBackupWriter(
  input: HeaderInput,
  key: Buffer,
): { header: BackupHeader; stream: Transform } {
  const salt = randomBytes(16);
  const header: BackupHeader = {
    format: 'cbak',
    formatVersion: 1,
    ...input,
    salt: salt.toString('base64'),
    keyId: keyId(key),
  };
  const raw = Buffer.from(JSON.stringify(header), 'utf8');
  if (raw.length > MAX_HEADER_BYTES) throw new Error('Cabecera demasiado grande');
  const fileKey = deriveFileKey(key, salt);
  const aad = createHash('sha256').update(raw).digest();
  const length = Buffer.alloc(4);
  length.writeUInt32BE(raw.length);

  let counter = 0n;
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  const gzip = createGzip();

  const stream = new Transform({
    transform(chunk: Buffer, _encoding, callback: TransformCallback) {
      if (gzip.write(chunk)) callback();
      else
        gzip.once('drain', () => {
          callback();
        });
    },
    flush(callback: TransformCallback) {
      gzip.once('end', () => {
        // El flujo gzip nunca está vacío: el último bloque tiene de 1 a 64 KiB.
        const rest = Buffer.concat(pending);
        stream.push(encryptBlock(fileKey, aad, counter, true, rest));
        callback();
      });
      gzip.end();
    },
    destroy(error, callback) {
      gzip.destroy();
      callback(error);
    },
  });

  gzip.on('data', (data: Buffer) => {
    pending.push(data);
    pendingBytes += data.length;
    // Se guarda siempre al menos un byte: el bloque final debe llevar la marca de último.
    while (pendingBytes > BLOCK_SIZE) {
      const all = Buffer.concat(pending);
      stream.push(encryptBlock(fileKey, aad, counter, false, all.subarray(0, BLOCK_SIZE)));
      counter += 1n;
      const rest = all.subarray(BLOCK_SIZE);
      pending = [rest];
      pendingBytes = rest.length;
    }
  });
  gzip.on('error', (error) => stream.destroy(error));

  stream.push(Buffer.concat([SIGNATURE, length, raw]));
  return { header, stream };
}

/** Descifra los bloques de un fichero y entrega el flujo gzip autenticado. */
class BlockDecryptor extends Transform {
  private buffer: Buffer = Buffer.alloc(0);
  private counter = 0n;
  private finished = false;

  constructor(
    private readonly fileKey: Buffer,
    private readonly aad: Buffer,
  ) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    try {
      this.drain();
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }

  private drain() {
    for (;;) {
      if (this.finished) {
        if (this.buffer.length > 0) throw new RestoreFailure('corrupted');
        return;
      }
      if (this.buffer.length < 4) return;
      const length = this.buffer.readUInt32BE(0);
      if (length < 1 || length > BLOCK_SIZE) throw new RestoreFailure('corrupted');
      const total = 4 + length + TAG_BYTES;
      if (this.buffer.length < total) return;
      const body = this.buffer.subarray(4, 4 + length);
      const tag = this.buffer.subarray(4 + length, total);
      let plain = decryptBlock(this.fileKey, this.aad, this.counter, false, body, tag);
      if (plain) {
        if (length !== BLOCK_SIZE) throw new RestoreFailure('corrupted');
      } else {
        plain = decryptBlock(this.fileKey, this.aad, this.counter, true, body, tag);
        if (!plain) throw new RestoreFailure('corrupted');
        this.finished = true;
      }
      this.counter += 1n;
      this.buffer = this.buffer.subarray(total);
      this.push(plain);
    }
  }

  override _flush(callback: TransformCallback) {
    if (!this.finished || this.buffer.length > 0) callback(new RestoreFailure('corrupted'));
    else callback();
  }
}

export interface OpenedBackup {
  header: BackupHeader;
  /** Volcado en claro; falla con `RestoreFailure('corrupted')` ante cualquier manipulación. */
  stream: Readable;
}

/**
 * Abre una copia para leerla entera. La cabecera se valida antes; el flujo solo entrega datos
 * de bloques autenticados y termina con error si falta el bloque final o sobran bytes.
 */
export async function openBackup(path: string, keys: Buffer[]): Promise<OpenedBackup> {
  const { header, raw, offset } = await readHeader(path);
  const key = pickKey(header, keys);
  const fileKey = deriveFileKey(key, Buffer.from(header.salt, 'base64'));
  const aad = createHash('sha256').update(raw).digest();

  const source = createReadStream(path, { start: offset });
  const decryptor = new BlockDecryptor(fileKey, aad);
  const gunzip = createGunzip();
  const output = new Readable({ read() {} });

  const fail = (error: unknown) => {
    source.destroy();
    decryptor.destroy();
    gunzip.destroy();
    output.destroy(error instanceof RestoreFailure ? error : new RestoreFailure('corrupted'));
  };
  source.on('error', fail);
  decryptor.on('error', fail);
  gunzip.on('error', fail);

  let paused = false;
  gunzip.on('data', (data: Buffer) => {
    if (!output.push(data)) {
      paused = true;
      gunzip.pause();
    }
  });
  output._read = () => {
    if (paused) {
      paused = false;
      gunzip.resume();
    }
  };
  gunzip.on('end', () => output.push(null));
  output.on('close', () => {
    if (!output.readableEnded) {
      source.destroy();
      decryptor.destroy();
      gunzip.destroy();
    }
  });
  source.pipe(decryptor).pipe(gunzip);
  return { header, stream: output };
}
