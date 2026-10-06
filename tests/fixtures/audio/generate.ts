/**
 * Genera las notas de voz de prueba de la 012 (research R6.3) en esta carpeta.
 *
 * Sin dependencias: ficheros Ogg con un flujo Opus mínimo (cabeceras `OpusHead` y `OpusTags` y
 * páginas de audio con su `granule_position`), que es lo único que lee
 * `src/usage/transcription-cost.ts` para calcular la duración. El audio no se puede reproducir:
 * los paquetes son relleno. Los ficheros generados se versionan; este script solo hace falta para
 * regenerarlos:
 *
 *   pnpm tsx tests/fixtures/audio/generate.ts
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));

/** Muestras por segundo de la `granule_position` de Opus (siempre 48 kHz). */
const OPUS_RATE = 48_000;
const SERIAL = 0x12345678;

// CRC de Ogg: polinomio 0x04c11db7 sin reflejar.
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n << 24;
  for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
  return c >>> 0;
});

function crc32(data: Buffer): number {
  let c = 0;
  for (const byte of data) c = ((c << 8) ^ (CRC_TABLE[((c >>> 24) ^ byte) & 0xff] ?? 0)) >>> 0;
  return c >>> 0;
}

/** Una página Ogg con un solo paquete (≤ 255 × 255 bytes). */
function page(opts: { type: number; granule: bigint; sequence: number; packet: Buffer }): Buffer {
  const lacing: number[] = [];
  let rest = opts.packet.length;
  while (rest >= 255) {
    lacing.push(255);
    rest -= 255;
  }
  lacing.push(rest);
  const header = Buffer.alloc(27);
  header.write('OggS', 0, 'ascii');
  header.writeUInt8(0, 4);
  header.writeUInt8(opts.type, 5);
  header.writeBigInt64LE(opts.granule, 6);
  header.writeUInt32LE(SERIAL, 14);
  header.writeUInt32LE(opts.sequence, 18);
  header.writeUInt32LE(0, 22);
  header.writeUInt8(lacing.length, 26);
  const full = Buffer.concat([header, Buffer.from(lacing), opts.packet]);
  full.writeUInt32LE(crc32(full), 22);
  return full;
}

const opusHead = (): Buffer => {
  const b = Buffer.alloc(19);
  b.write('OpusHead', 0, 'ascii');
  b.writeUInt8(1, 8); // versión
  b.writeUInt8(1, 9); // canales
  b.writeUInt16LE(312, 10); // pre-skip
  b.writeUInt32LE(OPUS_RATE, 12);
  b.writeInt16LE(0, 16);
  b.writeUInt8(0, 18);
  return b;
};

const opusTags = (): Buffer => {
  const vendor = Buffer.from('chatbotasesor-fixture', 'ascii');
  const b = Buffer.alloc(8 + 4 + vendor.length + 4);
  b.write('OpusTags', 0, 'ascii');
  b.writeUInt32LE(vendor.length, 8);
  vendor.copy(b, 12);
  b.writeUInt32LE(0, 12 + vendor.length);
  return b;
};

/** Nota de voz de `seconds` segundos: una página de audio por segundo. */
function voice(seconds: number, opts: { lastGranule?: bigint } = {}): Buffer {
  const pages = [
    page({ type: 0x02, granule: 0n, sequence: 0, packet: opusHead() }),
    page({ type: 0x00, granule: 0n, sequence: 1, packet: opusTags() }),
  ];
  for (let s = 1; s <= seconds; s++) {
    const last = s === seconds;
    const granule = last && opts.lastGranule !== undefined ? opts.lastGranule : BigInt(s * OPUS_RATE);
    pages.push(
      page({
        type: last ? 0x04 : 0x00,
        granule,
        sequence: s + 1,
        packet: Buffer.alloc(40, s & 0xff),
      }),
    );
  }
  return Buffer.concat(pages);
}

const files: Record<string, Buffer> = {
  'voice-3s.ogg': voice(3),
  'voice-119s.ogg': voice(119),
  // Todas las páginas de audio sin paquete terminado (granule -1): no hay página final válida.
  'no-granule.ogg': (() => {
    const pages = [
      page({ type: 0x02, granule: 0n, sequence: 0, packet: opusHead() }),
      page({ type: 0x00, granule: 0n, sequence: 1, packet: opusTags() }),
    ];
    for (let s = 1; s <= 3; s++) {
      pages.push(page({ type: 0x00, granule: -1n, sequence: s + 1, packet: Buffer.alloc(40) }));
    }
    return Buffer.concat(pages);
  })(),
  // Cortado a mitad de la última página: no se sabe dónde acaba el audio.
  'truncated.ogg': (() => {
    const full = voice(3);
    return full.subarray(0, full.length - 20);
  })(),
  'not-ogg.bin': Buffer.from('Esto no es un fichero Ogg, solo texto de relleno.\n', 'utf8'),
};

for (const [name, data] of Object.entries(files)) {
  writeFileSync(`${here}${name}`, data);
}
console.log(`Generados ${Object.keys(files).length} ficheros en ${here}`);
