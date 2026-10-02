/**
 * El diseño del chat viaja con la configuración (011, US5, FR-035 – FR-039): ida y vuelta con
 * las tres imágenes, reimportar sin cambios, la activación del destino intacta, la configuración
 * anterior que restaura el diseño y el tamaño del fichero.
 */
import { crc32, deflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readChatDesignDocument } from '../../../src/config-transfer/read.js';
import { exportConfig, previewImport, readPreImport } from '../../../src/config-transfer/service.js';
import { withReadSnapshot, type Db } from '../../../src/db/client.js';
import { ORIGINAL_DESIGN } from '../../../src/webchat/design/defaults.js';
import { MAX_IMAGE_BYTES, validateDesignImage } from '../../../src/webchat/design/images.js';
import { saveChatDesign } from '../../../src/webchat/design/store.js';
import { readWebChatSettings } from '../../../src/webchat/settings.js';
import {
  designImages,
  designRow,
  GREEN_PALETTE,
  seedChatDesign,
  seedChatDesignWithImages,
} from '../../helpers/chat-design.js';
import {
  importSource,
  loadFixture,
  previewAndApply,
  seedFullBusiness,
} from '../../helpers/config-transfer.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';

const now = new Date('2026-10-02T10:00:00.000Z');

const designOf = (db: Db) => withReadSnapshot(db, (tx) => readChatDesignDocument(tx));

/** Exporta la configuración de `db` como un fichero subido. */
async function exported(db: Db) {
  const { content } = await exportConfig(db, { includeAlerts: false, instanceId: 'origen-01', now });
  return { content, source: importSource(Buffer.from(content)) };
}

/** PNG válido de casi 256 KB (píxeles sin comprimir). */
function bigPng(): Buffer {
  const side = 290;
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.from(type, 'latin1');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head, data])));
    return Buffer.concat([len, head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(side, 0);
  ihdr.writeUInt32BE(side, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.alloc(side * (1 + side * 3));
  for (let i = 0; i < rows.length; i++) rows[i] = (i * 31) & 0xff;
  for (let y = 0; y < side; y++) rows[y * (1 + side * 3)] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rows, { level: 0 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

describe('diseño del chat en la exportación e importación', () => {
  let origin: TestDatabase;
  let target: TestDatabase;

  beforeAll(async () => {
    origin = await createTestDatabase();
    target = await createTestDatabase();
  });
  afterAll(async () => {
    await origin.close();
    await target.close();
  });

  it('ida y vuelta con las tres imágenes: mismo diseño y bytes idénticos (US5-1)', async () => {
    await seedFullBusiness(origin.deps);
    await seedChatDesignWithImages(
      origin.db,
      { logo: 'metadata.png', avatar: 'valid.jpg', icon: 'animated.webp' },
      { ...GREEN_PALETTE, shape: 'soft', position: 'left', size: 'large', chatName: 'Recepción' },
    );
    await seedFullBusiness(target.deps);
    await seedChatDesign(target.db, { shape: 'square', chatName: 'Otro' });

    const { source } = await exported(origin.db);
    await previewAndApply(target.db, source);

    expect(await designOf(target.db)).toEqual(await designOf(origin.db));
    const a = await designImages(origin.db);
    const b = await designImages(target.db);
    for (const slot of ['logo', 'avatar', 'icon']) {
      expect(b[slot]?.bytes.equals(a[slot]?.bytes ?? Buffer.alloc(0))).toBe(true);
      expect(b[slot]?.sha256).toBe(a[slot]?.sha256);
    }
  });

  it('reimportar el mismo fichero no muestra cambios de diseño ni escribe nada (SC-008)', async () => {
    await seedFullBusiness(origin.deps);
    await seedChatDesignWithImages(origin.db, { logo: 'metadata.png', icon: 'valid.webp' }, GREEN_PALETTE);
    const { source } = await exported(origin.db);
    const preview = await previewImport(origin.db, source, { includeAlerts: false, instanceId: 'origen-01' });
    expect(preview.sections.find((s) => s.section === 'chatDesign')).toBeUndefined();

    const rowBefore = await designRow(origin.db);
    const imagesBefore = await designImages(origin.db);
    await previewAndApply(origin.db, source);
    expect(await designRow(origin.db)).toEqual(rowBefore);
    expect(await designImages(origin.db)).toEqual(imagesBefore);
  });

  it('la importación no cambia la activación ni la configuración del chat web (FR-037)', async () => {
    await seedFullBusiness(origin.deps, { webChatEnabled: false });
    await seedChatDesign(origin.db, GREEN_PALETTE);
    await seedFullBusiness(target.deps, { webChatEnabled: true });
    const before = await readWebChatSettings(target.db);
    const { source } = await exported(origin.db);
    await previewAndApply(target.db, source);
    expect((await readWebChatSettings(target.db)).enabled).toBe(before.enabled);
    expect((await designOf(target.db))?.primaryColor).toBe(GREEN_PALETTE.primaryColor);
  });

  it('importar la configuración anterior restaura el diseño previo (FR-038)', async () => {
    await seedFullBusiness(target.deps);
    await seedChatDesignWithImages(target.db, { logo: 'valid.png' }, { shape: 'square', chatName: 'Previo' });
    const previous = await designOf(target.db);

    await seedFullBusiness(origin.deps);
    await seedChatDesign(origin.db, { ...GREEN_PALETTE, chatName: 'Nuevo' });
    await previewAndApply(target.db, (await exported(origin.db)).source);
    expect((await designOf(target.db))?.chatName).toBe('Nuevo');

    const copy = await readPreImport(target.db);
    expect(copy).not.toBeNull();
    await previewAndApply(target.db, importSource(Buffer.from(copy?.content ?? '')));
    expect(await designOf(target.db)).toEqual(previous);
  });

  it('importar chatDesign: null borra la fila y sus imágenes; un fichero v1 también', async () => {
    for (const file of ['valid-full.json', 'v1-full.json']) {
      await seedFullBusiness(target.deps);
      await seedChatDesignWithImages(target.db, { logo: 'valid.png', icon: 'valid.webp' });
      const { preview } = await previewAndApply(target.db, importSource(loadFixture(file)));
      expect(preview.sections.find((s) => s.section === 'chatDesign')?.removed).toEqual([
        { label: 'Diseño del chat (vuelve al aspecto original)' },
      ]);
      expect([file, await designRow(target.db)]).toEqual([file, undefined]);
      expect(await designImages(target.db)).toEqual({});
    }
  });

  it('con tres imágenes de 256 KB el fichero queda por debajo de 5 MB (FR-039)', async () => {
    const png = bigPng();
    expect(png.length).toBeLessThanOrEqual(MAX_IMAGE_BYTES);
    expect(png.length).toBeGreaterThan(240 * 1024);
    await seedFullBusiness(origin.deps);
    const result = validateDesignImage({ bytes: png, truncated: false });
    if (!result.ok) throw new Error(result.message);
    const image = { kind: 'replace' as const, image: result.image };
    await saveChatDesign(origin.db, ORIGINAL_DESIGN, { logo: image, avatar: image, icon: image });

    const { content, source } = await exported(origin.db);
    expect(Buffer.byteLength(content)).toBeLessThan(5 * 1024 * 1024);
    expect(source.document.chatDesign?.images.logo?.data).toBe(png.toString('base64'));
  });
});
