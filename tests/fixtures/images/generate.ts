/**
 * Genera las imágenes de prueba de la 011 (research R7) en esta carpeta.
 *
 * Sin dependencias: PNG con `node:zlib` (se pueden abrir en cualquier visor) y JPEG y WebP con la
 * estructura justa que comprueba `src/webchat/design/images.ts` (marcadores, bloques y
 * dimensiones). Los ficheros generados se versionan; este script solo hace falta para
 * regenerarlos:
 *
 *   pnpm tsx tests/fixtures/images/generate.ts
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const here = fileURLToPath(new URL('.', import.meta.url));

// --- Utilidades ---------------------------------------------------------------------------

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

const u32be = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
};
const u16be = (n: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
};
const u32le = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
};
const u24le = (n: number) => Buffer.from([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff]);

/** Generador pseudoaleatorio con semilla fija: los ficheros salen siempre iguales. */
function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s >>> 24;
  };
}

// --- PNG ----------------------------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.from(type, 'latin1');
  return Buffer.concat([u32be(data.length), head, data, u32be(crc32(Buffer.concat([head, data])))]);
}

function ihdr(width: number, height: number, colorType: number): Buffer {
  return chunk(
    'IHDR',
    Buffer.concat([u32be(width), u32be(height), Buffer.from([8, colorType, 0, 0, 0])]),
  );
}

/** Píxeles RGB: degradado o ruido, con el filtro 0 en cada fila. */
function rgbRows(width: number, height: number, noise = false): Buffer {
  const next = prng(width * 31 + height);
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x++) {
      row[1 + x * 3] = noise ? next() : (x * 4) & 0xff;
      row[2 + x * 3] = noise ? next() : (y * 4) & 0xff;
      row[3 + x * 3] = noise ? next() : 0x80;
    }
    rows.push(row);
  }
  return Buffer.concat(rows);
}

