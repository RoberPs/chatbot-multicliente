/**
 * Imágenes del diseño del chat (011, research R7): validación por contenido y normalización.
 *
 * TypeScript puro y síncrono, sin dependencias y sin decodificar píxeles: se recorre la estructura
 * del fichero (PNG: bloques con CRC; JPEG: segmentos; WebP: bloques RIFF), se leen las dimensiones
 * y se quitan los metadatos sin recodificar. El formato sale del contenido, nunca del nombre ni
 * del tipo declarado (FR-026). Quitar metadatos es idempotente: una imagen ya normalizada no
 * cambia, así que reimportar el mismo fichero no muestra cambios (SC-008).
 *
 * La misma función valida las imágenes del panel y las de la importación (FR-036).
 */
import { createHash } from 'node:crypto';
import type { ImageType } from './defaults.js';

export const MAX_IMAGE_BYTES = 256 * 1024;
export const MIN_IMAGE_SIDE = 16;
export const MAX_IMAGE_SIDE = 1024;

export const FORMAT_MESSAGE = 'Formato no admitido: solo PNG, JPEG o WebP';
export const DAMAGED_MESSAGE = 'La imagen está dañada o vacía';
export const TOO_BIG_MESSAGE = 'La imagen supera el máximo de 256 KB';
export const DIMENSIONS_MESSAGE = 'La imagen debe medir entre 16 y 1024 px de ancho y de alto';

/** Extensión de la URL de cada tipo (R10). */
export const IMAGE_EXTENSIONS: Record<ImageType, 'png' | 'jpg' | 'webp'> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

/** Imagen validada y sin metadatos, lista para guardar. */
export interface DesignImage {
  mimeType: ImageType;
  bytes: Buffer;
  /** SHA-256 en hexadecimal de `bytes`. */
  sha256: string;
  width: number;
  height: number;
  byteSize: number;
}

/** Fichero tal como llega: `truncated` si la subida se cortó al pasar de 256 KB (R8). */
export interface ImageUpload {
  bytes: Buffer;
  truncated: boolean;
}

/** Cambio de un hueco al guardar desde el panel. */
export type ImageChange =
  { kind: 'keep' } | { kind: 'remove' } | { kind: 'replace'; upload: ImageUpload };

export type ImageResult = { ok: true; image: DesignImage } | { ok: false; message: string };

/** Fallo de estructura: el fichero parece de un formato admitido pero no es válido. */
class Damaged extends Error {}

interface Parsed {
  width: number;
  height: number;
  /** Bytes sin metadatos. */
  normalized: Buffer;
}

// --- PNG ----------------------------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Bloques de texto, EXIF y fecha que se quitan. */
const PNG_METADATA = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']);

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (const byte of data) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function parsePng(bytes: Buffer): Parsed {
  let pos = PNG_SIGNATURE.length;
  const kept: Buffer[] = [bytes.subarray(0, pos)];
  let width = 0;
  let height = 0;
  let first = true;
  let sawData = false;
  let ended = false;
  while (pos < bytes.length) {
    if (ended || pos + 12 > bytes.length) throw new Damaged();
    const length = bytes.readUInt32BE(pos);
    const type = bytes.toString('latin1', pos + 4, pos + 8);
    const end = pos + 12 + length;
    if (length > 0x7fffffff || end > bytes.length || !/^[A-Za-z]{4}$/.test(type)) {
      throw new Damaged();
    }
    if (crc32(bytes.subarray(pos + 4, pos + 8 + length)) !== bytes.readUInt32BE(end - 4)) {
      throw new Damaged();
    }
    if (first) {
      if (type !== 'IHDR' || length !== 13) throw new Damaged();
      width = bytes.readUInt32BE(pos + 8);
      height = bytes.readUInt32BE(pos + 12);
      first = false;
    } else if (type === 'IHDR') {
      throw new Damaged();
    }
    if (type === 'IDAT') sawData = true;
    if (type === 'IEND') ended = true;
    if (!PNG_METADATA.has(type)) kept.push(bytes.subarray(pos, end));
    pos = end;
  }
  if (!ended || !sawData || width === 0 || height === 0) throw new Damaged();
  return { width, height, normalized: Buffer.concat(kept) };
}

// --- JPEG ---------------------------------------------------------------------------------

/** Marcadores SOFn con las dimensiones (todos los C0–CF salvo DHT, JPG y DAC). */
const isSof = (m: number): boolean =>
  m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
