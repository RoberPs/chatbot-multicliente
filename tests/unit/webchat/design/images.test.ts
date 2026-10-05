/**
 * Validación y normalización de las imágenes del diseño (011, research R7), con los ficheros de
 * `tests/fixtures/images/` (ver su README).
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DAMAGED_MESSAGE,
  DIMENSIONS_MESSAGE,
  FORMAT_MESSAGE,
  TOO_BIG_MESSAGE,
  validateDesignImage,
  type DesignImage,
} from '../../../../src/webchat/design/images.js';
import { loadImageFixture } from '../../../helpers/chat-design.js';

const check = (name: string, truncated = false) =>
  validateDesignImage({ bytes: loadImageFixture(name), truncated });

function accepted(name: string): DesignImage {
  const result = check(name);
  if (!result.ok) throw new Error(`${name} rechazada: ${result.message}`);
  return result.image;
}

const has = (bytes: Buffer, text: string) => bytes.includes(Buffer.from(text, 'latin1'));

describe('validateDesignImage', () => {
  it.each([
    ['valid.png', 'image/png'],
    ['valid.jpg', 'image/jpeg'],
    ['valid.webp', 'image/webp'],
    ['valid-vp8x.webp', 'image/webp'],
  ])('acepta %s con su tipo y dimensiones', (name, type) => {
    const image = accepted(name);
    expect(image).toMatchObject({ mimeType: type, width: 64, height: 64 });
    // Sin metadatos que quitar, los bytes no cambian.
    expect(image.bytes.equals(loadImageFixture(name))).toBe(true);
    expect(image.byteSize).toBe(image.bytes.length);
  });

  it.each(['svg-renamed.png', 'html-renamed.png', 'exe-renamed.png', 'gif.gif'])(
    '%s: formato no admitido',
    (name) => {
      expect(check(name)).toEqual({ ok: false, message: FORMAT_MESSAGE });
    },
  );

  it.each(['empty.png', 'truncated.png', 'bad-crc.png'])('%s: dañada o vacía', (name) => {
    expect(check(name)).toEqual({ ok: false, message: DAMAGED_MESSAGE });
  });

  it.each(['too-small.png', 'too-large-dims.png'])('%s: fuera de las dimensiones', (name) => {
    expect(check(name)).toEqual({ ok: false, message: DIMENSIONS_MESSAGE });
  });

  it('más de 256 KB, o cortada en la subida: supera el máximo', () => {
    expect(check('too-big.png')).toEqual({ ok: false, message: TOO_BIG_MESSAGE });
    expect(check('valid.png', true)).toEqual({ ok: false, message: TOO_BIG_MESSAGE });
  });

  it('PNG con metadatos: sale sin tEXt, iTXt, eXIf ni tIME y sigue siendo válido', () => {
    const original = loadImageFixture('metadata.png');
    for (const chunk of ['tEXt', 'iTXt', 'eXIf', 'tIME']) expect(has(original, chunk)).toBe(true);
    const image = accepted('metadata.png');
    for (const chunk of ['tEXt', 'iTXt', 'eXIf', 'tIME'])
      expect(has(image.bytes, chunk)).toBe(false);
    expect(image.bytes.equals(loadImageFixture('valid.png'))).toBe(true);
    expect(validateDesignImage({ bytes: image.bytes, truncated: false }).ok).toBe(true);
  });

  it('JPEG con metadatos: sale sin APP1, APP13 ni COM', () => {
    const image = accepted('metadata.jpg');
    expect(has(image.bytes, 'Exif')).toBe(false);
    expect(has(image.bytes, 'Photoshop')).toBe(false);
    expect(has(image.bytes, 'Comentario')).toBe(false);
    expect(image.bytes.equals(loadImageFixture('valid.jpg'))).toBe(true);
  });

  it('WebP con metadatos: sale sin EXIF ni XMP y sin sus banderas en VP8X', () => {
    const image = accepted('metadata.webp');
    expect(has(image.bytes, 'EXIF')).toBe(false);
    expect(has(image.bytes, 'XMP ')).toBe(false);
    expect(image.bytes.readUInt32LE(4) + 8).toBe(image.bytes.length);
    // Bandera de VP8X: byte 20 (RIFF 12 + cabecera del bloque 8).
    expect((image.bytes[20] ?? 0) & 0x0c).toBe(0);
    expect(image.bytes.equals(loadImageFixture('valid-vp8x.webp'))).toBe(true);
  });

  it('las imágenes animadas se aceptan y siguen animadas', () => {
    const png = accepted('animated.png');
    expect(has(png.bytes, 'acTL')).toBe(true);
    expect(has(png.bytes, 'fdAT')).toBe(true);
    const webp = accepted('animated.webp');
    expect(has(webp.bytes, 'ANIM')).toBe(true);
    expect(has(webp.bytes, 'ANMF')).toBe(true);
  });

  it('normalizar dos veces da los mismos bytes (SC-008)', () => {
    for (const name of [
      'metadata.png',
      'metadata.jpg',
      'metadata.webp',
      'animated.png',
      'valid.webp',
    ]) {
      const once = accepted(name);
      const twice = validateDesignImage({ bytes: once.bytes, truncated: false });
      if (!twice.ok) throw new Error(name);
      expect([name, twice.image.bytes.equals(once.bytes)]).toEqual([name, true]);
      expect(twice.image.sha256).toBe(once.sha256);
    }
  });

  it('sha256 es el de los bytes normalizados', () => {
    const image = accepted('metadata.png');
    expect(image.sha256).toBe(createHash('sha256').update(image.bytes).digest('hex'));
  });

  it('nada pegado detrás del final de la imagen (PNG y JPEG)', () => {
    const png = Buffer.concat([loadImageFixture('valid.png'), Buffer.from('<script>')]);
    expect(validateDesignImage({ bytes: png, truncated: false })).toEqual({
      ok: false,
      message: DAMAGED_MESSAGE,
    });
    const jpg = Buffer.concat([loadImageFixture('valid.jpg'), Buffer.from('<html>')]);
    expect(validateDesignImage({ bytes: jpg, truncated: false }).ok).toBe(false);
  });
});