function png(width: number, height: number, opts: { extra?: Buffer[]; noise?: boolean } = {}) {
  return Buffer.concat([
    PNG_SIGNATURE,
    ihdr(width, height, 2),
    ...(opts.extra ?? []),
    chunk('IDAT', deflateSync(rgbRows(width, height, opts.noise), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Escala de grises de un solo color: muy grande en píxeles y muy pequeña en bytes. */
function hugeGrayPng(width: number, height: number): Buffer {
  return Buffer.concat([
    PNG_SIGNATURE,
    ihdr(width, height, 0),
    chunk('IDAT', deflateSync(Buffer.alloc((width + 1) * height), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function apng(width: number, height: number): Buffer {
  const fctl = (seq: number) =>
    chunk(
      'fcTL',
      Buffer.concat([
        u32be(seq),
        u32be(width),
        u32be(height),
        u32be(0),
        u32be(0),
        u16be(1),
        u16be(2),
        Buffer.from([0, 0]),
      ]),
    );
  const frame = deflateSync(rgbRows(width, height));
  const frame2 = deflateSync(rgbRows(width, height, true));
  return Buffer.concat([
    PNG_SIGNATURE,
    ihdr(width, height, 2),
    chunk('acTL', Buffer.concat([u32be(2), u32be(0)])),
    fctl(0),
    chunk('IDAT', frame),
    fctl(1),
    chunk('fdAT', Buffer.concat([u32be(2), frame2])),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const validPng = png(64, 64);
const metadataPng = png(64, 64, {
  extra: [
    chunk('tEXt', Buffer.from('Author\0Nombre de quien hizo la foto', 'latin1')),
    chunk('iTXt', Buffer.from('Comment\0\0\0\0\0Texto con datos privados', 'utf8')),
    chunk('eXIf', Buffer.from('MM\0*\0\0\0\x08\0\0', 'latin1')),
    chunk('tIME', Buffer.from([0x07, 0xea, 9, 30, 12, 0, 0])),
  ],
});
const badCrc = Buffer.from(validPng);
// Último byte del CRC de IHDR (firma 8 + longitud 4 + tipo 4 + datos 13 + CRC 4).
const crcAt = 8 + 4 + 4 + 13 + 3;
badCrc[crcAt] = (badCrc[crcAt] ?? 0) ^ 0xff;

// --- JPEG ---------------------------------------------------------------------------------

const segment = (marker: number, data: Buffer) =>
  Buffer.concat([Buffer.from([0xff, marker]), u16be(data.length + 2), data]);

function jpeg(width: number, height: number, extra: Buffer[] = []): Buffer {
  const app0 = segment(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1'));
  const dqt = segment(0xdb, Buffer.concat([Buffer.from([0]), Buffer.alloc(64, 1)]));
  const sof0 = segment(
    0xc0,
    Buffer.concat([
      Buffer.from([8]),
      u16be(height),
      u16be(width),
      Buffer.from([3, 1, 0x22, 0, 2, 0x11, 0, 3, 0x11, 0]),
    ]),
  );
  const dht = segment(
    0xc4,
    Buffer.concat([Buffer.from([0x00]), Buffer.from([0, 1]), Buffer.alloc(14), Buffer.from([0])]),
  );
  const sos = segment(0xda, Buffer.from([3, 1, 0x00, 2, 0x00, 3, 0x00, 0, 63, 0]));
  // Datos de la imagen: incluye un 0xFF con relleno (FF 00) y un reinicio (FF D0).
  const scan = Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78, 0x9a]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    app0,
    ...extra,
    dqt,
    sof0,
    dht,
    sos,
    scan,
    Buffer.from([0xff, 0xd9]),
  ]);
}

const validJpg = jpeg(64, 64);
const metadataJpg = jpeg(64, 64, [
  segment(0xe1, Buffer.from('Exif\0\0MM\0*\0\0\0\x08\0\0', 'latin1')),
  segment(0xed, Buffer.from('Photoshop 3.0\x008BIM', 'latin1')),
  segment(0xfe, Buffer.from('Comentario con datos privados', 'latin1')),
]);

// --- WebP ---------------------------------------------------------------------------------

function riffChunk(type: string, data: Buffer): Buffer {
  const pad = data.length % 2 === 1 ? Buffer.alloc(1) : Buffer.alloc(0);
  return Buffer.concat([Buffer.from(type, 'latin1'), u32le(data.length), data, pad]);
}

function riff(chunks: Buffer[]): Buffer {
  const body = Buffer.concat([Buffer.from('WEBP', 'latin1'), ...chunks]);
  return Buffer.concat([Buffer.from('RIFF', 'latin1'), u32le(body.length), body]);
}

/** Cabecera VP8L (firma 0x2F, 14 + 14 bits de dimensiones) y unos bytes de datos. */
function vp8l(width: number, height: number): Buffer {
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
  return riffChunk(
    'VP8L',
    Buffer.concat([Buffer.from([0x2f]), u32le(bits), Buffer.from([0x07, 0x10, 0x88, 0x88])]),
  );
}

function vp8x(width: number, height: number, flags: number): Buffer {
  return riffChunk(
    'VP8X',
    Buffer.concat([Buffer.from([flags, 0, 0, 0]), u24le(width - 1), u24le(height - 1)]),
  );
}

const validWebp = riff([vp8l(64, 64)]);
const validVp8xWebp = riff([vp8x(64, 64, 0), vp8l(64, 64)]);
const metadataWebp = riff([
  vp8x(64, 64, 0x08 | 0x04),
  vp8l(64, 64),
  riffChunk('EXIF', Buffer.from('MM\0*\0\0\0\x08\0\0', 'latin1')),
  riffChunk('XMP ', Buffer.from('<x:xmpmeta>datos privados</x:xmpmeta>', 'utf8')),
]);
const anmf = (width: number, height: number) =>
  riffChunk(
    'ANMF',
    Buffer.concat([
      u24le(0),
      u24le(0),
      u24le(width - 1),
      u24le(height - 1),
      u24le(100),
      Buffer.from([0]),
      vp8l(width, height),
    ]),
  );
const animatedWebp = riff([
  vp8x(64, 64, 0x02),
  riffChunk('ANIM', Buffer.from([0, 0, 0, 0, 0, 0])),
  anmf(64, 64),
  anmf(64, 64),
]);

// --- Otros formatos y ficheros dañados ----------------------------------------------------

const gif = Buffer.from(
  '474946383961010001008000000000ffffff21f90401000000002c00000000010001000002024401003b',
  'hex',
);
const svg = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><script>alert(1)</script></svg>',
);
const html = Buffer.from('<!doctype html><html><body><script>alert(1)</script></body></html>');
const exe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(126, 0x90)]);

const files: Record<string, Buffer> = {
  'valid.png': validPng,
  'valid.jpg': validJpg,
  'valid.webp': validWebp,
  'valid-vp8x.webp': validVp8xWebp,
  'metadata.png': metadataPng,
  'metadata.jpg': metadataJpg,
  'metadata.webp': metadataWebp,
  'animated.png': apng(64, 64),
  'animated.webp': animatedWebp,
  'svg-renamed.png': svg,
  'html-renamed.png': html,
  'exe-renamed.png': exe,
  'empty.png': Buffer.alloc(0),
  'truncated.png': validPng.subarray(0, Math.floor(validPng.length / 2)),
  'bad-crc.png': badCrc,
  'gif.gif': gif,
  'too-small.png': png(8, 8),
  'too-large-dims.png': hugeGrayPng(2000, 2000),
  'too-big.png': png(300, 300, { noise: true }),
};

for (const [name, bytes] of Object.entries(files)) {
  writeFileSync(`${here}/${name}`, bytes);
  console.log(`${name.padEnd(20)} ${String(bytes.length).padStart(7)} bytes`);
}
