/**
 * Imágenes del diseño de punta a punta (011, US3, FR-029, FR-031): guardado todo o nada,
 * sustituir, quitar y conservar por hueco, y URLs que dejan de servirse.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { readChatDesign } from '../../../src/webchat/design/store.js';
import { login, type Session } from '../../helpers/app.js';
import { createTestBot, type TestBot } from '../../helpers/bot.js';
import {
  designForm,
  designImages,
  designRow,
  GREEN_FORM,
  loadImageFixture,
  postDesign,
} from '../../helpers/chat-design.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';

describe('imágenes del diseño', () => {
  let t: TestDatabase;
  let bot: TestBot | null = null;
  let app: FastifyInstance;
  let session: Session;

  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t.close();
  });
  afterEach(async () => {
    await bot?.close();
    bot = null;
  });

  async function start() {
    bot = await createTestBot(t);
    app = bot.app;
    session = await login(app);
  }

  const urls = async () => {
    const design = await readChatDesign(t.db);
    return {
      logo: design.images.logo?.url,
      avatar: design.images.avatar?.url,
      icon: design.images.icon?.url,
    };
  };

  const status = async (url: string | undefined) =>
    url ? (await app.inject({ method: 'GET', url })).statusCode : null;

  it('todo o nada: una imagen inválida deja intactas las opciones y las imágenes anteriores (US3-4)', async () => {
    await start();
    const first = await postDesign(app, session, designForm({ chat_name: 'Antes' }), [
      { name: 'logo', bytes: loadImageFixture('valid.png') },
    ]);
    expect(first.statusCode).toBe(303);
    const rowBefore = await designRow(t.db);
    const imagesBefore = await designImages(t.db);

    const res = await postDesign(app, session, designForm({ ...GREEN_FORM, chat_name: 'Después' }), [
      { name: 'logo', bytes: loadImageFixture('valid.jpg'), type: 'image/jpeg' },
      { name: 'avatar', bytes: loadImageFixture('valid.webp'), type: 'image/webp' },
      { name: 'icon', bytes: loadImageFixture('html-renamed.png') },
    ]);
    expect(res.statusCode).toBe(422);
    expect(await designRow(t.db)).toEqual(rowBefore);
    expect(await designImages(t.db)).toEqual(imagesBefore);
  });

  it('sustituir, quitar y conservar en el mismo guardado (FR-029)', async () => {
    await start();
    await postDesign(app, session, designForm(), [
      { name: 'logo', bytes: loadImageFixture('valid.png') },
      { name: 'avatar', bytes: loadImageFixture('valid.jpg'), type: 'image/jpeg' },
      { name: 'icon', bytes: loadImageFixture('valid.webp'), type: 'image/webp' },
    ]);
    const before = await urls();
    const kept = (await designImages(t.db)).icon;

    const res = await postDesign(
      app,
      session,
      designForm({ avatar_remove: '1' }),
      [{ name: 'logo', bytes: loadImageFixture('animated.png') }],
    );
    expect(res.statusCode).toBe(303);
    const after = await urls();
    const images = await designImages(t.db);
    // Logo sustituido, avatar quitado, icono conservado tal cual.
    expect(after.logo).toBeDefined();
    expect(after.logo).not.toBe(before.logo);
    expect(after.avatar).toBeUndefined();
    expect(images.icon?.sha256).toBe(kept?.sha256);
    expect(after.icon).toBe(before.icon);

    // Tras sustituir, la URL antigua da 404 y la nueva 200 (US3-5); la quitada, 404.
    expect(await status(before.logo)).toBe(404);
    expect(await status(after.logo)).toBe(200);
    expect(await status(before.avatar)).toBe(404);
    expect(await status(after.icon)).toBe(200);
  });

  it('los bytes guardados no llevan metadatos', async () => {
    await start();
    await postDesign(app, session, designForm(), [
      { name: 'logo', bytes: loadImageFixture('metadata.png') },
      { name: 'avatar', bytes: loadImageFixture('metadata.jpg'), type: 'image/jpeg' },
      { name: 'icon', bytes: loadImageFixture('metadata.webp'), type: 'image/webp' },
    ]);
    const images = await designImages(t.db);
    for (const marker of ['tEXt', 'iTXt', 'eXIf', 'tIME', 'Exif', 'Photoshop', 'Comentario', 'EXIF', 'XMP ']) {
      for (const slot of ['logo', 'avatar', 'icon']) {
        expect([slot, marker, images[slot]?.bytes.includes(Buffer.from(marker, 'latin1'))]).toEqual([
          slot,
          marker,
          false,
        ]);
      }
    }
  });
});