/** APP1–APP15 (EXIF, XMP, IPTC, ICC…) y COM: se quitan. APP0 (JFIF) se conserva. */
const isJpegMetadata = (m: number): boolean => (m >= 0xe1 && m <= 0xef) || m === 0xfe;
const isRst = (m: number): boolean => m >= 0xd0 && m <= 0xd7;

function parseJpeg(bytes: Buffer): Parsed {
  const dropped: Array<[number, number]> = [];
  let pos = 2;
  let width = 0;
  let height = 0;
  let sawSof = false;
  let sawScan = false;
  for (;;) {
    if (pos >= bytes.length || bytes[pos] !== 0xff) throw new Damaged();
    const start = pos;
    // Bytes de relleno 0xFF antes del marcador.
    while (bytes[pos + 1] === 0xff) pos++;
    if (pos + 1 >= bytes.length) throw new Damaged();
    const marker = bytes[pos + 1] ?? 0;
    pos += 2;
    if (marker === 0xd9) {
      // EOI: tiene que ser el final del fichero (sin nada pegado detrás).
      if (pos !== bytes.length) throw new Damaged();
      break;
    }
    if (marker === 0xd8 || marker === 0x00) throw new Damaged();
    if (marker === 0x01 || isRst(marker)) continue;
    if (pos + 2 > bytes.length) throw new Damaged();
    const length = bytes.readUInt16BE(pos);
    const end = pos + length;
    if (length < 2 || end > bytes.length) throw new Damaged();
    if (isSof(marker)) {
      if (length < 8) throw new Damaged();
      height = bytes.readUInt16BE(pos + 3);
      width = bytes.readUInt16BE(pos + 5);
      if (width === 0 || height === 0) throw new Damaged();
      sawSof = true;
    }
    if (isJpegMetadata(marker)) dropped.push([start, end]);
    pos = end;
    if (marker === 0xda) {
      if (!sawSof) throw new Damaged();
      sawScan = true;
      // Datos de la imagen hasta el siguiente marcador (FF 00 y los RSTn son parte de ellos).
      while (pos < bytes.length) {
        if (bytes[pos] === 0xff) {
          const next = bytes[pos + 1];
          if (next === undefined) throw new Damaged();
          if (next === 0x00 || isRst(next)) {
            pos += 2;
            continue;
          }
          break;
        }
        pos++;
      }
    }
  }
  if (!sawSof || !sawScan) throw new Damaged();
  if (dropped.length === 0) return { width, height, normalized: bytes };
  const kept: Buffer[] = [];
  let from = 0;
  for (const [start, end] of dropped) {
    kept.push(bytes.subarray(from, start));
    from = end;
  }
  kept.push(bytes.subarray(from));
  return { width, height, normalized: Buffer.concat(kept) };
}

// --- WebP ---------------------------------------------------------------------------------

/** Bloques de metadatos que se quitan, con su bandera en `VP8X`. */
const WEBP_METADATA: Record<string, number> = { EXIF: 0x08, 'XMP ': 0x04 };
const VP8X_ANIMATION = 0x02;

interface RiffChunk {
  fourcc: string;
  start: number;
  /** Fin del bloque, con el byte de relleno si lo hay. */
  end: number;
  data: Buffer;
}

function riffChunks(bytes: Buffer, from: number, to: number): RiffChunk[] {
  const chunks: RiffChunk[] = [];
  let pos = from;
  while (pos < to) {
    if (pos + 8 > to) throw new Damaged();
    const fourcc = bytes.toString('latin1', pos, pos + 4);
    const size = bytes.readUInt32LE(pos + 4);
    const dataEnd = pos + 8 + size;
    const end = dataEnd + (size % 2);
    if (dataEnd > to || end > to) throw new Damaged();
    chunks.push({ fourcc, start: pos, end, data: bytes.subarray(pos + 8, dataEnd) });
    pos = end;
  }
  return chunks;
}

/** Dimensiones de un bloque `VP8 ` (con pérdida) o `VP8L` (sin pérdida). */
function bitstreamSize(chunk: RiffChunk): { width: number; height: number } {
  const d = chunk.data;
  if (chunk.fourcc === 'VP8L') {
    if (d.length < 5 || d[0] !== 0x2f) throw new Damaged();
    const bits = d.readUInt32LE(1);
    if (bits >>> 29 !== 0) throw new Damaged();
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk.fourcc === 'VP8 ') {
    if (d.length < 10 || d[3] !== 0x9d || d[4] !== 0x01 || d[5] !== 0x2a) throw new Damaged();
    if (((d[0] ?? 1) & 1) !== 0) throw new Damaged();
    return { width: d.readUInt16LE(6) & 0x3fff, height: d.readUInt16LE(8) & 0x3fff };
  }
  throw new Damaged();
}

function parseWebp(bytes: Buffer): Parsed {
  if (bytes.length < 20 || bytes.readUInt32LE(4) + 8 !== bytes.length) throw new Damaged();
  const chunks = riffChunks(bytes, 12, bytes.length);
  const first = chunks[0];
  if (!first) throw new Damaged();
  let size: { width: number; height: number };
  let flags = 0;
  if (first.fourcc === 'VP8X') {
    if (first.data.length < 10) throw new Damaged();
    flags = first.data[0] ?? 0;
    size = { width: first.data.readUIntLE(4, 3) + 1, height: first.data.readUIntLE(7, 3) + 1 };
    const rest = chunks.slice(1);
    const hasImage = rest.some((c) => c.fourcc === 'VP8 ' || c.fourcc === 'VP8L');
    const frames = rest.filter((c) => c.fourcc === 'ANMF');
    const animated =
      (flags & VP8X_ANIMATION) !== 0 &&
      rest.some((c) => c.fourcc === 'ANIM') &&
      frames.length > 0 &&
      frames.every((f) => f.data.length >= 16);
    if (!hasImage && !animated) throw new Damaged();
    for (const c of rest) if (c.fourcc === 'VP8 ' || c.fourcc === 'VP8L') bitstreamSize(c);
  } else {
    if (chunks.length !== 1) throw new Damaged();
    size = bitstreamSize(first);
  }
  if (size.width === 0 || size.height === 0) throw new Damaged();

  const strip = chunks.filter((c) => c.fourcc in WEBP_METADATA);
  if (strip.length === 0 && (flags & 0x0c) === 0) return { ...size, normalized: bytes };
  const kept = chunks
    .filter((c) => !(c.fourcc in WEBP_METADATA))
    .map((c) => {
      const raw = Buffer.from(bytes.subarray(c.start, c.end));
      // Sin los bloques, sus banderas de VP8X tampoco.
      if (c.fourcc === 'VP8X') raw[8] = (raw[8] ?? 0) & ~0x0c;
      return raw;
    });
  const body = Buffer.concat([Buffer.from('WEBP', 'latin1'), ...kept]);
  const header = Buffer.alloc(8);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(body.length, 4);
  return { ...size, normalized: Buffer.concat([header, body]) };
}

// --- Entrada común ------------------------------------------------------------------------

function detect(bytes: Buffer): ImageType | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 12 &&
    bytes.toString('latin1', 0, 4) === 'RIFF' &&
    bytes.toString('latin1', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

const PARSERS: Record<ImageType, (bytes: Buffer) => Parsed> = {
  'image/png': parsePng,
  'image/jpeg': parseJpeg,
  'image/webp': parseWebp,
};

/**
 * Valida una imagen por su contenido (R7) y la devuelve sin metadatos, con su tipo detectado,
 * dimensiones, tamaño y huella; o el mensaje de data-model §3.
 */
export function validateDesignImage(upload: ImageUpload): ImageResult {
  const { bytes } = upload;
  if (upload.truncated || bytes.length > MAX_IMAGE_BYTES) {
    return { ok: false, message: TOO_BIG_MESSAGE };
  }
  if (bytes.length === 0) return { ok: false, message: DAMAGED_MESSAGE };
  const mimeType = detect(bytes);
  if (!mimeType) return { ok: false, message: FORMAT_MESSAGE };
  let parsed: Parsed;
  try {
    parsed = PARSERS[mimeType](bytes);
  } catch (error) {
    if (error instanceof Damaged || error instanceof RangeError) {
      return { ok: false, message: DAMAGED_MESSAGE };
    }
    throw error;
  }
  const { width, height, normalized } = parsed;
  const inRange = (side: number) => side >= MIN_IMAGE_SIDE && side <= MAX_IMAGE_SIDE;
  if (!inRange(width) || !inRange(height)) return { ok: false, message: DIMENSIONS_MESSAGE };
  return {
    ok: true,
    image: {
      mimeType,
      bytes: normalized,
      sha256: createHash('sha256').update(normalized).digest('hex'),
      width,
      height,
      byteSize: normalized.length,
    },
  };
}
